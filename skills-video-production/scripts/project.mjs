import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const assetDirectories = new Map([
  ["character", "assets/characters"], ["scene", "assets/scenes"], ["prop", "assets/props"],
  ["startFrame", "assets/frames/inputs"], ["endFrame", "assets/frames/inputs"],
  ["style", "assets/styles"], ["voice", "assets/voices"], ["video", "assets/videos"], ["audio", "assets/audio"],
]);
const outputDirectories = [
  "scripts", ...new Set(assetDirectories.values()), "assets/frames/review", "assets/frames/cuts",
  "assets/prompts", "assets/edits", "exports",
];
const audioModes = ["silent", "native", "post"];
const columns = ["镜号", "时长", "画面描述", "景别", "光影氛围", "对白·旁白", "音效", "运镜", "最终提示词", "操作"];
export const browserModes = ["browser", "dual"];
export const bridgeModes = ["bridge", "preview"];

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function isText(value) {
  return typeof value === "string" && Boolean(value.trim());
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isId(value) {
  return typeof value === "string" && idPattern.test(value);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

export function resolveProjectRoot(directory) {
  const requested = path.resolve(directory);
  let parent = requested;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const root = path.join(fs.realpathSync(parent), path.relative(parent, requested));
  requireValue(root !== path.parse(root).root, "请选择作品目录");
  for (let directory = root; ; directory = path.dirname(directory)) {
    const has = (name) => fs.existsSync(path.join(directory, name));
    requireValue(!(has("plugin.json") && has("skills")) && !(has("bridge.mjs") && has("cli.mjs") && has("SKILL.md")),
      "请选择用户的作品目录，插件安装目录和 Gemini 桥目录用于运行工具");
    if (directory === path.dirname(directory)) break;
  }
  return root;
}

export function projectOutput(root, rel) {
  requireValue(isText(rel) && !path.isAbsolute(rel), "使用项目内相对路径");
  const full = path.resolve(root, rel);
  const difference = path.relative(root, full);
  requireValue(difference && !path.isAbsolute(difference) && difference !== ".." &&
    !difference.startsWith(`..${path.sep}`), `路径必须位于项目内：${rel}`);
  for (let entry = full; entry !== root; entry = path.dirname(entry)) {
    requireValue(!fs.lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink(),
      `项目写入路径不能包含符号链接：${rel}`);
  }
  return full;
}

export function layout(root) {
  const directories = Object.fromEntries(outputDirectories.map((dir) => [dir, projectOutput(root, dir)]));
  for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
  return { project: root, directories };
}

export function init(root, title) {
  requireValue(isText(title), "请提供项目标题");
  const files = {
    "project.json": { schemaVersion: 1, title, aspect: "16:9", fps: 30, style: "", audioMode: null, subtitles: false, stylizedText: false, requireDesignRefs: true },
    "storyboard.json": { scenes: [], shots: [] },
    "assets/registry.json": { assets: [] },
    "tasks.json": { pause: null, attempts: [], edit: null },
    "scripts/剧本.md": `# ${title.replace(/[\r\n]+/g, " ")}\n\n按场写地点、时间、人物目的、动作、对白和结果。\n`,
  };
  for (const name of Object.keys(files)) {
    requireValue(!fs.existsSync(projectOutput(root, name)), `已存在 ${name}，请使用新目录或继续现有项目`);
  }
  const result = layout(root);
  for (const [name, value] of Object.entries(files)) {
    const file = projectOutput(root, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  }
  return result;
}

function uniqueBy(list, key, label) {
  requireValue(Array.isArray(list), `${label} 必须是数组`);
  const map = new Map();
  for (const value of list) {
    requireValue(isObject(value), `${label} 中有无效记录`);
    const id = key(value);
    requireValue(id && !map.has(id), `${label} 有重复或无效 ID：${id ?? ""}`);
    map.set(id, value);
  }
  return map;
}

function assetKey(asset) {
  return isId(asset?.id) && isId(asset?.version) ? `${asset.id}@${asset.version}` : null;
}

function positive(value) {
  return Number.isFinite(value) && value > 0;
}

export function load(root) {
  const project = readJson(projectOutput(root, "project.json"));
  const storyboard = readJson(projectOutput(root, "storyboard.json"));
  const registryPath = projectOutput(root, "assets/registry.json");
  const registry = readJson(registryPath);
  const tasksPath = projectOutput(root, "tasks.json");
  const tasks = readJson(tasksPath);
  requireValue(project.schemaVersion === 1 && isText(project.title), "project.json 版本或标题无效");
  requireValue(["16:9", "9:16", "1:1"].includes(project.aspect) && Number.isInteger(project.fps) && positive(project.fps), "项目画幅或帧率无效");
  requireValue(typeof project.style === "string" && (project.audioMode === null || audioModes.includes(project.audioMode)), "项目风格或声音模式无效");
  requireValue(typeof project.subtitles === "boolean" && typeof project.stylizedText === "boolean", "字幕与花字开关须为布尔值");
  requireValue(project.requireDesignRefs == null || typeof project.requireDesignRefs === "boolean", "requireDesignRefs 须为布尔值");
  requireValue(project.bridgeAccountCount == null || (Number.isInteger(project.bridgeAccountCount) && positive(project.bridgeAccountCount)),
    "bridgeAccountCount 须为正整数");
  requireValue(Array.isArray(tasks.attempts) && (tasks.pause === null || isObject(tasks.pause)), "tasks.json 结构无效");
  const assets = uniqueBy(registry.assets, assetKey, "素材");
  for (const [key, asset] of assets) {
    requireValue(assetDirectories.has(asset.type) && isText(asset.path) && !path.isAbsolute(asset.path) &&
      path.resolve(root, asset.path).startsWith(root + path.sep), `${key} 的素材类型或项目相对路径无效`);
    requireValue(["pending_review", "approved", "rejected"].includes(asset.status), `${key} 的审核状态无效`);
  }

  const scenes = uniqueBy(storyboard.scenes, (scene) => isId(scene.id) && scene.id, "场次");
  const shots = uniqueBy(storyboard.shots, (shot) => isId(shot.id) && shot.id, "镜头");
  for (const [id, scene] of scenes) {
    requireValue(isText(scene.title) && isText(scene.beat), `${id} 缺场次标题或叙事变化`);
  }
  const preceding = new Set();
  let previousShotId;
  for (const [id, shot] of shots) {
    requireValue(isId(shot.version) && scenes.has(shot.sceneId), `${id} 缺版本或引用了无效场次`);
    requireValue(positive(shot.editSeconds) && (shot.requestSeconds == null || positive(shot.requestSeconds)), `${id} 时长无效`);
    requireValue(shot.audioMode == null || audioModes.includes(shot.audioMode), `${id} 声音模式无效`);
    requireValue(shot.continuityFrom == null ||
      (shot.continuityFrom === previousShotId && shot.transitionIn == null),
    `${id} 仅可在无转场时承接紧邻上一镜`);
    for (const field of ["description", "framing", "lighting", "camera", "startState", "endState", "stillPrompt", "motionPrompt"]) {
      requireValue(isText(shot[field]), `${id} 缺 ${field}`);
    }
    requireValue(Array.isArray(shot.dialogue) && shot.dialogue.every((line) => isObject(line) &&
      ["dialogue", "narration"].includes(line.kind) && isText(line.speaker) && isText(line.text)), `${id} 对白或旁白格式无效`);
    for (const line of shot.dialogue) {
      requireValue(line.voiceRef == null || assets.get(line.voiceRef)?.type === "voice", `${id} 引用了无效音色 ${line.voiceRef}`);
    }
    requireValue(Array.isArray(shot.sfx) && shot.sfx.every(isText), `${id} 音效须为字符串数组`);
    requireValue(shot.transitionIn == null || (isText(shot.transitionIn.type) && isText(shot.transitionIn.reason)), `${id} 转场缺方式或叙事理由`);
    const bridge = shot.transitionIn?.soundBridge;
    requireValue(bridge == null || (["lead", "carry"].includes(bridge.direction) &&
      isText(bridge.cue) && positive(bridge.seconds)), `${id} 声音转场须写明先入或延续、声音内容和时长`);
    requireValue(Array.isArray(shot.graphics ?? []) && (shot.graphics ?? []).every((cue) =>
      isText(cue.text) && isText(cue.reason) && Number.isFinite(cue.start) && positive(cue.end) &&
      cue.start >= 0 && cue.start < cue.end && cue.end <= shot.editSeconds), `${id} 花字须有文案、叙事理由及镜内有效时间`);
    requireValue(Array.isArray(shot.dependsOn ?? []) && (shot.dependsOn ?? []).every((dep) => preceding.has(dep)), `${id} 只能依赖前面的镜头`);
    requireValue(Array.isArray(shot.references) && new Set(shot.references).size === shot.references.length, `${id} 参考图列表无效或有重复`);
    for (const key of shot.references) {
      requireValue(["character", "scene", "prop", "style"].includes(assets.get(key)?.type), `${id} 引用了无效视觉参考 ${key}`);
    }
    const designRefs = shot.designRefs ?? [];
    requireValue(Array.isArray(designRefs) && new Set(designRefs).size === designRefs.length, `${id} 的设定图引用无效或有重复`);
    for (const key of designRefs) {
      requireValue(["character", "scene", "prop", "style"].includes(assets.get(key)?.type), `${id} 引用了无效设定图 ${key}`);
    }
    for (const type of ["startFrame", "endFrame"]) {
      if (shot[type] != null) requireValue(assets.get(shot[type])?.type === type, `${id} 引用了无效 ${type}`);
    }
    preceding.add(id);
    previousShotId = id;
  }
  return { root, project, assets, registry, registryPath, scenes, shots, tasks, tasksPath };
}

export function importAsset(model, type, id, version, source) {
  requireValue(assetDirectories.has(type) && isId(id) && isId(version) && isText(source),
    "请提供有效的素材类型、ID、版本和源文件");
  const key = `${id}@${version}`;
  requireValue(!model.assets.has(key), `素材 ${key} 已登记，请使用新版本`);
  const extension = path.extname(source).toLowerCase();
  requireValue(/^\.[a-z0-9]{1,12}$/.test(extension), "源文件需要有效扩展名");
  const input = fs.realpathSync(source);
  const stat = fs.statSync(input);
  requireValue(stat.isFile() && stat.size > 0, "源文件必须是非空文件");
  const relative = `${assetDirectories.get(type)}/${id}_${version}${extension}`;
  const destination = projectOutput(model.root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const copied = input !== path.join(fs.realpathSync(model.root), relative);
  if (copied) fs.copyFileSync(input, destination, fs.constants.COPYFILE_EXCL);
  const asset = { id, version, type, path: relative, status: "pending_review" };
  try {
    writeJson(model.registryPath, { ...model.registry, assets: [...model.registry.assets, asset] });
  } catch (error) {
    if (copied) fs.unlinkSync(destination);
    throw error;
  }
  return { key, asset, file: destination };
}

export function projectFile(root, rel) {
  requireValue(isText(rel) && !path.isAbsolute(rel), "使用项目内相对文件路径");
  const file = fs.realpathSync(path.resolve(root, rel));
  const difference = path.relative(fs.realpathSync(root), file);
  requireValue(difference && !path.isAbsolute(difference) && difference !== ".." &&
    !difference.startsWith(`..${path.sep}`) && fs.statSync(file).isFile() && fs.statSync(file).size > 0, `无效的项目文件：${rel}`);
  return file;
}

function imageInput(model, ref, role) {
  const asset = model.assets.get(ref);
  requireValue(asset && asset.status !== "rejected", `缺少可用的 ${role} 素材：${ref ?? "未绑定"}`);
  const file = projectFile(model.root, asset.path);
  const bytes = fs.readFileSync(file);
  const mime = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ? "image/png"
    : bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) ? "image/jpeg"
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : null;
  requireValue(mime, `${asset.path} 不是受支持的 PNG、JPEG 或 WebP 文件`);
  return { role, asset: ref, path: asset.path, mime, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function dialogueLine(line) {
  const speaker = line.kind === "narration" ? `旁白（${line.speaker}）` : line.speaker;
  return `${speaker}：${line.text}${line.delivery ? `（${line.delivery}）` : ""}`;
}

function promptParts(model, shot) {
  const dialogue = shot.dialogue.map(dialogueLine).join("\n");
  const audioMode = shot.audioMode ?? model.project.audioMode;
  const spoken = shot.dialogue.map((line) => line.text).filter(Boolean);
  const audio = audioMode === "native"
    ? [
        spoken.length
          ? `只念下面这句台词，念完立刻停下保持安静。不要添加任何其他内容，不要念下面任何制作说明。\n台词：「${spoken.join(" / ")}」`
          : "无对白。",
        shot.sfx.length ? `音效：${shot.sfx.join("、")}` : "",
      ].filter(Boolean).join("\n")
    : audioMode === "silent" ? "输出无声画面。"
      : audioMode === "post" ? "对白与音效由后期独立处理，按动作安排保留表演，源声音不用于最终混音。" : "声音模式待定。";
  return {
    still: `${shot.stillPrompt}\n首帧状态：${shot.startState}\n尾部目标：${shot.endState}`,
    motion: `${shot.motionPrompt}\n${audio}\n字幕与花字在后期制作，画面不生成文字。`,
  };
}

export function prepare(model, id, mode = "bridge") {
  const shot = model.shots.get(id);
  requireValue(shot && [...bridgeModes, ...browserModes].includes(mode), "请提供有效镜号及模式 bridge、browser、dual 或 preview");
  const audioMode = shot.audioMode ?? model.project.audioMode;
  requireValue(audioMode !== null && isText(model.project.style), "提交前先确定项目风格与声音模式");
  requireValue(!model.project.requireDesignRefs || shot.designRefs?.length, `${id} 请先保存并登记本镜人物、场景或道具设定图`);
  const designRefs = (shot.designRefs ?? []).map((ref) => imageInput(model, ref, model.assets.get(ref).type));
  if (shot.continuityFrom) {
    const edit = model.tasks.edit;
    const cut = model.assets.get(shot.startFrame)?.cutFrame;
    const placement = edit?.placements?.find((entry) => entry.shotId === shot.continuityFrom);
    const source = model.tasks.attempts.find((task) => task.id === placement?.attemptId);
    requireValue(cut && placement && source?.status === "media_verified" &&
      source.shotVersion === model.shots.get(shot.continuityFrom).version &&
      cut.timelineId === edit.timelineId && cut.itemId === placement.itemId &&
      cut.attemptId === placement.attemptId && cut.fromFrame === placement.fromFrame &&
      cut.timelineFrame === placement.fromFrame + placement.durationInFrames - 1 &&
      Number.isFinite(placement.sourceStartFromInSeconds) &&
      cut.sourceStartFromInSeconds === placement.sourceStartFromInSeconds,
    `${id} 请先在 ChatCut 定剪 ${shot.continuityFrom}，登记放置记录并用实际剪切末帧作为首帧`);
  }
  const inputs = [imageInput(model, shot.startFrame, "first")];
  if (mode === "dual") {
    inputs.push(imageInput(model, shot.endFrame, "last"));
    requireValue(inputs[0].path !== inputs[1].path, "首尾帧必须分别绑定两个文件");
    inputs.push(...shot.references.map((ref) => imageInput(model, ref, model.assets.get(ref).type)));
  }
  for (const dep of shot.dependsOn ?? []) {
    const latest = model.tasks.attempts.findLast((attempt) => attempt.shotId === dep && attempt.shotVersion === model.shots.get(dep).version);
    requireValue(latest?.status === "media_verified" && latest.review?.picture === "passed", `前置镜头 ${dep} 尚未通过画面检查`);
    projectFile(model.root, latest.media.path);
  }
  const parts = promptParts(model, shot);
  const prompt = [
    `画幅 ${model.project.aspect}${shot.requestSeconds ? `，期望源片时长 ${shot.requestSeconds} 秒` : ""}。\n视觉风格：${model.project.style}`,
    `第一部分｜分镜提示词\n${parts.still}`,
    `第二部分｜视频运动提示词\n${parts.motion}`,
  ].join("\n\n");
  return { shotId: id, shotVersion: shot.version, sceneId: shot.sceneId, mode,
    aspect: model.project.aspect, audioMode, designRefs, inputs, prompt };
}

function cell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, "<br>");
}

export function render(model) {
  const row = (values) => `| ${values.map(cell).join(" | ")} |`;
  const table = [`# ${model.project.title} · 分镜总表`, "", row(columns), row(columns.map(() => "---"))];
  const cards = [`# ${model.project.title} · 逐镜执行卡`, ""];
  for (const shot of model.shots.values()) {
    const anchor = shot.id.toLowerCase();
    const attempt = model.tasks.attempts.findLast((item) => item.shotId === shot.id && item.shotVersion === shot.version);
    const dialogue = shot.dialogue.map(dialogueLine).join(" / ") || "无";
    const parts = promptParts(model, shot);
    const status = attempt ? `${attempt.status}（${attempt.mode}）` : "待准备";
    table.push(row([shot.id, `剪入 ${shot.editSeconds}s / 源 ${shot.requestSeconds ?? "待定"}`, shot.description,
      shot.framing, shot.lighting, dialogue, shot.sfx.join(" / ") || "无", shot.camera,
      `[两部分提示词](./逐镜执行卡.md#${anchor})`, `${status} · [执行卡](./逐镜执行卡.md#${anchor})`]));
    const refs = [shot.startFrame, shot.endFrame, ...shot.references].filter(Boolean)
      .map((key) => `- ${key} · ${model.assets.get(key).path}`).join("\n");
    const design = (shot.designRefs ?? []).map((key) => `- ${key} · ${model.assets.get(key).path}`).join("\n");
    const graphics = (shot.graphics ?? []).map((cue) => `- ${cue.start}–${cue.end}s · ${cue.text} · ${cue.reason}`).join("\n");
    const bridge = shot.transitionIn?.soundBridge;
    cards.push(`<a id="${anchor}"></a>\n\n## ${shot.id} · ${shot.version}\n`,
      `场次 ${shot.sceneId} · ${model.scenes.get(shot.sceneId).title}\n\n${model.scenes.get(shot.sceneId).beat}\n`,
      `- 画面：${shot.description}\n- 景别：${shot.framing}\n- 光影：${shot.lighting}\n- 运镜：${shot.camera}\n- 对白与旁白：${dialogue}\n- 音效：${shot.sfx.join(" / ") || "无"}\n- 转场：${shot.transitionIn ? `${shot.transitionIn.type} · ${shot.transitionIn.reason}` : "无"}\n- 声音转场：${bridge ? `${bridge.direction === "lead" ? "先入" : "延续"} ${bridge.seconds}s · ${bridge.cue}` : "无"}\n- 前置镜头：${(shot.dependsOn ?? []).join("、") || "无"}\n`,
      `### 素材与连续性\n\n设定图\n\n${design || "待登记"}\n\n生成输入\n\n${refs || "待绑定"}\n\n首帧状态：${shot.startState}\n\n尾帧状态：${shot.endState}\n`,
      `### 分镜提示词\n\n${parts.still}\n\n### 视频运动提示词\n\n${parts.motion}\n`,
      `### 花字与字幕\n\n字幕：${model.project.subtitles ? "以最终声轨校对" : "关闭"}。\n\n${model.project.stylizedText && graphics ? graphics : "本镜无启用的花字。"}\n`,
      `### 执行记录\n\n${status}${attempt ? ` · ${attempt.id}` : ""}\n${attempt?.media ? `\n源片：${attempt.media.path} · ${attempt.media.duration}s · ${attempt.media.width}×${attempt.media.height}\n` : ""}`,
    );
  }
  const total = [...model.shots.values()].reduce((sum, shot) => sum + shot.editSeconds, 0);
  table.push("", `计划剪入合计 ${Number(total.toFixed(3))} 秒。`);
  writeAtomic(projectOutput(model.root, "scripts/分镜总表.md"), table.join("\n") + "\n");
  writeAtomic(projectOutput(model.root, "scripts/逐镜执行卡.md"), cards.join("\n") + "\n");
  return { shots: model.shots.size, plannedSeconds: Number(total.toFixed(3)) };
}
