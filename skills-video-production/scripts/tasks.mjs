import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { browserModes, isId, isText, prepare, projectFile, requireValue, writeJson } from "./project.mjs";

const active = new Set(["prepared", "submitting", "submitted"]);
const failureCodes = ["quota", "video_entry_missing", "refused", "binding_unavailable", "provider_failed", "cancelled"];
const noSubmission = new Set(["cancelled", "binding_unavailable"]);
const quotaFailures = new Set(["quota", "video_entry_missing"]);
const productionModes = ["bridge", ...browserModes];
const editModes = ["production", ...productionModes, "preview"];

function matchesEditMode(mode, taskMode) {
  return mode === "production" ? productionModes.includes(taskMode) : mode === taskMode;
}

function narrationOnly(shot, audioMode) {
  return audioMode === "post" && shot.dialogue.some((line) => line.kind === "narration") &&
    !shot.dialogue.some((line) => line.kind === "dialogue");
}

function now() {
  return new Date().toISOString();
}

function save(model) {
  writeJson(model.tasksPath, model.tasks);
}

export function taskFor(model, id) {
  const task = model.tasks.attempts.find((attempt) => attempt.id === id);
  requireValue(task, `没有任务 ${id}`);
  return task;
}

export function planTask(model, shotId, mode) {
  requireValue(!model.tasks.pause, "本批次因额度或视频入口暂停");
  requireValue(!model.tasks.attempts.some((task) => active.has(task.status)), "有尚未结束的任务，请先回查原任务");
  const packet = prepare(model, shotId, mode);
  const previous = model.tasks.attempts.filter((task) => task.shotId === shotId && task.shotVersion === packet.shotVersion);
  requireValue(!previous.some((task) => quotaFailures.has(task.error?.code)), "此镜头版本曾遇额度或视频入口错误，请勿换路径重提");
  requireValue(!previous.some((task) => task.mode === mode && !noSubmission.has(task.error?.code)),
  "当前镜头版本已有同模式任务，请回查原任务；确有内容修订时建立新版本");
  return packet;
}

export function recordPreparedTask(model, packet) {
  const task = { id: randomUUID(), ...packet, status: "prepared", createdAt: now() };
  model.tasks.attempts.push(task);
  save(model);
  return task;
}

export function begin(model, shotId, mode) {
  return recordPreparedTask(model, planTask(model, shotId, mode));
}

export function checkInputs(model, task) {
  const current = prepare(model, task.shotId, task.mode);
  requireValue(current.shotVersion === task.shotVersion && current.prompt === task.prompt &&
    JSON.stringify(current.inputs) === JSON.stringify(task.inputs) &&
    JSON.stringify(current.designRefs) === JSON.stringify(task.designRefs ?? []), "任务创建后输入已变更，请核对镜头版本");
  return current;
}

export function markSubmitting(model, task, binding) {
  requireValue(task.status === "prepared", "任务已离开 prepared，请先回查原任务");
  checkInputs(model, task);
  if (browserModes.includes(task.mode)) {
    const bindingKinds = task.mode === "dual" ? ["dedicated_fields", "explicit_source_roles"] : ["first_frame", "dedicated_fields"];
    requireValue(bindingKinds.includes(binding?.kind) &&
      isText(binding.evidence) && isText(binding.submittedPrompt) &&
      Array.isArray(binding.assignments) && binding.assignments.length === task.inputs.length,
    "提交前需要实际页面的绑定方式、依据、输入映射和完整提交原文");
    requireValue(binding.submittedPrompt.includes(task.prompt), "提交原文必须包含此版本的完整逐镜提示词");
    const slots = new Set();
    for (const [index, input] of task.inputs.entries()) {
      const assigned = binding.assignments[index];
      requireValue(assigned?.role === input.role && assigned.asset === input.asset &&
        isText(assigned.slot) && !slots.has(assigned.slot), `绑定未匹配 ${input.role} / ${input.asset}`);
      slots.add(assigned.slot);
    }
    task.binding = binding;
  }
  task.status = "submitting";
  task.submittingAt = now();
  save(model);
  return task;
}

function conversationUrl(value) {
  const url = new URL(value);
  requireValue(url.origin === "https://gemini.google.com" &&
    /^\/(?:u\/\d+\/)?app\/[0-9a-f]{8,}\/?$/i.test(url.pathname), "需要真实的 Gemini 会话 URL");
  return url.origin + url.pathname;
}

export function markSubmitted(model, task, receipt) {
  requireValue(task.status === "submitting", "提交回执只适用于 submitting 状态");
  if (browserModes.includes(task.mode)) {
    task.provider = { conversationUrl: conversationUrl(receipt?.conversationUrl) };
  } else {
    requireValue(isId(receipt?.bridgeTaskId), "需要桥返回的任务 ID");
    task.provider = { bridgeTaskId: receipt.bridgeTaskId };
  }
  task.status = "submitted";
  task.submittedAt = now();
  save(model);
  return task;
}

