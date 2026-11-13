/**
 * dsh-gemini-studio —— 把本机的 Gemini 网页版桥接进 Harness。
 *
 * 分工：
 *   Host 插件（本文件）负责工具注册、桥进程生命周期、把成片落到会话工作区。
 *   真正的浏览器操作在 tools/gemini-bridge/bridge.mjs 里，通过 127.0.0.1:8787 通信。
 *
 * 账号、登录态、额度冷却都在 ~/.gemini-video-bridge/，和 Codex 侧那套共用。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "dsh-gemini-studio";
export const inject = ["tools"];

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  bridgePort: 8787,
  // 不配就用包内自带的 bridge/，开箱即用
  bridgeDir: "",
  autoStart: true,
  pollMs: 5000,
  taskTimeoutMs: 12 * 60 * 1000,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (!cfg.bridgeDir) cfg.bridgeDir = path.join(PLUGIN_DIR, "bridge");
  const base = `http://127.0.0.1:${cfg.bridgePort}`;
  let starting = null;

  async function request(route, options = {}) {
    const res = await fetch(base + route, {
      ...options,
      signal: AbortSignal.timeout(options.timeoutMs || 30000),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new Error(data.error || `桥返回 HTTP ${res.status}`);
    return data;
  }

  async function healthy() {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1200) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function ensureBridge() {
    if (await healthy()) return;
    if (!cfg.autoStart) throw new Error(`桥没在跑，且插件配置里关掉了 autoStart。请先启动 ${cfg.bridgeDir}/bridge.mjs`);
    if (starting) return starting;

    starting = (async () => {
      const entry = path.join(cfg.bridgeDir, "bridge.mjs");
      if (!fs.existsSync(entry)) throw new Error(`找不到桥：${entry}`);
      const logDir = path.join(os.homedir(), ".dsh", "gemini-studio");
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, "bridge.log");
      const out = fs.openSync(logFile, "a");
      const env = { ...process.env, BRIDGE_PORT: String(cfg.bridgePort) };
      // 宿主是 Electron 时 execPath 指向 App 本体，得让它以纯 node 身份跑这个脚本
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
      const child = spawn(process.execPath || "node", [entry], {
        cwd: cfg.bridgeDir,
        env,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      for (let i = 0; i < 50; i++) {
        await wait(400);
        if (await healthy()) return;
      }
      throw new Error(`桥启动超时，看看日志：${logFile}`);
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  function bridgeDown(error) {
    return /fetch failed|ECONNREFUSED|UND_ERR|桥返回 HTTP 502/i.test(String(error?.message || error));
  }

  async function call(route, options) {
    await ensureBridge();
    try {
      return await request(route, options);
    } catch (error) {
      if (!bridgeDown(error)) throw error;
      throw new Error("连不上本地桥，先确认 bridge.mjs 能启动（浏览器窗口应该会自己弹出来）");
    }
  }

  async function workspaceDir(agent, signal) {
    try {
      const wd = ctx.get("workingDirectory");
      if (wd && agent) return await wd.ensure(agent, signal);
    } catch {}
    return path.join(os.homedir(), "Movies", "Gemini");
  }

  async function collectMedia(id, dir) {
    const media = await fetch(`${base}/media/${encodeURIComponent(id)}.mp4`, {
      signal: AbortSignal.timeout(120000),
    });
    if (!media.ok) throw new Error(`下载成片失败 HTTP ${media.status}`);
    const buf = Buffer.from(await media.arrayBuffer());
    if (buf.length < 12 || buf.toString("ascii", 4, 8) !== "ftyp") {
      throw new Error("桥返回的文件不是 MP4");
    }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.mp4`);
    fs.writeFileSync(file, buf);
    return { file, bytes: buf.length };
  }

  async function submitAndWait(payload, exec) {
    const created = await call("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 60000,
    });
    const id = created.id;
    const startedAt = Date.now();
    const deadline = startedAt + cfg.taskTimeoutMs;

    while (Date.now() < deadline) {
      if (exec.signal?.aborted) throw new Error("已取消");
      await wait(cfg.pollMs);
      let st;
      try {
        st = await request(`/task/${encodeURIComponent(id)}`, { timeoutMs: 15000 });
      } catch {
        continue;
      }
      if (st.status === "failed") throw new Error(st.error || "桥报告生成失败");
      if (st.status !== "completed") continue;

      const dir = path.join(await workspaceDir(exec.agent, exec.signal), "gemini-out");
      const { file, bytes } = await collectMedia(id, dir);
      return { id, file, bytes, account: st.account || created.account || null, seconds: Math.round((Date.now() - startedAt) / 1000) };
    }
    throw new Error(`等待超时（${Math.round(cfg.taskTimeoutMs / 60000)} 分钟）。任务仍在跑时不要重复提交，先用 gemini_accounts 看状态`);
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: "gemini_video",
      description:
        "用本机已登录的 Gemini 网页账号生成一条视频（不是官方 API）。可给一张首帧图做图生视频。" +
        "出片通常 1–3 分钟。多账号时自动挑最久没用的可用账号；额度耗尽的账号会进冷却。" +
        "传 semi=true 则只把画幅和提示词准备好，停在发送前等人点发送（最稳，但要人在电脑前）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", description: "画面与运镜描述，中英文都行" },
          aspect: { type: "string", enum: ["16:9", "9:16"], description: "画幅，默认 16:9" },
          first_frame: { type: "string", description: "首帧图的本地绝对路径；给了就是图生视频" },
          account: { type: "string", description: "指定账号 id 或名字；不传就自动轮换" },
          semi: { type: "boolean", description: "半自动：准备好后停在发送前，由人点发送" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["file", "bytes", "task"],
          properties: {
            file: { type: "string" },
            bytes: { type: "number" },
            account: { type: "string" },
            seconds: { type: "number" },
            task: { type: "string" },
          },
        },
        render(_args, value) {
          return [
            {
              type: "text",
              text: `视频已生成：${value.file}（${(value.bytes / 1e6).toFixed(2)} MB，账号 ${value.account ?? "未知"}，耗时 ${value.seconds ?? "?"} 秒）`,
            },
          ];
        },
      },
      timeoutMs: DEFAULTS.taskTimeoutMs + 120000,
      execute: async (args, exec) => {
        const payload = {
          prompt: String(args.prompt || "").trim(),
          aspect: args.aspect || "16:9",
        };
        if (!payload.prompt) throw new Error("prompt 不能为空");
        if (args.account) payload.account = args.account;
        if (args.semi) payload.semi = true;
        if (args.first_frame) {
          const file = path.resolve(String(args.first_frame));
          if (!fs.existsSync(file)) throw new Error(`首帧图不存在：${file}`);
          const mime = /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png";
          payload.images = [`data:${mime};base64,${fs.readFileSync(file).toString("base64")}`];
        }
        const result = await submitAndWait(payload, exec);
        return { file: result.file, bytes: result.bytes, account: result.account, seconds: result.seconds, task: result.id };
      },
    }),
  );

  // 图片：桥那边是同步接口（20–60 秒），这里直接等结果再落盘
  async function imageToWorkspace(payload, dir) {
    const data = await call("/generate-image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 30000,
    });
    if (!data?.id) throw new Error("桥没有返回任务 id");
    // 出图现在是任务化的：提交后轮询，桥占着账号也只会是它自己的事，
    // 不会因为客户端超时把 busy 泄漏给别人。
    let info = data;
    for (let i = 0; i < 200; i++) {
      await wait(3000);
      info = await call(`/task/${encodeURIComponent(data.id)}`, { timeoutMs: 20000 });
      if (info.status === "failed") throw new Error(`出图失败：${info.error || "未知原因"}`);
      if (info.status === "completed") break;
    }
    if (info?.status !== "completed") throw new Error("出图超时（等了 10 分钟）");
    const res = await fetch(`${base}/media/${encodeURIComponent(data.id)}.png`, {
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8 || buf.toString("hex", 0, 4) !== "89504e47") throw new Error("桥返回的文件不是 PNG");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${data.id}.png`);
    fs.writeFileSync(file, buf);
    return { id: data.id, file, bytes: buf.length, width: info.width, height: info.height, account: info.account };
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: "gemini_image",
      description:
        "用本机已登录的 Gemini 网页账号生成一张图片（不是官方 API）。可给一张参考图。通常 20–60 秒。" +
        "多账号时自动挑最久没用的可用账号；图片额度耗尽时会报错，不要重试。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", description: "画面描述，中英文都行" },
          reference: { type: "string", description: "参考图的本地绝对路径（可选）" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["file", "bytes", "width", "height"],
          properties: {
            file: { type: "string" },
            bytes: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
            account: { type: "string" },
            seconds: { type: "number" },
          },
        },
        render(_args, value) {
          return [
            {
              type: "text",
              text: `图片已生成：${value.file}（${value.width}x${value.height}，${(value.bytes / 1024).toFixed(0)} KB）`,
            },
          ];
        },
      },
      timeoutMs: 420000,
      execute: async (args, exec) => {
        const payload = { prompt: String(args.prompt || "").trim() };
        if (!payload.prompt) throw new Error("prompt 不能为空");
        if (args.reference) {
          const file = path.resolve(String(args.reference));
          if (!fs.existsSync(file)) throw new Error(`参考图不存在：${file}`);
          const mime = /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png";
          payload.images = [`data:${mime};base64,${fs.readFileSync(file).toString("base64")}`];
        }
        const startedAt = Date.now();
        const dir = path.join(await workspaceDir(exec.agent, exec.signal), "gemini-out");
        const out = await imageToWorkspace(payload, dir);
        return {
          file: out.file,
          bytes: out.bytes,
          width: out.width,
          height: out.height,
          account: out.account,
          seconds: Math.round((Date.now() - startedAt) / 1000),
        };
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: "gemini_accounts",
      description:
        "管理 Gemini 网页账号：list 看谁可用/冷却到几点，add 弹一个 Chrome 窗口由用户本人登录，" +
        "reset 手动解除冷却，remove 移除账号（不删登录态），doctor 体检某个账号的登录和视频入口（不提交、不耗额度）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["list", "add", "reset", "remove", "doctor"] },
          name: { type: "string", description: "add 时的账号名，例如 jack2" },
          account: { type: "string", description: "reset / remove / doctor 时的账号 id 或名字" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "detail"],
          properties: {
            ok: { type: "boolean" },
            detail: { type: "string" },
          },
        },
        render(_args, value) {
          return [{ type: "text", text: value.detail }];
        },
      },
      timeoutMs: 180000,
      execute: async (args) => {
        const action = String(args.action || "list");
        if (action === "list") {
          const data = await call("/accounts");
          const lines = (data.accounts || []).map((a) => {
            const state = a.busy ? "生成中" : a.hardBlocked ? `需人工处理（到 ${a.blockedUntil}）` : a.blocked ? `冷却到 ${a.blockedUntil}` : "可用";
            return `${a.id}  ${a.name}${a.email ? ` <${a.email}>` : ""}  今日 ${a.usedToday ?? 0}/${a.dailyCap ?? "?"}  ${state}`;
          });
          return { ok: true, detail: lines.length ? lines.join("\n") : "还没有绑定任何账号，用 action=add 加一个" };
        }

        if (action === "add") {
          const nm = String(args.name || "").trim();
          if (!nm) throw new Error("add 需要 name");
          const data = await call("/accounts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: nm }),
          });
          return {
            ok: true,
            detail: `已登记 ${data.account?.id} ${nm}。Chrome 窗口已弹出，请用户本人登录 Google 并打开 gemini.google.com，登录完再回来。`,
          };
        }

        const id = String(args.account || "").trim();
        if (!id) throw new Error(`${action} 需要 account`);

        if (action === "reset") {
          await call(`/accounts/${encodeURIComponent(id)}/reset`, { method: "POST" });
          return { ok: true, detail: `已解除 ${id} 的冷却` };
        }
        if (action === "remove") {
          await call(`/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
          return { ok: true, detail: `已移除 ${id}（登录态目录保留）` };
        }
        if (action === "doctor") {
          const report = await call("/doctor", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ account: id }),
            timeoutMs: 120000,
          });
          const checks = report.checks || {};
          const lines = [
            `账号 ${report.account?.name}（${report.account?.email || "未知邮箱"}）`,
            `登录 ${checks.loggedIn ? "正常" : "异常"}｜输入框 ${checks.editor ? "就绪" : "缺失"}｜画幅 ${checks.aspect ? "就绪" : "缺失"}`,
            `今日用量 ${report.usage?.today ?? 0}/${report.usage?.cap ?? "?"}`,
          ];
          if (checks.quota) lines.push(`额度提示：${checks.quota}`);
          if (report.error) lines.push(`错误：${report.error}`);
          return { ok: !!report.ok, detail: lines.join("\n") };
        }
        throw new Error(`不认识的 action：${action}`);
      },
    }),
  );

  // ---------------------------------------------------------------- 原子脚本（python）
  // 配音/字幕合成、静图运镜、成片核验：复用 dsh-video-pipeline 里实测过的原子脚本（MIT）。

  // ---------------------------------------------------------------- 密钥
  // MiMo key 存在 DSH home 下的私有文件（0600），也可以在面板里填。env / mimocode.jsonc 仍然优先兼容。

  function secretsFile() {
    return path.join(os.homedir(), ".dsh", "gemini-studio", "secrets.json");
  }

  function readSecrets() {
    try {
      return JSON.parse(fs.readFileSync(secretsFile(), "utf8")) || {};
    } catch {
      return {};
    }
  }

  function readTtsKey() {
    const fromFile = readSecrets().mimoApiKey;
    if (fromFile) return { key: fromFile, source: "studio" };
    if (process.env.MIMO_API_KEY) return { key: process.env.MIMO_API_KEY, source: "env" };
    try {
      const raw = fs.readFileSync(path.join(os.homedir(), ".config", "mimocode", "mimocode.jsonc"), "utf8");
      const m = raw.match(/"xiaomi"\s*:\s*\{[\s\S]*?"apiKey"\s*:\s*"([^"]+)"/);
      if (m) return { key: m[1], source: "mimocode" };
    } catch {}
    return { key: null, source: null };
  }

  function saveTtsKey(key) {
    const dir = path.dirname(secretsFile());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const data = { ...readSecrets(), mimoApiKey: key };
    fs.writeFileSync(secretsFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(secretsFile(), 0o600);
    } catch {}
  }

  function clearTtsKey() {
    const data = readSecrets();
    delete data.mimoApiKey;
    try {
      fs.writeFileSync(secretsFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch {}
  }

  // DSH 自带的 python 带 Pillow；系统 python3 不一定有，所以优先用自带的
  function pythonBin() {
    if (process.env.PYTHON) return process.env.PYTHON;
    try {
      const root = path.join(os.homedir(), ".dsh", "dsh-runtimes");
      for (const name of fs.readdirSync(root)) {
        const candidate = path.join(root, name, "dependencies", "python", "bin", "python3");
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
    return "python3";
  }

  function runPy(script, args, timeoutMs = 900000) {
    const file = path.join(PLUGIN_DIR, "py", script);
    if (!fs.existsSync(file)) throw new Error(`缺少脚本：${file}`);
    return new Promise((resolve, reject) => {
      const env = { ...process.env, FFMPEG: ffmpegBin() };
      const own = readTtsKey();
      if (own.key) env.MIMO_API_KEY = own.key;
      env.PATH = `${path.dirname(ffmpegBin())}:${env.PATH || ""}`;
      const child = spawn(pythonBin(), [file, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => {
        err += d.toString();
        if (err.length > 20000) err = err.slice(-20000);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${script} 超时`));
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`跑不起来 ${script}：${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(out.trim());
        reject(new Error(`${script} 失败：${(err + "\n" + out).trim().split("\n").filter(Boolean).slice(-4).join(" | ")}`));
      });
    });
  }

  function resolveFrom(dir, p) {
    const v = String(p || "");
    return path.isAbsolute(v) ? v : path.resolve(dir, v);
  }

  async function composeFromManifest(manifest, dir) {
    if (!manifest || !Array.isArray(manifest.shots) || !manifest.shots.length) {
      throw new Error("manifest.shots 不能为空");
    }
    const m = {
      ...manifest,
      shots: manifest.shots.map((x) => ({ ...x, file: resolveFrom(dir, x.file) })),
      audio: (manifest.audio || []).map((x) => ({ ...x, file: resolveFrom(dir, x.file) })),
    };
    if (manifest.subtitles) m.subtitles = resolveFrom(dir, manifest.subtitles);
    m.out = manifest.out ? resolveFrom(dir, manifest.out) : path.join(dir, `compose-${Date.now()}.mp4`);
    for (const sh of m.shots) if (!fs.existsSync(sh.file)) throw new Error(`找不到镜头：${sh.file}`);
    for (const au of m.audio) if (!fs.existsSync(au.file)) throw new Error(`找不到音轨：${au.file}`);
    if (m.subtitles && !fs.existsSync(m.subtitles)) throw new Error(`找不到字幕：${m.subtitles}`);

    const tmp = path.join(os.tmpdir(), `gs-manifest-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    try {
      await runPy("video_compose.py", [tmp]);
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
    }
    if (!fs.existsSync(m.out)) throw new Error("合成结束但没找到输出文件");
    return { file: m.out, bytes: fs.statSync(m.out).size, seconds: await probeDuration(m.out) };
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: "video_compose",
      description:
        "正式合成一条成片：镜头列表 + 配音时间轴（delay_ms）+ SRT 字幕，一条 manifest 出成片。" +
        "会归一化每个镜头、顺序拼接（可按镜头叠化转场）、按时间轴混音、烧字幕（失败自动降级为无字幕）、加 faststart。" +
        "相对路径按工作区解析；不给 out 就写到 gemini-out/compose-<时间戳>.mp4。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["manifest"],
        properties: {
          manifest: {
            type: "object",
            description: "合成清单",
            properties: {
              shots: {
                type: "array",
                description: "镜头，按顺序；每项可带 transition（从上一镜叠化进来的秒数，省略=硬切）",
                items: { type: "object" },
              },
              audio: { type: "array", description: "配音轨，delay_ms 为起始毫秒", items: { type: "object" } },
              subtitles: { type: "string", description: "SRT 文件路径" },
              style: { type: "string", description: "ASS 样式串，不传用内置竖屏样式" },
              fps: { type: "number", description: "帧率，默认 24" },
              w: { type: "number", description: "成片宽，默认 720" },
              h: { type: "number", description: "成片高，默认 1280" },
              total: { type: "number", description: "成片总时长（秒），应不小于最后一条配音结束时刻" },
              out: { type: "string", description: "输出路径" },
            },
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["file", "bytes"],
          properties: { file: { type: "string" }, bytes: { type: "number" }, seconds: { type: "number" } },
        },
        render(_a, v) {
          return [{ type: "text", text: `成片已生成：${v.file}（${v.seconds ?? "?"} 秒，${(v.bytes / 1e6).toFixed(2)} MB）` }];
        },
      },
      timeoutMs: 1200000,
      execute: async (args, exec) => {
        const dir = await workspaceDir(exec.agent, exec.signal);
        return composeFromManifest(args.manifest, dir);
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: "image_to_video",
      description:
        "把一张静态图做成运镜镜头（ffmpeg zoompan，缓推或缓拉）。用来把关键帧变成短镜头，不消耗 Gemini 额度。" +
        "输出 720x1280 竖屏 mp4，长度和变焦幅度可调。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["image", "seconds"],
        properties: {
          image: { type: "string", description: "输入图片的绝对路径" },
          seconds: { type: "number", description: "镜头时长（秒）" },
          direction: { type: "string", enum: ["in", "out"], description: "缓推（默认）还是缓拉" },
          fps: { type: "number", description: "帧率，默认 25" },
          out: { type: "string", description: "输出路径；不传写到 gemini-out/clip-<时间戳>.mp4" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["file", "bytes"],
          properties: { file: { type: "string" }, bytes: { type: "number" }, seconds: { type: "number" } },
        },
        render(_a, v) {
          return [{ type: "text", text: `运镜镜头已生成：${v.file}（${(v.bytes / 1e6).toFixed(2)} MB）` }];
        },
      },
      timeoutMs: 300000,
      execute: async (args, exec) => {
        const dir = await workspaceDir(exec.agent, exec.signal);
        const input = path.resolve(String(args.image || ""));
        if (!fs.existsSync(input)) throw new Error(`图片不存在：${input}`);
        const seconds = Number(args.seconds);
        if (!(seconds > 0)) throw new Error("seconds 必须是正数");
        const out = args.out
          ? path.resolve(String(args.out))
          : path.join(dir, "gemini-out", `clip-${Date.now()}.mp4`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const pargs = ["--in", input, "--out", out, "--seconds", String(seconds)];
        pargs.push("--dir", args.direction === "out" ? "out" : "in");
        if (args.fps) pargs.push("--fps", String(Math.round(Number(args.fps))));
        await runPy("image2video.py", pargs, 300000);
        if (!fs.existsSync(out)) throw new Error("脚本结束但没有输出文件");
        return { file: out, bytes: fs.statSync(out).size, seconds };
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: "media_verify",
      description:
        "成片核验三件事：astats 分窗核对配音/静默能量、audio-ncc 比对某段音频和参考 wav 是否同版本、" +
        "brightness 抽帧查白屏黑屏。验收镜头和成片时用，别靠肉眼猜。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action", "file"],
        properties: {
          action: { type: "string", enum: ["astats", "audio-ncc", "brightness"] },
          file: { type: "string", description: "要核验的 mp4 绝对路径" },
          windows: {
            type: "array",
            description: "astats 用：窗口，格式 NAME:START:END，例如 speech1:5.5:7.9",
            items: { type: "string" },
          },
          ref: { type: "string", description: "audio-ncc 用：参考 wav 路径" },
          at: { type: "number", description: "audio-ncc 用：成片中的起始秒" },
          length: { type: "number", description: "audio-ncc 用：取段秒数，默认 8" },
          frames: { type: "number", description: "brightness 用：抽帧数，默认 5" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "report"],
          properties: { ok: { type: "boolean" }, report: { type: "string" } },
        },
        render(_a, v) {
          return [{ type: "text", text: v.report }];
        },
      },
      timeoutMs: 300000,
      execute: async (args) => {
        const file = path.resolve(String(args.file || ""));
        if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
        const action = String(args.action);
        const pargs = [action, file];
        if (action === "astats") {
          const wins = Array.isArray(args.windows) ? args.windows : [];
          if (!wins.length) throw new Error("astats 需要 windows，例如 speech1:5.5:7.9");
          for (const w of wins) pargs.push("--window", String(w));
        } else if (action === "audio-ncc") {
          if (!args.ref) throw new Error("audio-ncc 需要 ref");
          pargs.push("--ref", path.resolve(String(args.ref)), "--at", String(Number(args.at || 0)));
          if (args.length) pargs.push("--len", String(Number(args.length)));
        } else if (action === "brightness") {
          if (args.frames) pargs.push("--frames", String(Math.round(Number(args.frames))));
        } else {
          throw new Error(`不认识的 action：${action}`);
        }
        const report = await runPy("media_verify.py", pargs, 300000);
        return { ok: !/FAIL|错误|不通过/i.test(report), report: report.slice(0, 4000) };
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: "tts_generate",
      description:
        "生成一条中文配音 wav（MiMo TTS）。三种模式：preset 用预置音色（茉莉/冰糖/苏打/白桦），" +
        "design 用一段文字设计音色，clone 用 mp3/wav 样本复刻音色。\n" +
        "风格控制两条路：① style 传自然语言指令（放 user 消息，如「语速偏慢，气声多一点」）；" +
        "② 直接在 text 里写标签——开头 (怅然)/(东北话)/(唱歌) 定整体风格，句中 [叹气]/[笑声]/[语速加快] 做细粒度控制。\n" +
        "唱歌模式必须让 text 以 (唱歌) 开头，或用 sing=true。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string", description: "朗读文本；风格标签和音频标签直接写在这里" },
          style: { type: "string", description: "自然语言风格指令（语速/情绪/角色扮演），可选" },
          mode: { type: "string", enum: ["preset", "design", "clone"], description: "默认 preset" },
          voice: { type: "string", description: "preset 模式的音色，默认茉莉；也可 冰糖/苏打/白桦/Mia/Chloe/Milo/Dean" },
          sample: { type: "string", description: "clone 模式的样本音频路径（mp3/wav）" },
          sing: { type: "boolean", description: "唱歌模式，自动在开头加 (唱歌)" },
          out: { type: "string", description: "输出 wav 路径；不传写到 gemini-out/vo-<时间戳>.wav" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["file", "bytes"],
          properties: { file: { type: "string" }, bytes: { type: "number" }, seconds: { type: "number" } },
        },
        render(_a, v) {
          return [{ type: "text", text: `配音已生成：${v.file}（${v.seconds ?? "?"} 秒，${(v.bytes / 1024).toFixed(0)} KB）` }];
        },
      },
      timeoutMs: 400000,
      execute: async (args, exec) => {
        const text = String(args.text || "").trim();
        if (!text) throw new Error("text 不能为空");
        const mode = ["preset", "design", "clone"].includes(args.mode) ? args.mode : "preset";
        if (mode === "design" && !String(args.style || "").trim()) {
          throw new Error("design 模式必须给 style（音色描述），例如「五十多岁的北方男人，嗓音沙哑沉稳」");
        }
        if (mode === "clone" && !args.sample) throw new Error("clone 模式必须给 sample（mp3/wav 路径）");
        if (mode === "clone") {
          const sample = path.resolve(String(args.sample));
          if (!fs.existsSync(sample)) throw new Error(`样本不存在：${sample}`);
        }
        const dir = await workspaceDir(exec.agent, exec.signal);
        const out = args.out
          ? path.resolve(String(args.out))
          : path.join(dir, "gemini-out", `vo-${Date.now()}.wav`);
        fs.mkdirSync(path.dirname(out), { recursive: true });

        const pargs = ["--text", text, "--out", out, "--mode", mode];
        if (mode === "preset") pargs.push("--voice", String(args.voice || "茉莉"));
        if (args.style) pargs.push("--style", String(args.style));
        if (mode === "clone") pargs.push("--sample", path.resolve(String(args.sample)));
        if (args.sing) pargs.push("--sing");
        try {
          await runPy("mimo_tts.py", pargs, 200000);
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (/缺少 MiMo API key/.test(msg)) {
            throw new Error("还没配 MiMo key：面板「配音（MiMo）」里填，或设 MIMO_API_KEY 环境变量，然后重试");
          }
          throw e;
        }
        if (!fs.existsSync(out)) throw new Error("TTS 结束但没有输出文件");
        return { file: out, bytes: fs.statSync(out).size, seconds: (await probeDuration(out)) ?? undefined };
      },
    }),
  );

  // ---------------------------------------------------------------- 按语音收尾
  // 生成出来的镜头里人物会多念几句；固定剪入时长会把人声切断。
  // 这里用静音检测找到自然停顿，把每个镜头的剪入终点落到停顿上。

  function silenceRuns(file) {
    return new Promise((resolve) => {
      const child = spawn(ffmpegBin(), ["-v", "info", "-i", file, "-af", "silencedetect=noise=-34dB:d=0.20", "-f", "null", "-"]);
      let err = "";
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", () => resolve([]));
      child.on("close", () => {
        const starts = [...err.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
        const ends = [...err.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
        const runs = [];
        for (let i = 0; i < starts.length; i++) {
          const s = starts[i];
          const e = ends[i] != null && ends[i] > s ? ends[i] : s + 0.3;
          runs.push([s, e]);
        }
        resolve(runs);
      });
    });
  }

  // 取离目标时长最近的停顿起点（前后各留 2.5s 余量）；
  // 这样既不会把人声切断，也不会为了等停顿把镜头拉得太长。
  function pickCut(runs, target, mediaDur, maxExtend = 2.5) {
    const usable = runs.filter(([s, e]) => e - s >= 0.2 && s >= 1.0);
    if (!usable.length) return Math.min(mediaDur, target + maxExtend);
    let best = null;
    for (const [s] of usable) {
      const d = Math.abs(s - target);
      if (d <= maxExtend && (!best || d < best.d)) best = { s, d };
    }
    if (best) return best.s;
    return Math.min(mediaDur, target + maxExtend);
  }

  async function retimeProject(projectDir, opts = {}) {
    const sbPath = path.join(projectDir, "storyboard.json");
    const tasksPath = path.join(projectDir, "tasks.json");
    const sb = JSON.parse(fs.readFileSync(sbPath, "utf8"));
    const tasks = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
    const rows = [];
    for (const shot of sb.shots) {
      const att = [...tasks.attempts].reverse().find((a) => a.shotId === shot.id && a.media);
      if (!att) continue;
      const media = path.join(projectDir, att.media.path);
      const mediaDur = Number(att.media.duration) || 0;
      const target = Math.min(Number(shot.editSeconds) || 7.5, mediaDur);
      // Gemini 一条就是 10 秒，剪太短会把人声切断。默认整条用满，
      // 只有显式 full:false 才按停顿收短。
      let newDur;
      if (opts.full === false) {
        const runs = await silenceRuns(media);
        const cut = pickCut(runs, target, mediaDur, Number(opts.maxExtend ?? 2.5));
        newDur = Math.max(1, Math.min(mediaDur - 0.05, cut));
      } else {
        newDur = Math.max(1, mediaDur - 0.05);
      }
      shot.editSeconds = Math.round(newDur * 10) / 10;
      rows.push({ id: shot.id, from: target, to: shot.editSeconds, extended: shot.editSeconds > target + 0.05 });
    }
    fs.writeFileSync(sbPath, JSON.stringify(sb, null, 2));
    return rows;
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: "retime_shots",
      description:
        "按每个镜头的实际人声收尾重排剪入时长。\n" +
        "默认整条用满（Gemini 一条 10 秒，剪短会切断人声）；full:false 时改用静音检测找自然停顿收短。\n" +
        "只改 storyboard.json 的 editSeconds（不会动素材），改完要重新验收再出片。" +
        "原生语音（Gemini 自己念台词）时尤其需要这一步。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["project"],
        properties: {
          project: { type: "string", description: "项目目录" },
          max_extend: { type: "number", description: "full=false 时最多在原计划后面多留几秒找停顿，默认 2.5" },
          full: { type: "boolean", description: "默认 true：整条用完（Gemini 出品就 10 秒，剪短会切断人声）；false 则按停顿收短" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["rows"],
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "from", "to"],
                properties: {
                  id: { type: "string" },
                  from: { type: "number" },
                  to: { type: "number" },
                  extended: { type: "boolean" },
                },
              },
            },
            total: { type: "number" },
          },
        },
        render(_a, v) {
          const lines = v.rows.map((r) => `${r.id}  ${r.from}s → ${r.to}s${r.extended ? "  (延长)'" : ""}`);
          return [{ type: "text", text: "剪入时长已按人声收尾重排：\n" + lines.join("\n") + `\n合计 ${v.total}s` }];
        },
      },
      timeoutMs: 180000,
      execute: async (args, exec) => {
        let dir = String(args.project || "").trim();
        if (!dir) throw new Error("project 不能为空");
        if (!path.isAbsolute(dir)) dir = path.resolve(await workspaceDir(exec.agent, exec.signal), dir);
        const rows = await retimeProject(dir, { maxExtend: args.max_extend, full: args.full !== false });
        const total = rows.reduce((sum, r) => sum + r.to, 0);
        return { rows, total: Math.round(total * 10) / 10 };
      },
    }),
  );

  // ---------------------------------------------------------------- 分镜直接出片
  // 读项目（storyboard + tasks），用 edit-plan 拿到可放置的镜头，自动配转场、配音时间轴和字幕。

  const TRANSITION_SECONDS = 0.6;

  function transitionSecondsOf(transitionIn) {
    const type = String((transitionIn && transitionIn.type) || "").trim();
    if (!type) return 0;
    if (/叠化|淡入|溶解|crossfade|dissolve|fade/i.test(type)) return TRANSITION_SECONDS;
    return 0;
  }

  function runNode(scriptArgs, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
      const child = spawn(process.execPath || "node", scriptArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("edit-plan 超时"));
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`跑不起来 studio.mjs：${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(out);
        reject(new Error(`edit-plan 失败：${(err || out).trim().split("\n").slice(-4).join(" | ")}`));
      });
    });
  }

  function srtTime(sec) {
    const t = Math.max(0, sec);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  }

  function buildSrtFromStoryboard(items, fps) {
    const cues = [];
    for (const item of items) {
      const text = (item.dialogue || [])
        .filter((d) => d && d.kind !== "sfx" && String(d.text || "").trim())
        .map((d) => String(d.text).trim())
        .join("\n");
      if (!text) continue;
      const start = item.fromFrame / fps + 0.25;
      const end = (item.fromFrame + item.durationInFrames) / fps - 0.25;
      if (end <= start) continue;
      cues.push({ start, end, text });
    }
    return cues
      .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`)
      .join("\n\n")
      .concat("\n");
  }

  function findVoice(projectDir, shotId) {
    const dir = path.join(projectDir, "assets", "voices");
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const exact = names.filter((n) => new RegExp(`^${shotId}\\.(wav|mp3)$`, "i").test(n));
    const prefixed = names.filter((n) => new RegExp(`^${shotId}[-_].*\\.(wav|mp3)$`, "i").test(n)).sort();
    const hit = exact[0] || prefixed[0];
    return hit ? path.join(dir, hit) : null;
  }

  async function composeFromProject(projectArg, opts) {
    const ws = path.dirname(outputRoot());
    const projectDir = path.resolve(projectArg);
    if (!fs.existsSync(projectDir)) throw new Error(`项目目录不存在：${projectDir}`);
    const studioCandidates = [
      path.join(ws, ".agents", "skills", "video-production", "scripts", "studio.mjs"),
      path.join(PLUGIN_DIR, "skills-video-production", "scripts", "studio.mjs"),
    ];
    const studio = studioCandidates.find((p) => fs.existsSync(p));
    if (!studio) {
      throw new Error(`找不到制作脚本 studio.mjs，试过：\n${studioCandidates.join("\n")}`);
    }

    const mode = opts.mode === "preview" ? "preview" : "production";
    const plan = JSON.parse(await runNode([studio, "edit-plan", projectDir, mode], 180000));
    if (!plan.items || !plan.items.length) throw new Error("分镜里没有镜头");
    if (plan.missing && plan.missing.length) {
      throw new Error(`这些镜头还没有通过验收的源片，先补生成/验收：${plan.missing.join(", ")}`);
    }

    const projectJson = JSON.parse(fs.readFileSync(path.join(projectDir, "project.json"), "utf8"));
    // 声音模式：镜头级 > 项目级 > 默认 native。
    // 默认是 native（Gemini 生成时就念了台词），只有显式写 post 才去叠 TTS。
    const effectiveAudio = projectJson.audioMode ?? "native";
    // native：直接用镜头自带的同期声，不再叠 TTS
    const nativeAudio = !opts.mute && effectiveAudio === "native";

    const fps = Number(plan.fps) || 24;
    const aspect = plan.aspect === "9:16" ? "9:16" : plan.aspect === "1:1" ? "1:1" : "16:9";
    const [w, h] = aspect === "9:16" ? [720, 1280] : aspect === "1:1" ? [720, 720] : [1280, 720];

    const shots = [];
    const audio = [];
    const timeline = [];
    let cursor = 0;
    let overlapTotal = 0;
    let lastAudioEnd = 0;

    for (const item of plan.items) {
      const file = path.resolve(projectDir, item.source.path);
      if (!fs.existsSync(file)) throw new Error(`镜头文件不存在：${file}`);
      const start = Number(item.source.sourceStartFromInSeconds) || 0;
      const duration = Number(item.durationInFrames) / fps;
      const t = transitionSecondsOf(item.transitionIn);
      const shot = { file, start, duration };
      if (t > 0 && shots.length) {
        const safe = Math.min(t, duration - 0.1, 1.5);
        if (safe > 0.05) {
          shot.transition = safe;
          overlapTotal += safe;
        }
      }
      shots.push(shot);
      timeline.push({
        shotId: item.shotId,
        startSec: cursor / fps - overlapTotal,
        durSec: duration,
        file,
        sourceIn: start,
        dialogue: item.dialogue || [],
      });

      const voice = opts.mute || nativeAudio ? null : findVoice(projectDir, item.shotId);
      if (voice) {
        const delaySec = cursor / fps;
        audio.push({ file: voice, delay_ms: Math.round(delaySec * 1000) });
        const vd = (await probeDuration(voice)) || 0;
        lastAudioEnd = Math.max(lastAudioEnd, delaySec + vd);
      }
      cursor += item.durationInFrames;
    }

    if (!opts.mute && !nativeAudio && !audio.length && plan.items.some((i) => (i.dialogue || []).length)) {
      throw new Error(
        "这个项目设成了后配声音（post），但 assets/voices/ 里没有对应配音。先用 tts_generate 生成 wav 并命名成 <镜号>.wav；" +
        "如果本来就想用 Gemini 原声，把 project.json 的 audioMode 改成 native（或删掉这个字段）",
      );
    }

    const videoLen = cursor / fps - overlapTotal;
    const total = Number(opts.total) || videoLen;
    const overrun = lastAudioEnd - videoLen;

    // 字幕：项目里已有就用最新的，否则按分镜对白生成一份并留档
    const editsDir = path.join(projectDir, "assets", "edits");
    fs.mkdirSync(editsDir, { recursive: true });
    let subs;
    try {
      const existing = fs.readdirSync(editsDir).filter((n) => n.endsWith(".srt")).sort();
      if (existing.length) subs = path.join(editsDir, existing[existing.length - 1]);
    } catch {}
    if (!subs && nativeAudio && plan.subtitles !== false) {
      // 原生语音下字幕要对准真实人声：先找每镜的人声起止，再生成字幕
      const cues = [];
      for (const t of timeline) {
        const text = (t.dialogue || [])
          .filter((d) => d && String(d.text || "").trim())
          .map((d) => String(d.text).trim())
          .join("\n");
        if (!text) continue;
        const runs = await silenceRuns(t.file);
        const mediaDur = t.sourceIn + t.durSec;
        const lead = runs.find(([a]) => a <= 0.05);
        const tail = [...runs].reverse().find(([a, b]) => b >= mediaDur - 0.15 || a >= t.sourceIn + t.durSec - 0.15);
        let a = lead ? lead[1] : 0;
        let b = tail ? tail[0] : t.sourceIn + t.durSec;
        a = Math.min(Math.max(a, t.sourceIn), t.sourceIn + t.durSec);
        b = Math.min(Math.max(b, a + 0.5), t.sourceIn + t.durSec);
        cues.push({ start: t.startSec + (a - t.sourceIn), end: t.startSec + (b - t.sourceIn), text });
      }
      const generated = cues
        .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`)
        .join("\n\n")
        .concat("\n");
      if (generated.trim()) {
        subs = path.join(editsDir, `${path.basename(projectDir)}.srt`);
        fs.writeFileSync(subs, generated, "utf8");
      }
    }
    if (!subs && !nativeAudio && plan.subtitles !== false) {
      const generated = buildSrtFromStoryboard(plan.items, fps);
      if (generated.trim()) {
        subs = path.join(editsDir, `${path.basename(projectDir)}.srt`);
        fs.writeFileSync(subs, generated, "utf8");
      }
    }

    const out = opts.out
      ? path.resolve(projectArg, "..", String(opts.out))
      : path.join(projectDir, "exports", `${path.basename(projectDir)}.mp4`);

    const manifest = { shots, audio, total, fps, w, h, out };
    if (nativeAudio) manifest.audioSource = "native";
    if (subs) manifest.subtitles = subs;
    if (opts.font) manifest.font = String(opts.font);
    if (opts.subtitle_chars) manifest.subtitle_chars = Number(opts.subtitle_chars);

    const result = await composeFromManifest(manifest, projectDir);
    const out2 = {
      file: result.file,
      bytes: result.bytes,
      shots: shots.length,
      transitions: shots.filter((x) => x.transition).length,
      voices: audio.length,
    };
    if (result.seconds != null) out2.seconds = result.seconds;
    if (subs) out2.subtitles = subs;
    if (overrun > 0.3) {
      out2.warning = `配音比画面长 ${overrun.toFixed(1)} 秒，尾部会被截断：把该镜加长，或把配音提前/精简`;
    }
    return out2;
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: "short_compose",
      description:
        "从项目直接出成片：读 storyboard + tasks，按验收过的镜头摆放，自动配转场、配音时间轴和字幕，输出 MP4。\n" +
        "转场取分镜的 transitionIn（叠化类 → 0.6 秒，硬切 → 0）；声音看 project.json 的 audioMode：" +
        "native 直接用镜头自带同期声（Gemini 生成时念的台词，视频/音频同步过渡），post 才去 assets/voices/<镜号>.wav 排 TTS 时间轴；" +
        "字幕优先用 assets/edits/ 里已有的 srt，没有就按分镜对白生成一份。" +
        "默认输出到项目 exports/<项目名>.mp4。有镜头没通过验收会直接报出镜号，不会静默跳过。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["project"],
        properties: {
          project: { type: "string", description: "项目目录（绝对路径或相对工作区）" },
          out: { type: "string", description: "输出路径；默认 <项目>/exports/<项目名>.mp4" },
          mode: { type: "string", enum: ["production", "preview"], description: "默认 production" },
          mute: { type: "boolean", description: "丢弃配音和原声" },
          subtitle_chars: { type: "number", description: "字幕每行最多几个字，默认 16" },
          font: { type: "string", description: "字幕字体，默认按平台自动选" },
          total: { type: "number", description: "手动指定成片总时长（秒）" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["file", "bytes", "shots"],
          properties: {
            file: { type: "string" },
            bytes: { type: "number" },
            seconds: { type: "number" },
            shots: { type: "number" },
            transitions: { type: "number" },
            voices: { type: "number" },
            subtitles: { type: "string" },
            warning: { type: "string" },
          },
        },
        render(_a, v) {
          return [
            {
              type: "text",
              text:
                `成片已生成：${v.file}（${v.seconds ?? "?"} 秒，${v.shots} 镜，` +
                `${v.transitions} 处转场，${v.voices} 条配音，${(v.bytes / 1e6).toFixed(2)} MB）` +
                (v.subtitles ? `\n字幕：${v.subtitles}` : "\n字幕：无") +
                (v.warning ? `\n⚠️ ${v.warning}` : ""),
            },
          ];
        },
      },
      timeoutMs: 1800000,
      execute: async (args, exec) => {
        const project = String(args.project || "").trim();
        if (!project) throw new Error("project 不能为空");
        let dir = project;
        if (!path.isAbsolute(dir)) {
          dir = path.resolve(await workspaceDir(exec.agent, exec.signal), project);
        }
        return composeFromProject(dir, args);
      },
    }),
  );

  // ---------------------------------------------------------------- 粗剪（ffmpeg）
  // 把已经生成好的镜头按顺序拼成一条片：可剪头尾、统一画幅、保留或丢掉原声。

  function ffmpegBin() {
    const ws = path.dirname(outputRoot());
    const candidates = [
      path.join(ws, "tools", "ffmpeg", "node_modules", "ffmpeg-static", "ffmpeg"),
      path.join(PLUGIN_DIR, "node_modules", "ffmpeg-static", "ffmpeg"),
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "/usr/bin/ffmpeg",
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return "ffmpeg";
  }

  function runFfmpeg(args, timeoutMs = 600000) {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => {
        err += d.toString();
        if (err.length > 24000) err = err.slice(-24000);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("ffmpeg 超时"));
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`找不到 ffmpeg（${e.message}）。装一个静态版：cd 到工作区后 npm i ffmpeg-static，或用 brew install ffmpeg`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(err);
        const tail = err.split("\n").filter((l) => l.trim()).slice(-3).join(" | ");
        reject(new Error(`ffmpeg 失败：${tail || "exit " + code}`));
      });
    });
  }

  async function probeDuration(file) {
    try {
      const out = await new Promise((resolve, reject) => {
        const child = spawn(ffmpegBin(), ["-i", file], { stdio: ["ignore", "ignore", "pipe"] });
        let buf = "";
        child.stderr.on("data", (d) => (buf += d.toString()));
        child.on("close", () => resolve(buf));
        child.on("error", reject);
      });
      const m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return null;
      return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 10) / 10;
    } catch {
      return null;
    }
  }

  async function assembleClips(clips, out, aspect, mute) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gs-assemble-"));
    const W = aspect === "9:16" ? 720 : 1280;
    const H = aspect === "9:16" ? 1280 : 720;
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,format=yuv420p`;
    const list = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const seg = path.join(tmp, `s${String(i).padStart(3, "0")}.mp4`);
      const args = ["-y", "-v", "error"];
      if (clip.start) args.push("-ss", String(clip.start));
      args.push("-i", clip.file);
      if (!mute) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      args.push("-map", "0:v:0");
      if (!mute) args.push("-map", "1:a:0");
      args.push("-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20");
      if (!mute) args.push("-c:a", "aac", "-ar", "44100", "-ac", "2");
      if (clip.duration) args.push("-t", String(clip.duration));
      args.push("-shortest", seg);
      await runFfmpeg(args);
      list.push(`file '${seg}'`);
    }

    const listFile = path.join(tmp, "list.txt");
    fs.writeFileSync(listFile, list.join("\n"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await runFfmpeg(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", out]);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
    return { bytes: fs.statSync(out).size, seconds: await probeDuration(out) };
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: "video_assemble",
      description:
        "把已经生成好的镜头按顺序拼成一条粗剪 MP4（本机 ffmpeg，不联网）。可给每段剪掉的片头秒数和取用时长，" +
        "统一到项目画幅。默认丢弃原声（成片配音/配乐另配）；mute=false 时用静音轨占位保证拼接干净。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["clips"],
        properties: {
          clips: {
            type: "array",
            description: "按出场顺序排列的镜头",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["file"],
              properties: {
                file: { type: "string", description: "镜头文件的绝对路径" },
                start: { type: "number", description: "从第几秒开始取（默认 0）" },
                duration: { type: "number", description: "取多少秒（不传就取到结尾）" },
              },
            },
          },
          out: { type: "string", description: "输出路径；不传就写到 gemini-out/assemble-<时间戳>.mp4" },
          aspect: { type: "string", enum: ["16:9", "9:16"], description: "成片画幅，默认 16:9" },
          mute: { type: "boolean", description: "丢弃原声（默认 true）" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["file", "bytes", "clips"],
          properties: {
            file: { type: "string" },
            bytes: { type: "number" },
            clips: { type: "number" },
            seconds: { type: "number" },
          },
        },
        render(_args, value) {
          return [
            {
              type: "text",
              text: `粗剪已生成：${value.file}（${value.clips} 段，${value.seconds ?? "?"} 秒，${(value.bytes / 1e6).toFixed(2)} MB）`,
            },
          ];
        },
      },
      timeoutMs: 900000,
      execute: async (args, exec) => {
        const clips = Array.isArray(args.clips) ? args.clips : [];
        if (!clips.length) throw new Error("clips 不能为空");
        for (const c of clips) {
          if (!c || !c.file) throw new Error("每段都要给 file");
          if (!fs.existsSync(c.file)) throw new Error(`找不到镜头文件：${c.file}`);
        }
        const aspect = args.aspect === "9:16" ? "9:16" : "16:9";
        const out = args.out
          ? path.resolve(String(args.out))
          : path.join(await workspaceDir(exec.agent, exec.signal), "gemini-out", `assemble-${Date.now()}.mp4`);
        const result = await assembleClips(clips, out, aspect, args.mute !== false);
        return { file: out, bytes: result.bytes, clips: clips.length, seconds: result.seconds ?? undefined };
      },
    }),
  );

  // ---------------------------------------------------------------- 面板后端
  // 面板和工具走同一套操作：这里把桥的能力暴露成同源的 HTTP 路由，
  // 浏览器直接调，不需要另建 Remote 服务；成片落到默认工作区。

  const uiJobs = new Map();

  function workspaceDirs() {
    try {
      const reg = ctx.get("workspaceRegistry");
      const list = (reg && reg.list && reg.list()) || [];
      return list
        .map((ws) => (ws && (ws.path || ws.directory)) || null)
        .filter((d) => typeof d === "string" && d);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- 系统权限
  // 面板上直接告诉用户缺什么权限，并给一个跳到对应设置页的按钮。

  let permCache = { at: 0, accessibility: null };

  function checkAccessibility(force = false) {
    if (!force && Date.now() - permCache.at < 60000 && permCache.accessibility !== null) {
      return Promise.resolve(permCache.accessibility);
    }
    return new Promise((resolve) => {
      if (process.platform !== "darwin") {
        permCache = { at: Date.now(), accessibility: true };
        return resolve(true);
      }
      const child = spawn("osascript", ["-e", 'tell application "System Events" to keystroke ""'], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", () => resolve(false));
      child.on("close", (code) => {
        const ok = code === 0 && !/not allowed|not authorized|assistive access|-1719|-1743/i.test(err);
        permCache = { at: Date.now(), accessibility: ok };
        resolve(ok);
      });
    });
  }

  const SETTINGS_URLS = {
    accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  };

  function openSettings(target) {
    const url = SETTINGS_URLS[target] || SETTINGS_URLS.accessibility;
    if (process.platform !== "darwin") return false;
    try {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
      return true;
    } catch {
      return false;
    }
  }

  function outputRoot() {
    const dirs = workspaceDirs();
    for (const d of dirs) {
      try {
        if (fs.statSync(path.join(d, "gemini-out")).isDirectory()) return path.join(d, "gemini-out");
      } catch {}
    }
    if (dirs.length) return path.join(dirs[0], "gemini-out");
    try {
      const wd = ctx.get("workingDirectory");
      if (wd && wd.defaultDirectory) return path.join(wd.defaultDirectory, "gemini-out");
    } catch {}
    return path.join(os.homedir(), "Movies", "Gemini");
  }

  // 作品墙把每个 workspace 的 gemini-out 都扫一遍，助手和面板产出的片子都在里面
  function listWorks() {
    const roots = new Set([outputRoot()]);
    for (const d of workspaceDirs()) roots.add(path.join(d, "gemini-out"));
    const byName = new Map();
    for (const dir of roots) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/\.(mp4|png)$/i.test(name)) continue;
        try {
          const full = path.join(dir, name);
          const st = fs.statSync(full);
          const prev = byName.get(name);
          if (!prev || st.mtimeMs > prev.mtime)
            byName.set(name, { name, dir, bytes: st.size, mtime: st.mtimeMs, kind: /\.png$/i.test(name) ? "image" : "video" });
        } catch {}
      }
    }
    return [...byName.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 60);
  }

  function workFile(name) {
    if (!/^[\w.-]+\.(mp4|png)$/i.test(name)) return null;
    const hit = listWorks().find((w) => w.name === name);
    return hit ? path.join(hit.dir, hit.name) : null;
  }

  async function startUiJob(input) {
    const job = {
      id: Math.random().toString(36).slice(2, 10),
      status: "running",
      startedAt: Date.now(),
      prompt: String(input.prompt || "").trim(),
      aspect: input.aspect === "9:16" ? "9:16" : "16:9",
      kind: input.kind === "image" ? "image" : "video",
    };
    if (!job.prompt) throw new Error("提示词不能为空");
    uiJobs.set(job.id, job);

    (async () => {
      try {
        if (job.kind === "image") {
          const out = await imageToWorkspace({ prompt: job.prompt }, outputRoot());
          job.status = "completed";
          job.file = out.file;
          job.bytes = out.bytes;
          job.width = out.width;
          job.height = out.height;
          job.account = out.account;
          job.seconds = Math.round((Date.now() - job.startedAt) / 1000);
          return;
        }

        const created = await call("/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: job.prompt,
            aspect: job.aspect,
            semi: input.semi === true,
            ...(input.account ? { account: String(input.account) } : {}),
          }),
          timeoutMs: 60000,
        });
        job.bridgeTask = created.id;
        const deadline = Date.now() + cfg.taskTimeoutMs;
        for (;;) {
          if (Date.now() > deadline) throw new Error("等待超时");
          await wait(cfg.pollMs);
          let st;
          try {
            st = await request(`/task/${encodeURIComponent(created.id)}`, { timeoutMs: 15000 });
          } catch {
            continue;
          }
          if (st.status === "failed") throw new Error(st.error || "生成失败");
          if (st.status !== "completed") continue;
          const { file, bytes } = await collectMedia(created.id, outputRoot());
          job.status = "completed";
          job.file = file;
          job.bytes = bytes;
          job.account = st.account || created.account || null;
          job.seconds = Math.round((Date.now() - job.startedAt) / 1000);
          return;
        }
      } catch (e) {
        job.status = "failed";
        job.error = String((e && e.message) || e);
      }
    })();

    return job;
  }

  // webServer 是可选服务：apply 时它可能还没 ACTIVE，所以等它就绪再注册路由
  const jsonRes = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });

    // 用 Node 的 req/res 而不是 WebResource：resource 路由只答 GET/HEAD，
    // 面板的「添加账号 / 生成 / 保存 key」都是 POST，会掉到 SPA 兜底里去。
    const handler = async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const route = url.pathname.replace(/^\/gemini-studio-api/, "");

      const send = (status, body, headers = {}) => {
        const isBuf = Buffer.isBuffer(body);
        const buf = isBuf ? body : Buffer.from(JSON.stringify(body), "utf8");
        res.writeHead(status, {
          ...(isBuf ? {} : { "content-type": "application/json; charset=utf-8" }),
          "content-length": String(buf.length),
          "cache-control": "no-store",
          ...headers,
        });
        res.end(buf);
      };
      const fail = (status, message) => send(status, { error: message });
      const readBody = () =>
        new Promise((resolve) => {
          let raw = "";
          req.on("data", (c) => {
            raw += c;
            if (raw.length > 8 * 1024 * 1024) req.destroy();
          });
          req.on("end", () => {
            try {
              resolve(raw ? JSON.parse(raw) : {});
            } catch {
              resolve({});
            }
          });
          req.on("error", () => resolve({}));
        });

      try {
        if (route === "/state" && req.method === "GET") {
          let accounts = [];
          let error = null;
          try {
            const data = await call("/accounts");
            accounts = data.accounts || [];
          } catch (e) {
            error = String((e && e.message) || e);
          }
          const tts = readTtsKey();
          return send(200, {
            ok: !error,
            error,
            accounts,
            works: listWorks(),
            jobs: [...uiJobs.values()].slice(-20).reverse(),
            outDir: outputRoot(),
            tts: { configured: !!tts.key, source: tts.source },
            permissions: {
              platform: process.platform,
              accessibility: await checkAccessibility(),
            },
          });
        }

        if (route === "/accounts" && req.method === "POST") {
          const body = await readBody();
          const name = String(body.name || "").trim();
          if (!name) return fail(400, "账号名不能为空");
          const created = await call("/accounts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          });
          return send(200, created);
        }

        const acct = route.match(/^\/accounts\/([\w-]+)(\/reset)?$/);
        if (acct && acct[2] && req.method === "POST") {
          await call(`/accounts/${acct[1]}/reset`, { method: "POST" });
          return send(200, { ok: true });
        }
        if (acct && !acct[2] && req.method === "DELETE") {
          await call(`/accounts/${acct[1]}`, { method: "DELETE" });
          return send(200, { ok: true });
        }

        if (route === "/rename" && req.method === "POST") {
          const body = await readBody();
          const out = await call(`/accounts/${encodeURIComponent(String(body.account || ""))}/rename`, {
            method: "POST",
            body: { name: String(body.name || "") },
          });
          return send(200, out);
        }

        if (route === "/cancel" && req.method === "POST") {
          const body = await readBody();
          const out = await call(`/task/${encodeURIComponent(String(body.id || ""))}/cancel`, { method: "POST", body: {} });
          return send(200, out);
        }

        if (route === "/open-settings" && req.method === "POST") {
          const body = await readBody();
          return send(200, { ok: openSettings(String(body.target || "accessibility")) });
        }

        if (route === "/tts-key" && req.method === "POST") {
          const body = await readBody();
          const key = String(body.key || "").trim();
          if (!key) return fail(400, "key 不能为空");
          saveTtsKey(key);
          return send(200, { ok: true });
        }
        if (route === "/tts-key" && req.method === "DELETE") {
          clearTtsKey();
          return send(200, { ok: true });
        }

        if (route === "/doctor" && req.method === "POST") {
          const body = await readBody();
          return send(
            200,
            await call("/doctor", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ account: body.account }),
              timeoutMs: 120000,
            }),
          );
        }

        if (route === "/generate" && req.method === "POST") {
          const body = await readBody();
          const job = await startUiJob(body);
          return send(200, { id: job.id, status: job.status });
        }

        const jobMatch = route.match(/^\/job\/([\w-]+)$/);
        if (jobMatch && req.method === "GET") {
          const job = uiJobs.get(jobMatch[1]);
          if (!job) return fail(404, "任务不存在");
          return send(200, job);
        }

        const fileMatch = route.match(/^\/file\/([\w.-]+\.(?:mp4|png))$/i);
        if (fileMatch && req.method === "GET") {
          const file = workFile(fileMatch[1]);
          if (!file || !fs.existsSync(file)) return fail(404, "文件不存在");
          const buf = fs.readFileSync(file);
          return send(200, buf, { "content-type": /\.png$/i.test(file) ? "image/png" : "video/mp4" });
        }

        return fail(404, "not found");
      } catch (e) {
        return fail(500, String((e && e.message) || e));
      }
    };

  ctx.inject(["webServer"], (inner) => {
    const web = inner.webServer || (inner.get && inner.get("webServer"));
    if (!web || !web.register) return;
    inner.effect(() => web.register({ kind: "prefix", path: "/gemini-studio-api", handler }));
  });

  // 把内置的制作规范注册成技能，装完插件就能用，不用手动拷 .agents/skills
  ctx.inject(["skills"], (inner) => {
    // 包里带了几个技能（skills-<名字>/SKILL.md），全部注册，装插件即生效
    const dirs = fs
      .readdirSync(PLUGIN_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("skills-"))
      .map((d) => path.join(PLUGIN_DIR, d.name));
    for (const skillDir of dirs) {
      try {
        const entry = path.join(skillDir, "SKILL.md");
        if (!fs.existsSync(entry)) continue;
        const raw = fs.readFileSync(entry, "utf8");
        const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        if (!m) continue;
        const meta = {};
        for (const line of m[1].split("\n")) {
          const kv = line.match(/^([a-zA-Z-]+):\s*(.+)$/);
          if (kv) meta[kv[1]] = kv[2].trim();
        }
        if (!meta.name || !meta.description) continue;
        inner.effect(() =>
          inner.skills.register({
            name: meta.name,
            description: meta.description,
            content: m[2].trim(),
            resourceBase: { kind: "directory", path: skillDir },
            source: "custom",
          }),
        );
      } catch (e) {
        console.error(`[gemini-studio] 技能注册失败（${skillDir}）：${e.message}`);
      }
    }
  });

  // 面板一打开就要能看状态，所以插件激活时就把桥拉起来（失败不阻塞启动）
  ctx.effect(() => {
    ensureBridge().catch((e) => console.error(`[gemini-studio] 桥启动失败：${e.message}`));
  });
}