export function fail(model, task, code, detail) {
  requireValue(active.has(task.status) && failureCodes.includes(code) && isText(detail), "无效的失败记录");
  requireValue(!noSubmission.has(code) || task.status === "prepared", "只有尚未进入提交阶段的任务可记为未提交");
  task.status = "failed";
  task.error = { code, detail, at: now() };
  if (quotaFailures.has(code)) model.tasks.pause = { taskId: task.id, code, detail, at: now() };
  save(model);
  return task;
}

export function resume(model, reason) {
  requireValue(model.tasks.pause && isText(reason), "请提供解除暂停的人工决定依据");
  model.tasks.lastResume = { ...model.tasks.pause, reason, resumedAt: now() };
  model.tasks.pause = null;
  save(model);
  return model.tasks.lastResume;
}

function inspectMedia(file) {
  const fields = "format=duration,format_name:stream=codec_type,width,height";
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", fields, "-of", "json", file], { encoding: "utf8", timeout: 20000 });
  if (probe.status === 0) {
    const data = JSON.parse(probe.stdout);
    const picture = data.streams.find((stream) => stream.codec_type === "video");
    requireValue(data.format.format_name.split(",").includes("mp4") && picture, "源文件需为可解析的 MP4 视频");
    return { duration: Number(data.format.duration), width: picture.width, height: picture.height,
      audioTracks: data.streams.filter((stream) => stream.codec_type === "audio").length };
  }
  if (process.platform === "darwin") {
    const helper = fileURLToPath(new URL("./probe.swift", import.meta.url));
    const fallback = spawnSync("swift", [helper, file], { encoding: "utf8", timeout: 30000 });
    if (fallback.status === 0) return JSON.parse(fallback.stdout);
  }
  throw new Error("无法探测源片。请检查 MP4 文件及 ffprobe（macOS 可使用 Swift / AVFoundation）");
}

export function attachMedia(model, task, relativePath, receipt) {
  let recovery;
  if (receipt) {
    requireValue(task.status === "failed" && task.provider?.bridgeTaskId && task.error?.code === "provider_failed" &&
      /下载失败 HTTP \d+/.test(task.error.detail) && isText(receipt.evidence), "只接受原桥接任务的已确认下载故障恢复");
    recovery = { conversationUrl: conversationUrl(receipt.conversationUrl), evidence: receipt.evidence,
      originalError: task.error, recoveredAt: now() };
  } else {
    requireValue(task.status === "submitted", "先登记实际提交回执");
  }
  const file = projectFile(model.root, relativePath);
  requireValue(path.extname(file).toLowerCase() === ".mp4", "源视频需要 .mp4 扩展名");
  const media = inspectMedia(file);
  requireValue(media.duration > 0 && media.width > 0 && media.height > 0, "媒体缺少有效画面或时长");
  const [width, height] = task.aspect.split(":").map(Number);
  const aspectMatch = Math.abs((media.width / media.height) / (width / height) - 1) < 0.02;
  task.media = { path: relativePath, ...media, aspectMatch, bytes: fs.statSync(file).size, verifiedAt: now() };
  if (recovery) {
    task.downloadRecovery = recovery;
    delete task.error;
  }
  task.status = "media_verified";
  save(model);
  return task;
}

export function review(model, task, receipt) {
  requireValue(task.status === "media_verified", "先校验实际源片");
  requireValue(["passed", "failed", "pending"].includes(receipt?.picture) &&
    ["passed", "failed", "pending", "not_required"].includes(receipt?.sound) && isText(receipt.notes),
  "检查记录须包含独立的画面、声音及证据说明");
  if (receipt.picture === "passed") {
    requireValue(Number.isFinite(receipt.sourceIn) && Number.isFinite(receipt.sourceOut) &&
      receipt.sourceIn >= 0 && receipt.sourceOut > receipt.sourceIn && receipt.sourceOut <= task.media.duration + 0.001,
    "通过画面检查时须标出有效的源片选段");
    requireValue(Array.isArray(receipt.evidenceFrames) && new Set(receipt.evidenceFrames).size >= 3,
      "画面通过须提供至少三张实际抽帧路径，覆盖首、中、末并补查内切点");
    for (const frame of receipt.evidenceFrames) projectFile(model.root, frame);
    const shot = model.shots.get(task.shotId);
    requireValue(shot.version === task.shotVersion, "只能验收当前分镜版本；旧版可以登记缺陷");
    requireValue(!narrationOnly(shot, task.audioMode) || receipt.visibleSpeech === "absent",
      "纯后配旁白镜头须确认采用区间没有人物可见说话口型");
  }
  requireValue(receipt.sound !== "not_required" || task.audioMode !== "native", "保留同期声的镜头需要实际听验");
  requireValue(receipt.sound !== "passed" || task.media.audioTracks > 0, "源片无音轨，不能记为原声听验通过");
  requireValue(receipt.sound !== "passed" || isText(receipt.listeningNotes),
    "声音通过须记录实际试听范围与听感，音轨和 ASR 不可替代");
  task.review = { ...receipt, at: now() };
  save(model);
  return task;
}

export function editPlan(model, mode = "production") {
  requireValue(editModes.includes(mode), "剪辑计划模式无效");
  const { fps, audioMode, subtitles, stylizedText } = model.project;
  let cursor = 0;
  const items = [];
  for (const shot of model.shots.values()) {
    const shotAudioMode = shot.audioMode ?? audioMode;
    const candidates = model.tasks.attempts.filter((attempt) => matchesEditMode(mode, attempt.mode) &&
      attempt.shotId === shot.id && attempt.shotVersion === shot.version);
    const task = candidates.findLast((attempt) =>
      attempt.review?.picture === "passed" && (shotAudioMode !== "native" || attempt.review.sound === "passed"));
    const accepted = Boolean(task);
    const expectedFrames = Math.max(1, Math.round(shot.editSeconds * fps));
    const pickedFrames = accepted ? Math.floor((task.review.sourceOut - task.review.sourceIn) * fps + 0.000001) : 0;
    const canPlace = accepted && pickedFrames >= expectedFrames;
    const item = { shotId: shot.id, sceneId: shot.sceneId, fromFrame: cursor, durationInFrames: expectedFrames,
      transitionIn: shot.transitionIn ?? null, dialogue: shot.dialogue, sfx: shot.sfx,
      graphics: stylizedText ? (shot.graphics ?? []).map((cue) => {
        const start = Math.min(expectedFrames - 1, Math.floor(cue.start * fps));
        const end = Math.min(expectedFrames, Math.ceil(cue.end * fps));
        return { ...cue, fromFrame: cursor + start, durationInFrames: end - start };
      }) : [] };
    if (canPlace) {
      projectFile(model.root, task.media.path);
      item.source = { path: task.media.path, sourceStartFromInSeconds: task.review.sourceIn,
        muteSource: shotAudioMode !== "native", attemptId: task.id, mode: task.mode, aspectMatch: task.media.aspectMatch };
    } else item.pending = accepted ? "选段短于计划" : "缺少符合本模式的验收源片";
    items.push(item);
    cursor += expectedFrames;
  }
  return { mode, aspect: model.project.aspect, fps, audioMode, subtitles, stylizedText, durationInFrames: cursor,
    missing: items.filter((item) => item.pending).map((item) => item.shotId), items };
}

export function recordEdit(model, receipt) {
  requireValue(isText(receipt?.projectId) && isText(receipt.timelineId) && isId(receipt.version) &&
    editModes.includes(receipt.mode) && Array.isArray(receipt.placements), "ChatCut 回执须包含项目、时间线、版本、模式和放置记录");
  const stage = receipt.stage ?? "draft";
  requireValue(["draft", "verified"].includes(stage), "剪辑回执阶段须为 draft 或 verified");
  const seen = new Set();
  for (const entry of receipt.placements) {
    const task = taskFor(model, entry?.attemptId);
    requireValue(matchesEditMode(receipt.mode, task.mode) && task.shotId === entry.shotId &&
      task.status === "media_verified" && isText(entry.assetId) && isText(entry.itemId) &&
      Number.isInteger(entry.fromFrame) && entry.fromFrame >= 0 &&
      Number.isInteger(entry.durationInFrames) && entry.durationInFrames > 0 && !seen.has(entry.shotId), "无效的 ChatCut 放置记录");
    seen.add(entry.shotId);
    if (stage === "verified") {
      const shot = model.shots.get(entry.shotId);
      const sourceIn = entry.sourceStartFromInSeconds;
      requireValue(shot?.version === task.shotVersion && task.review?.picture === "passed" &&
        task.review.evidenceFrames?.length >= 3 &&
        (task.audioMode !== "native" || (task.review.sound === "passed" && isText(task.review.listeningNotes))) &&
        (!narrationOnly(shot, task.audioMode) || task.review.visibleSpeech === "absent") &&
        Number.isFinite(sourceIn) && sourceIn >= task.review.sourceIn - 0.001 &&
        sourceIn + entry.durationInFrames / model.project.fps <= task.review.sourceOut + 0.001,
      `${entry.shotId} 缺少验收或超出采用区间，只能登记为草稿`);
    }
  }
  if (stage === "verified") {
    requireValue(receipt.mode !== "preview" && seen.size === model.shots.size &&
      isText(receipt.verification?.picture) &&
      (model.project.audioMode === "silent" && [...model.shots.values()].every((shot) => !shot.audioMode || shot.audioMode === "silent") ||
       isText(receipt.verification?.listeningNotes)),
    "剪辑验收须覆盖全部镜头，并登记合成画面与所需实际试听");
  }
  model.tasks.edits ??= [];
  requireValue(!model.tasks.edits.some((entry) => entry.version === receipt.version), "剪辑版本已存在，请保存为新版本");
  const record = { ...receipt, stage, recordedAt: now() };
  model.tasks.edits.push(record);
  model.tasks.edit = record;
  save(model);
  return record;
}
