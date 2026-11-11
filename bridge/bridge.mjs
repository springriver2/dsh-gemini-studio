#!/usr/bin/env node
/**
 * Gemini 网页版视频桥（多账号版）
 *
 * 每个账号 = 一个独立的 Chrome profile（各自登录一个 Google 账号），
 * 桥按「可用 + 最久未用」轮换，避免单个账号的 5 小时额度被打穿。
 *
 * 用法:
 *   node bridge.mjs                 # 起服务（默认 127.0.0.1:8787）
 *   node bridge.mjs add <名称>       # 新增账号：打开一个窗口让你登录
 *   node bridge.mjs list            # 看账号状态
 *   node bridge.mjs reset <id>      # 清除某账号的冷却
 *
 * HTTP:
 *   POST /generate  { prompt }        -> { id, account }
 *   GET  /task/:id                    -> { status, url?, error?, account? }
 *   GET  /media/:id.mp4
 *   GET  /accounts                    -> 账号列表与状态
 *   GET  /health
 */

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pause, clickElement, humanType, humanWarmup, assertNoChallenge, ChallengeError } from "./stealth.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const BASE_PORT = Number(process.env.CDP_BASE_PORT || 9333);
const COOLDOWN_MS = Number(process.env.COOLDOWN_HOURS || 5) * 3600_000;
const HOME = path.join(os.homedir(), ".gemini-video-bridge");
const PROFILE_ROOT = path.join(HOME, "profiles");
const OUT = path.join(HOME, "videos");
const STATE = path.join(HOME, "accounts.json");
const CHROME =
  process.env.CHROME_BIN ||
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "google-chrome");

fs.mkdirSync(PROFILE_ROOT, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- 账号

function loadAccounts() {
  if (fs.existsSync(STATE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE, "utf8"));
    } catch {}
  }
  const legacy = path.join(HOME, "chrome-profile");
  const dir = path.join(PROFILE_ROOT, "a1");
  if (fs.existsSync(legacy) && !fs.existsSync(dir)) fs.renameSync(legacy, dir);
  const accounts = [{ id: "a1", name: "账号 1", dir, port: BASE_PORT, blockedUntil: 0, lastUsedAt: 0 }];
  saveAccounts(accounts);
  return accounts;
}

function saveAccounts(accounts) {
  fs.writeFileSync(STATE, JSON.stringify(accounts, null, 2));
}

function accountDir(a) {
  return path.resolve(PROFILE_ROOT, a.dir || a.id);
}

/** 从 Chrome 的 Preferences 里读出这个 profile 登录的 Google 邮箱（不联网） */
function signedInEmail(a) {
  try {
    const prefs = path.join(accountDir(a), "Default", "Preferences");
    const j = JSON.parse(fs.readFileSync(prefs, "utf8"));
    return (j.account_info || []).map((x) => x.email).filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- CDP

async function cdpVersion(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
  return res.json();
}

async function ensureChrome(account) {
  const port = account.port;
  try {
    await cdpVersion(port);
    return;
  } catch {}
  log(`启动 Chrome（${account.name}, 端口 ${port}）…`);
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${accountDir(account)}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      // 直接开 Gemini，避免新账号停在一个空白页不知道下一步做什么
      "https://gemini.google.com/app?hl=zh-CN",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      await cdpVersion(port);
      return;
    } catch {}
  }
  throw new Error(`Chrome 启动超时（${account.name}）`);
}

/** 新账号/掉登录时，把窗口导航到 Gemini 的对话页，方便用户直接登录 */
async function openLoginPage(account) {
  try {
    await ensureChrome(account);
    const session = await Session.open(account.port);
    try {
      const url = await session.evaluate("location.href");
      if (!/gemini\.google\.com/.test(url)) {
        await session.goto("https://gemini.google.com/app?hl=zh-CN");
      }
    } finally {
      session.close();
    }
  } catch (e) {
    log(`打开登录页失败：${e.message}`);
  }
}

async function pageTarget(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return (
    list.filter((t) => t.type === "page").find((t) => t.url.includes("gemini.google.com")) ||
    list.find((t) => t.type === "page") ||
    null
  );
}

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`CDP 超时：${label}`)), ms))]);

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
  }

  static async open(port) {
    const t = await pageTarget(port);
    if (!t) throw new Error("找不到可用的浏览器标签页");
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("CDP 连接失败"));
    });
    const s = new Session(ws);
    s.images = new Map();
    s.handlers = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method) {
        const cbs = s.handlers.get(m.method);
        if (cbs) for (const cb of cbs) cb(m.params);
      }
      if (m.method === "Network.responseReceived") {
        const r = m.params.response;
        if (/lh3\.googleusercontent\.com/.test(r.url) && /image\//.test(r.mimeType || "")) {
          s.images.set(m.params.requestId, r.url);
        }
        return;
      }
      const p = s.pending.get(m.id);
      if (!p) return;
      s.pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    };
    await s.send("Page.enable");
    // 不开 Runtime.enable：Runtime.evaluate 不需要它，开了反而留下可被页面探测的痕迹
    await s.send("Network.enable", {});
    return s;
  }

  send(method, params = {}) {
    const p = new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    return withTimeout(p, 30000, method);
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  goto(url) {
    return this.send("Page.navigate", { url });
  }

  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
    return () => {
      const list = this.handlers.get(method) || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/** 调试用：把当前页面截图存到 OUT，仅在 SHOT_BEFORE_SEND=1 时调用 */
async function debugShot(session, tag) {
  try {
    const { data } = await session.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, `debug_${tag}_${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    log(`  截图 ${file}`);
  } catch (e) {
    log(`  截图失败 ${e.message}`);
  }
}

async function waitFor(session, expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await session.evaluate(expr)) return true;
    } catch {}
    await sleep(700);
  }
  throw new Error(`等待超时：${label}`);
}

// ---------------------------------------------------------------- 页面动作

// macOS：Chrome 的原生文件选择框用 AppleScript 代填路径。
// 前提是宿主进程有「辅助功能」权限（已在本机验证过）。
function runOsascript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `osascript exit ${code}`))));
  });
}

async function typePathInOpenDialog(filePath) {
  const escaped = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
tell application "Google Chrome" to activate
delay 0.8
tell application "System Events"
  keystroke "g" using {command down, shift down}
  delay 1.0
  keystroke "${escaped}"
  delay 0.8
  key code 36
  delay 1.0
  key code 36
end tell`.trim();
  await runOsascript(script);
}

async function hasAttachment(session) {
  try {
    return await session.evaluate(`(() => {
      const blob = [...document.querySelectorAll("img")].some((i) => (i.src || "").startsWith("blob:"));
      const chip = [...document.querySelectorAll("button,[role='button']")]
        .some((b) => /移除|remove|删除.{0,4}(图片|附件)/.test(b.getAttribute("aria-label") || ""));
      return blob || chip;
    })()`);
  } catch {
    return false;
  }
}

async function attachImage(session, filePath) {
  const fs = await import("node:fs");
  const buf = fs.readFileSync(filePath);
  const mime = /\.jpe?g$/i.test(filePath) ? "image/jpeg" : "image/png";
  // 拖放目标优先用 Gemini 自己的 dropzone（xapfileselectordropzone），
  // 只丢到 .ql-editor 上在部分版本里不再被接收。
  try {
    await session.send("Page.bringToFront");
  } catch {}
  const box = JSON.parse(
    await session.evaluate(`(() => {
      const el = document.querySelector("[xapfileselectordropzone]") ||
                 document.querySelector(".ql-editor")?.closest("fieldset") ||
                 document.querySelector(".ql-editor");
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`),
  );
  try {
    await session.send("Page.bringToFront").catch(() => {});
    await clickElement(
      session,
      `[...document.querySelectorAll("button")].find(x => /上传和工具/.test(x.getAttribute("aria-label") || ""))`,
      "工具按钮",
    );
    const hasMenu = await waitFor(
      session,
      `!!([...document.querySelectorAll("[role='menuitem'],[role='menuitemcheckbox'],button")]
        .find(x => /上传文件/.test((x.innerText || "") + (x.getAttribute("aria-label") || ""))))`,
      2000,
      "上传文件菜单项",
    ).then(() => true).catch(() => false);
    if (hasMenu) {
      await pause(300, 600);
      await clickElement(
        session,
        `[...document.querySelectorAll("[role='menuitem'],[role='menuitemcheckbox'],button")].find(x => /上传文件/.test((x.innerText || "") + (x.getAttribute("aria-label") || "")))`,
        "上传文件",
      );
    }
    await pause(700, 1100);
    await typePathInOpenDialog(filePath);
    await pause(2500, 3500);
    if (await hasAttachment(session)) {
      log("  首帧已挂上（文件框代填）");
      return;
    }
    log("  文件框代填后没看到缩略图，回退拖放");
  } catch (e) {
    log(`  文件框代填失败：${e.message}`);
  }

  const data = {
    items: [{ mimeType: mime, data: buf.toString("base64"), title: "frame.png" }],
    files: [filePath],
    dragOperationsMask: 1,
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await session.send("Input.dispatchDragEvent", { type, x: box.x, y: box.y, data });
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 3500));
    const ok = await hasAttachment(session);
    if (ok) return;
    log(`  挂图重试 ${attempt}`);
  }
  throw new Error("首帧图挂载失败");
}

async function setAspect(session, ratio) {
  const want = ratio === "9:16" ? "纵向" : ratio === "1:1" ? "方形" : "横向";
  const chip = `document.querySelector("input-companion-chip button") || [...document.querySelectorAll("button")].find(x => /横向|纵向|方形/.test(x.textContent || ""))`;
  const cur = await session.evaluate(
    `(() => { const b = ${chip}; return b ? (b.textContent || "").replace(/\\s+/g, " ").trim() : ""; })()`,
  );
  if (!cur) return "no-chip";
  if (cur.startsWith(want)) return "already";

  await clickElement(session, chip, "画幅按钮");
  await pause(800, 1700);
  try {
    await clickElement(
      session,
      `[...document.querySelectorAll("[role='menuitemradio'],[role='option']")].find(o => (o.textContent || "").includes(${JSON.stringify(want)}))`,
      `画幅 ${want}`,
    );
    return "ok";
  } catch {
    return "no-option";
  }
}

async function startGeneration(session, prompt, imagePaths = [], aspect = "") {
  // 2026-11 起视频生成搬到了独立的 /videos 页面。
  // 聊天里那个「制作视频」入口还在，但走它只会得到「我只是一个语言模型」的文本回复。
  await session.goto("https://gemini.google.com/videos?hl=zh-CN");
  await humanWarmup(session);
  await assertNoChallenge(session);
  await waitFor(session, `!!document.querySelector(".ql-editor")`, 30000, "输入框就绪");

  if (imagePaths.length) {
    await attachImage(session, imagePaths[0]);
    await waitFor(session, `!!document.querySelector(".ql-editor")`, 20000, "输入框就绪（带图）");
  }

  if (aspect) {
    const r = await setAspect(session, aspect);
    log(`  画幅 ${aspect} -> ${r}`);
    if (r === "ok") await pause(600, 1400);
  }

  return typeAndSend(session, prompt);
}

class QuotaError extends Error {}

async function quotaHint(session) {
  try {
    return await session.evaluate(`(() => {
      const t = (document.querySelector("chat-window") && document.querySelector("chat-window").innerText) || "";
      return /无法生成|达到上限|次数已用完|稍后再试|额度重置|使用情况|创建更多视频|try again later|limit/i.test(t) ? t.slice(-200) : "";
    })()`);
  } catch {
    return "";
  }
}

async function newChat(session) {
  await session.goto("https://gemini.google.com/app?hl=zh-CN");
  await sleep(2500);
  await waitFor(session, `!!document.querySelector(".ql-editor")`, 30000, "输入框就绪");
}

async function typeAndSend(session, prompt) {
  const written = await humanType(session, prompt);
  if (!(written > 0)) throw new Error(`提示词写入失败：${written < 0 ? "no-editor" : "empty"}`);
  await pause(1000, 3400);
  await assertNoChallenge(session);

  if (activeSemi || process.env.SEMI_AUTO === "1") {
    log("  半自动：请在 Chrome 窗口里核对内容并点发送（最多等 10 分钟）");
    if (process.env.SHOT_BEFORE_SEND === "1") await debugShot(session, "before-send");
    await waitFor(session, `/\\/app\\/[0-9a-f]{8,}/.test(location.pathname)`, 600000, "人工点发送");
  } else {
    if (process.env.SHOT_BEFORE_SEND === "1") await debugShot(session, "before-send");
    await clickElement(
      session,
      `[...document.querySelectorAll("button")].find(x => /发送|Send/.test(x.getAttribute("aria-label") || "") && !x.disabled && x.offsetWidth > 0)`,
      "发送按钮",
    );
  }

  await pause(2600, 5200);
  await waitFor(session, `/\\/app\\/[0-9a-f]{8,}/.test(location.pathname)`, 60000, "会话创建");
  const href = await session.evaluate("location.href");
  return `c_${(href.match(/\/app\/([0-9a-f]{8,})/) || [])[1]}`;
}

// 两个页面的「加号」不是同一个控件：/app 叫「上传和工具」，/videos 叫「添加文件」。
const TOOLS_BUTTON = `[...document.querySelectorAll("button")].filter((b) => b.offsetWidth)
  .find((x) => /上传和工具|添加文件|上传文件|add file/i.test(x.getAttribute("aria-label") || ""))`;

const menuItem = (label) => `[...document.querySelectorAll("[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio'],button")]
  .filter((e) => e.offsetWidth)
  .find((x) => new RegExp("^" + ${JSON.stringify(label)}).test(((x.getAttribute("aria-label") || "") + " " + (x.innerText || "")).replace(/\s+/g, " ").trim()))`;

async function pressEscape(session) {
  try {
    await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  } catch {}
}

/** 点加号，确认菜单真的弹出来了 */
async function openToolsMenu(session) {
  for (let i = 0; i < 3; i++) {
    try {
      await waitFor(session, `!!(${TOOLS_BUTTON})`, 12000, "加号按钮");
      await clickElement(session, TOOLS_BUTTON, "加号按钮");
      await pause(700, 1400);
      const opened = await session.evaluate(
        `document.querySelectorAll("[role='menuitem'],[role='menuitemcheckbox']").length > 0 || !!document.querySelector("[role='menu']")`,
      );
      if (opened) return true;
    } catch {}
    await pause(600, 1200);
  }
  return false;
}

async function pickTool(session, label) {
  const opened = await openToolsMenu(session);
  if (!opened) {
    throw new Error("菜单没弹出来：点了加号但没出现菜单。页面可能还在加载或被浮层挡住，等几秒重试一次即可（不要连续重试）");
  }
  const has = await waitFor(session, `!!(${menuItem(label)})`, 6000, label)
    .then(() => true)
    .catch(() => false);
  if (!has) {
    await pressEscape(session);
    throw new Error(`当前页面没有「${label}」入口`);
  }
  await clickElement(session, menuItem(label), label);
}

/** 图片入口在两个页面都可能存在：先在 /app 找，找不到换 /videos */
async function ensureImageSurface(session) {
  const surfaces = ["https://gemini.google.com/app?hl=zh-CN", "https://gemini.google.com/videos?hl=zh-CN"];
  for (const url of surfaces) {
    await session.goto(url);
    await pause(1600, 2600);
    try {
      await waitFor(session, `!!document.querySelector(".ql-editor")`, 30000, "输入框就绪");
    } catch {
      continue;
    }
    const opened = await openToolsMenu(session);
    if (!opened) continue;
    const has = await waitFor(session, `!!(${menuItem("制作图片")})`, 3500, "制作图片")
      .then(() => true)
      .catch(() => false);
    await pressEscape(session);
    if (has) {
      log(`  图片入口在 ${url.includes("/videos") ? "/videos" : "/app"}`);
      return url;
    }
  }
  throw new QuotaError("这个账号没有「制作图片」入口：额度用尽或账号被限制。换账号或等冷却，不要重试");
}

async function runText(session, messages, timeoutMs) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  if (!lastUser.trim()) throw new Error("没有可发送的用户消息");

  const key = threadKey(messages);
  const known = textThreads.get(key);
  let cid;

  if (known) {
    await session.goto(`https://gemini.google.com/app/${known.slice(2)}?hl=zh-CN`);
    await sleep(3500);
    await waitFor(session, `!!document.querySelector(".ql-editor")`, 30000, "输入框就绪（续聊）");
    cid = await typeAndSend(session, lastUser);
    log(`  续聊 ${known}（第 ${messages.filter((m) => m.role === "user").length} 轮）`);
  } else {
    await newChat(session);
    cid = await typeAndSend(session, lastUser);
    textThreads.set(key, cid);
    if (textThreads.size > 200) textThreads.delete(textThreads.keys().next().value);
    log(`  新会话 ${cid}`);
  }

  const deadline = Date.now() + timeoutMs;
  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    const text = await session.evaluate(`(() => {
      const els = [...document.querySelectorAll("model-response")];
      const el = els[els.length - 1];
      return el ? el.innerText.trim() : "";
    })()`);
    if (text && text === last) stable++;
    else stable = 0;
    last = text || last;
    if (last && stable >= 2) return last.replace(/^Gemini\s*说\s*/, "").trim();
    await sleep(2500);
  }
  if (last) return last.replace(/^Gemini\s*说\s*/, "").trim();
  throw new Error("等待文本回复超时");
}

async function waitImageUrl(session, cid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let raw = "";
    try {
      raw = await session.evaluate(`(async () => {
        const at = window.WIZ_global_data && window.WIZ_global_data.SNlM0e;
        if (!at) return "";
        const freq = JSON.stringify([[["hNvQHb", JSON.stringify([${JSON.stringify(cid)},10,null,1,[0],[4],null,1]), null, "generic"]]]);
        const res = await fetch("/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=" + encodeURIComponent("/app/" + ${JSON.stringify(cid)}.slice(2)) + "&hl=zh-CN&rt=c", {
          method: "POST", body: new URLSearchParams({ "f.req": freq, at }), credentials: "include",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
        });
        return await res.text();
      })()`);
    } catch {}
    if (raw && raw.length > 100) {
      const json = firstJson(raw.split(")]}'")[1] || "");
      if (json) {
        try {
          const outer = JSON.parse(json);
          const chunk = (Array.isArray(outer) ? outer : []).find((c) => Array.isArray(c) && c[0] === "wrb.fr" && c[1] === "hNvQHb");
          if (chunk) {
            const found = [];
            const walk = (x) => {
              if (typeof x === "string") {
                if (x.includes("lh3.googleusercontent.com/gg/")) found.push(x);
              } else if (Array.isArray(x)) x.forEach(walk);
              else if (x && typeof x === "object") Object.values(x).forEach(walk);
            };
            walk(JSON.parse(chunk[2]));
            if (found.length) return found[found.length - 1];
          }
        } catch {}
      }
    }
    const hint = await quotaHint(session);
    if (hint) throw new QuotaError(hint);
    await sleep(4000);
  }
  throw new Error("等待图片生成超时");
}

/** 把 dataURL 或 http 图片落到本地临时文件，返回路径 */
async function materializeImages(list, prefix = "ref") {
  const paths = [];
  for (const [i, item] of (Array.isArray(list) ? list : []).slice(0, 1).entries()) {
    if (typeof item !== "string") continue;
    try {
      if (item.startsWith("data:")) {
        const m = item.match(/^data:(image\/[a-z+]+);base64,(.*)$/i);
        if (!m) continue;
        const file = path.join(OUT, `${prefix}_${Date.now()}_${i}.${m[1].includes("jpeg") ? "jpg" : "png"}`);
        fs.writeFileSync(file, Buffer.from(m[2], "base64"));
        paths.push(file);
      } else if (/^https?:\/\//i.test(item)) {
        const res = await fetch(item, { headers: { accept: "image/*" }, redirect: "follow" });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100) continue;
        const file = path.join(OUT, `${prefix}_${Date.now()}_${i}.png`);
        fs.writeFileSync(file, buf);
        paths.push(file);
      }
    } catch {}
  }
  return paths;
}

async function runImage(session, prompt, timeoutMs, imagePaths = []) {
  await ensureImageSurface(session);
  if (imagePaths.length) {
    await attachImage(session, imagePaths[0]);
    await waitFor(session, `!!document.querySelector(".ql-editor")`, 20000, "输入框就绪（带参考图）");
  }
  await pickTool(session, "制作图片");
  await pause(1200, 2400);
  const cid = await typeAndSend(session, prompt);

  // 出图后页面把结果放在 blob: URL 里（不再是 lh3），等那张大图出现
  const deadline = Date.now() + timeoutMs;
  let dims = null;
  while (Date.now() < deadline) {
    const got = await session.evaluate(`(() => {
      const imgs = [...document.querySelectorAll("img")].filter(i =>
        ((i.src || "").startsWith("blob:") || /lh3\\.googleusercontent\\.com\\/(gg|a)\\//.test(i.src || "")) && i.naturalWidth >= 256);
      const el = imgs[imgs.length - 1];
      return el ? JSON.stringify({ w: el.naturalWidth, h: el.naturalHeight }) : "";
    })()`);
    if (got) {
      dims = JSON.parse(got);
      break;
    }
    await sleep(3000);
  }
  if (!dims) {
    const hint = await quotaHint(session);
    if (hint) throw new QuotaError(hint);
    throw new Error("等待图片生成超时");
  }

  // blob 不能直连下载：画到 canvas 上取像素（同源的 blob 不会污染画布）
  const b64 = await session.evaluate(`(() => {
    const imgs = [...document.querySelectorAll("img")].filter(i =>
      ((i.src || "").startsWith("blob:") || /lh3\\.googleusercontent\\.com\\/(gg|a)\\//.test(i.src || "")) && i.naturalWidth >= 256);
    const img = imgs[imgs.length - 1];
    if (!img) return "";
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/png").split(",")[1] || "";
  })()`);
  if (!b64) throw new Error("取图失败：canvas 没拿到像素");
  return { cid, bytes: Buffer.from(b64, "base64"), width: dims.w, height: dims.h };
}

/** 从 batchexecute 响应里切出第一段 JSON（响应是「长度\nJSON」多段拼接） */
function firstJson(s) {
  const i = s.indexOf("[");
  if (i < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return s.slice(i, j + 1);
    }
  }
  return null;
}

async function waitVideoUrl(session, cid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let dead = 0;
  while (Date.now() < deadline) {
    // 新版视频页出片后直接把 <video> 挂进 DOM，先看这个，比 RPC 稳
    try {
      const dom = await session.evaluate(
        `(() => { const v = document.querySelector("video"); return v ? (v.currentSrc || v.src || "") : ""; })()`,
      );
      dead = 0;
      if (dom && dom.startsWith("http")) return dom;
    } catch {
      if (++dead >= 5) throw new Error("CDP 连接已断开");
    }
    let raw = "";
    try {
      raw = await session.evaluate(`(async () => {
        const at = window.WIZ_global_data && window.WIZ_global_data.SNlM0e;
        if (!at) return "";
        const freq = JSON.stringify([[["hNvQHb", JSON.stringify([${JSON.stringify(cid)},10,null,1,[0],[4],null,1]), null, "generic"]]]);
        const body = new URLSearchParams({ "f.req": freq, at });
        const res = await fetch("/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=" + encodeURIComponent("/app/" + ${JSON.stringify(cid)}.slice(2)) + "&hl=zh-CN&rt=c", {
          method: "POST", body, credentials: "include",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
        });
        return await res.text();
      })()`);
    } catch {}
    if (raw && raw.length > 100) {
      const json = firstJson(raw.split(")]}'")[1] || "");
      if (json) {
        try {
          const outer = JSON.parse(json);
          const chunk = (Array.isArray(outer) ? outer : []).find(
            (c) => Array.isArray(c) && c[0] === "wrb.fr" && c[1] === "hNvQHb",
          );
          if (chunk) {
            const found = [];
            const walk = (x) => {
              if (typeof x === "string") {
                if (x.includes("contribution.usercontent.google.com/download")) found.push(x);
              } else if (Array.isArray(x)) x.forEach(walk);
              else if (x && typeof x === "object") Object.values(x).forEach(walk);
            };
            walk(JSON.parse(chunk[2]));
            const video = found.filter((u) => /[?&]filename=video\.mp4/.test(u));
            if (video.length) return video[video.length - 1];
          }
        } catch {}
      }
    }
    const hint = await quotaHint(session);
    if (hint) throw new QuotaError(hint);
    await sleep(4000);
  }
  throw new Error("等待视频生成超时");
}

async function cookieHeader(session) {
  const r = await session.send("Network.getAllCookies");
  const map = new Map();
  const score = (d) => (d === ".google.com" ? 3 : d === "gemini.google.com" ? 2 : 1);
  for (const c of r.cookies) {
    if (!/(^|\.)google\.com$/.test(c.domain)) continue;
    if (!/^(__Secure-|SID$|HSID$|SSID$|APISID$|SAPISID$|NID$|SIDCC$)/.test(c.name)) continue;
    const prev = map.get(c.name);
    if (!prev || score(c.domain) > score(prev.domain)) map.set(c.name, c);
  }
  return [...map.values()].map((c) => `${c.name}=${c.value}`).join("; ");
}

async function download(url, cookie, file) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { cookie, accept: "*/*", "accept-encoding": "identity" }, redirect: "follow" });
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 10000) throw new Error(`下载内容异常（${buf.length} 字节）`);
      fs.writeFileSync(file, buf);
      return buf.length;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2500 * attempt));
    }
  }
  throw lastErr;
}

async function downloadVideo(session, url, file) {
  const media = new URL(url);
  if (media.origin !== "https://contribution.usercontent.google.com" || media.pathname !== "/download") {
    throw new Error("Gemini 返回了无法识别的视频地址");
  }

  // Google serves this asset to the original Chrome session; Node's copied cookies can get 403.
  const { status, base64 } = await session.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(media.href)}, {
      credentials: "include",
      signal: AbortSignal.timeout(25000),
    });
    if (response.status !== 200) return { status: response.status };
    const blob = await response.blob();
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { status: response.status, base64: data.slice(data.indexOf(",") + 1) };
  })()`);
  if (status === 429) throw new QuotaError("视频下载失败 HTTP 429");
  if (status !== 200) throw new Error(`视频下载失败 HTTP ${status}`);

  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") {
    throw new Error("Gemini 下载响应不是 MP4 视频");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return bytes.length;
}

// ---------------------------------------------------------------- 调度

const tasks = new Map();
const busy = new Set();

/** 当前任务是否半自动（准备好一切，由人点发送） */
let activeSemi = false;

// 保守调度：同一时刻全局只跑一个账号，两次提交之间留 90–240 秒，每天每号有上限。
// 这是"最稳"和"最快"之间的取舍点，改这几个环境变量就能放开。
const MIN_GAP_MS = Number(process.env.MIN_GAP_SECONDS || 90) * 1000;
const DAILY_CAP = Number(process.env.DAILY_CAP || 8);
const today = () => new Date().toISOString().slice(0, 10);

function usedToday(a) {
  return a.day === today() ? a.count || 0 : 0;
}

function overDailyCap(a) {
  return usedToday(a) >= DAILY_CAP;
}

function pickAccount(accounts) {
  const now = Date.now();
  const usable = accounts.filter((a) => !busy.has(a.id) && (a.blockedUntil || 0) <= now && !overDailyCap(a));
  if (!usable.length) return null;
  usable.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
  return usable[0];
}

function markBlocked(id, { hard = false } = {}) {
  const accounts = loadAccounts();
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  // 正常额度冷却：5 小时 + 10–40 分钟随机，别卡着点重开
  a.blockedUntil = Date.now() + COOLDOWN_MS + Math.floor(Math.random() * 30 * 60000);
  if (hard) {
    a.blockedUntil = Date.now() + 7 * 24 * 3600_000;
    a.hardBlocked = true;
  }
  saveAccounts(accounts);
  log(`账号 ${a.name} 进入冷却，直到 ${new Date(a.blockedUntil).toLocaleString()}${hard ? "（需人工处理）" : ""}`);
}

function markUsed(id) {
  const accounts = loadAccounts();
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  a.lastUsedAt = Date.now();
  if (a.day !== today()) {
    a.day = today();
    a.count = 0;
  }
  a.count = (a.count || 0) + 1;
  saveAccounts(accounts);
}

async function runTask(task) {
  const account = loadAccounts().find((a) => a.id === task.accountId);
  let session;
  try {
    await ensureChrome(account);
    session = await Session.open(account.port);
    activeSemi = !!task.semi;
    log(`[${task.id}] ${account.name} 生成中：${task.prompt.slice(0, 26)}`);
    const cid = await startGeneration(session, task.prompt, task.imagePaths || [], task.aspect || "");
    task.conversation = cid;
    let url;
    try {
      url = await waitVideoUrl(session, cid, 10 * 60 * 1000);
    } catch (e) {
      if (!/CDP 连接已断开/.test(String(e?.message))) throw e;
      // 调试连接断了就重连一次，回到原会话接着等，别让任务白等
      log(`[${task.id}] 调试连接断开，重连后回到会话 ${cid}`);
      session?.close();
      session = await Session.open(account.port);
      await session.goto(`https://gemini.google.com/app/${cid.slice(2)}?hl=zh-CN`);
      await pause(2000, 3500);
      url = await waitVideoUrl(session, cid, 8 * 60 * 1000);
    }
    const file = path.join(OUT, `${task.id}.mp4`);
    const bytes = await downloadVideo(session, url, file);
    task.file = file;
    task.status = "completed";
    markUsed(account.id);
    log(`[${task.id}] 完成 ${(bytes / 1e6).toFixed(2)} MB（${account.name}）`);
  } catch (e) {
    let err = e;
    if (err instanceof ChallengeError) {
      // 掉登录 / 被要求验证：立刻停机，这个号等人来处理，绝不重试
      task.status = "failed";
      task.error = `${err.message}（已停机，请人工检查该账号）`;
      markBlocked(account.id, { hard: true });
      log(`[${task.id}] 停机：${task.error}`);
      return;
    }
    if (!(e instanceof QuotaError) && session) {
      const hint = await quotaHint(session);
      if (hint) err = new QuotaError(hint);
      else if (/制作视频|视频工具/.test(String(e?.message || ""))) err = new QuotaError("找不到视频入口，通常是该账号额度已用尽");
    }
    task.status = "failed";
    task.error = String(err?.message || err);
    if (err instanceof QuotaError) markBlocked(account.id);
    log(`[${task.id}] 失败：${task.error}`);
  } finally {
    busy.delete(account.id);
    activeSemi = false;
    session?.close();
    pump();
  }
}

// 全局串行：一次只让一个账号动，两次提交之间隔 MIN_GAP_MS + 随机尾巴。
let nextDispatchAt = 0;
let pumpTimer = null;

function pump() {
  if (busy.size > 0) return;
  if (pumpTimer) return;

  const wait = nextDispatchAt - Date.now();
  if (wait > 0) {
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump();
    }, Math.min(wait, 15000));
    return;
  }

  const t = [...tasks.values()].find((x) => x.status === "queued");
  if (!t) return;
  const pool = loadAccounts();
  const account = t.pinnedAccount ? pool.find((a) => a.id === t.pinnedAccount) : pickAccount(pool);
  if (!account) return;
  if (busy.has(account.id) || (account.blockedUntil || 0) > Date.now() || overDailyCap(account)) return;

  t.accountId = account.id;
  t.account = account.name;
  t.status = "running";
  busy.add(account.id);
  nextDispatchAt = Date.now() + MIN_GAP_MS + Math.floor(Math.random() * 150000);
  runTask(t).catch(() => {});
}

// ---------------------------------------------------------------- HTTP

function json(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-private-network": "true",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

function accountView() {
  const now = Date.now();
  return loadAccounts().map((a) => ({
    id: a.id,
    name: a.name,
    email: signedInEmail(a),
    busy: busy.has(a.id),
    blocked: (a.blockedUntil || 0) > now,
    hardBlocked: !!a.hardBlocked && (a.blockedUntil || 0) > now,
    blockedUntil: a.blockedUntil ? new Date(a.blockedUntil).toISOString() : null,
    lastUsedAt: a.lastUsedAt ? new Date(a.lastUsedAt).toISOString() : null,
    usedToday: usedToday(a),
    dailyCap: DAILY_CAP,
  }));
}

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Gemini 视频桥</title>
<style>
  body{margin:0;padding:24px;background:#0f1115;color:#e6e9ef;font:14px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif}
  h1{font-size:17px;margin:0 0 4px}
  .sub{color:#8b93a7;font-size:12px;margin-bottom:18px}
  table{border-collapse:collapse;width:100%;max-width:720px;font-size:13px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #262b36}
  th{color:#8b93a7;font-weight:500;font-size:12px}
  .ok{color:#2ecc71}.warn{color:#f5a623}.dim{color:#8b93a7}
  code{background:#171a21;padding:1px 5px;border-radius:4px;font-size:12px}
  ul{padding-left:18px;color:#cfd6e4;font-size:13px}
</style></head><body>
<h1>Gemini 视频桥</h1>
<div class="sub">本地服务 · 127.0.0.1:8787 · 用本机已登录的 Gemini 网页版账号生成视频</div>
<table><thead><tr><th>账号</th><th>状态</th><th>上次使用</th></tr></thead><tbody id="rows"><tr><td colspan="3" class="dim">读取中…</td></tr></tbody></table>
<h3 style="font-size:13px;margin:22px 0 6px">接口</h3>
<ul>
  <li><code>POST /generate</code> { prompt } → { id }</li>
  <li><code>GET /task/:id</code> → { status, url }</li>
  <li><code>GET /accounts</code> · <code>POST /accounts/:id/reset</code> · <code>GET /health</code></li>
</ul>
<script>
fetch("/accounts").then(r=>r.json()).then(d=>{
  const tb=document.getElementById("rows");
  if(!d.accounts.length){tb.innerHTML='<tr><td colspan="3" class="dim">还没有账号，运行 node bridge.mjs add 名称</td></tr>';return}
  tb.innerHTML=d.accounts.map(a=>{
    const st=a.busy?'<span class="warn">生成中</span>':a.blocked?('<span class="warn">冷却至 '+new Date(a.blockedUntil).toLocaleTimeString()+'</span>'):'<span class="ok">可用</span>';
    return '<tr><td>'+a.name+' <span class="dim">'+a.id+'</span></td><td>'+st+'</td><td class="dim">'+(a.lastUsedAt?new Date(a.lastUsedAt).toLocaleString():'—')+'</td></tr>';
  }).join('');
}).catch(()=>{document.getElementById("rows").innerHTML='<tr><td colspan="3" class="warn">读取失败</td></tr>'});
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // 兼容 OpenAI 风格 baseUrl 自动补的 /v1 前缀
  const route = url.pathname.replace(/^\/v1(?=\/)/, "");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-private-network": "true",
    });
    return res.end();
  }

  if (route === "/" || route === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" });
    return res.end(INDEX_HTML);
  }

  if (route === "/health") {
    const accounts = accountView();
    return json(res, 200, {
      ok: true,
      accounts: accounts.length,
      available: accounts.filter((a) => !a.blocked && !a.busy).length,
    });
  }

  // 体检：打开页面看登录/界面/入口是否都正常，不提交任何生成请求
  if (route === "/doctor" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    const accounts = loadAccounts();
    const account = body.account ? accounts.find((a) => a.id === body.account || a.name === body.account) : accounts[0];
    if (!account) return json(res, 404, { error: "账号不存在" });
    if (busy.has(account.id)) return json(res, 409, { error: "该账号正在生成，稍后再检查" });

    busy.add(account.id);
    let session;
    const report = {
      account: { id: account.id, name: account.name, email: signedInEmail(account) },
      usage: { today: usedToday(account), cap: DAILY_CAP },
      checks: {},
      ok: false,
    };
    try {
      await ensureChrome(account);
      session = await Session.open(account.port);
      await session.goto("https://gemini.google.com/videos?hl=zh-CN");
      await pause(1500, 3200);
      report.url = await session.evaluate("location.href");
      report.checks.loggedIn = !/accounts\.google\.com|\/signin/.test(report.url);
      await waitFor(session, `!!document.querySelector(".ql-editor")`, 30000, "输入框就绪");
      report.checks.editor = true;

      report.checks.aspect = await waitFor(
        session,
        `!!(document.querySelector("input-companion-chip button") || [...document.querySelectorAll("button")].find(x => /横向|纵向|方形/.test(x.textContent || "")))`,
        20000,
        "画幅按钮",
      )
        .then(() => true)
        .catch(() => false);

      const quota = await quotaHint(session);
      if (quota) report.checks.quota = quota.slice(0, 160);
      await assertNoChallenge(session);
      report.ok = report.checks.loggedIn && report.checks.editor && report.checks.aspect;
    } catch (e) {
      report.error = String(e?.message || e);
    } finally {
      session?.close();
      busy.delete(account.id);
    }
    return json(res, 200, report);
  }

  // 把已有会话里的视频重新取一遍：不生成、不消耗额度，用来验证等待和下载链路
  if (route === "/replay" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    const accounts = loadAccounts();
    const account = body.account ? accounts.find((a) => a.id === body.account || a.name === body.account) : accounts[0];
    const cid = String(body.cid || "").replace(/^c_/, "");
    if (!account) return json(res, 404, { error: "账号不存在" });
    if (!/^[0-9a-f]{8,}$/.test(cid)) return json(res, 400, { error: "cid 不合法" });
    busy.add(account.id);
    let session;
    try {
      await ensureChrome(account);
      session = await Session.open(account.port);
      await session.goto(`https://gemini.google.com/app/${cid}?hl=zh-CN`);
      await pause(2500, 4000);
      const url = await waitVideoUrl(session, `c_${cid}`, 90000);
      const file = path.join(OUT, `replay_${cid.slice(0, 8)}.mp4`);
      const bytes = await downloadVideo(session, url, file);
      return json(res, 200, { cid, url, file, bytes });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e), cid });
    } finally {
      session?.close();
      busy.delete(account.id);
    }
  }

  if (route === "/accounts" && req.method === "GET") return json(res, 200, { accounts: accountView() });

  const resetMatch = route.match(/^\/accounts\/([\w-]+)\/reset$/);
  if (resetMatch && req.method === "POST") {
    const accounts = loadAccounts();
    const a = accounts.find((x) => x.id === resetMatch[1]);
    if (!a) return json(res, 404, { error: "账号不存在" });
    a.blockedUntil = 0;
    saveAccounts(accounts);
    return json(res, 200, { ok: true });
  }

  if (route === "/accounts" && req.method === "POST") {
    const body = await readJson(req);
    const accounts = loadAccounts();
    const id = `a${accounts.length + 1}`;
    const account = {
      id,
      name: String(body.name || `账号 ${accounts.length + 1}`).trim(),
      dir: path.join(PROFILE_ROOT, id),
      port: BASE_PORT + accounts.length,
      blockedUntil: 0,
      lastUsedAt: 0,
    };
    accounts.push(account);
    saveAccounts(accounts);
    openLoginPage(account);
    return json(res, 200, { account: accountView().find((a) => a.id === id) });
  }

  const accountMatch = route.match(/^\/accounts\/([\w-]+)$/);
  if (accountMatch && req.method === "DELETE") {
    const accounts = loadAccounts();
    const idx = accounts.findIndex((a) => a.id === accountMatch[1]);
    if (idx < 0) return json(res, 404, { error: "账号不存在" });
    if (accounts.length <= 1) return json(res, 400, { error: "至少要保留一个账号" });
    accounts.splice(idx, 1);
    saveAccounts(accounts);
    return json(res, 200, { ok: true });
  }

  if ((route === "/generate-text" || route === "/generate-image") && req.method === "POST") {
    const body = await readJson(req);
    const prompt = String(body.prompt || "").trim();
    const hasMessages = Array.isArray(body.messages) && body.messages.length > 0;
    if (!prompt && !hasMessages) return json(res, 400, { error: "prompt 或 messages 不能为空" });
    const accounts = loadAccounts();
    const account = pickAccount(accounts);
    if (!account) return json(res, 429, { error: "所有 Gemini 账号都在冷却或被占用" });
    busy.add(account.id);
    let session;
    try {
      await ensureChrome(account);
      session = await Session.open(account.port);
      if (route === "/generate-text") {
        const messages = Array.isArray(body.messages) ? body.messages : [{ role: "user", content: prompt }];
        const text = await runText(session, messages, 180000);
        markUsed(account.id);
        return json(res, 200, { text, account: account.name });
      }
      const refPaths = await materializeImages(body.images, "ref");
      const shot = await runImage(session, prompt, 300000, refPaths);
      markUsed(account.id);
      const id = `img_${Date.now()}`;
      const file = path.join(OUT, `${id}.png`);
      fs.writeFileSync(file, shot.bytes);
      log(`  出图 ${shot.width}x${shot.height} ${(shot.bytes.length / 1024).toFixed(0)} KB`);
      return json(res, 200, {
        id,
        file,
        bytes: shot.bytes.length,
        width: shot.width,
        height: shot.height,
        url: `http://127.0.0.1:${PORT}/media/${id}.png`,
        account: account.name,
      });
    } catch (e) {
      let err = e;
      if (!(e instanceof QuotaError) && session) {
        const hint = await quotaHint(session);
        if (hint) err = new QuotaError(hint);
      }
      if (err instanceof QuotaError) markBlocked(account.id);
      return json(res, 500, { error: String(err?.message || err) });
    } finally {
      busy.delete(account.id);
      session?.close();
    }
  }

  const imgMatch = route.match(/^\/media\/([\w-]+)\.png$/);
  if (imgMatch) {
    const f = path.join(OUT, `${imgMatch[1]}.png`);
    if (!fs.existsSync(f)) return json(res, 404, { error: "文件不存在" });
    res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
    return fs.createReadStream(f).pipe(res);
  }

  if (route === "/generate" && req.method === "POST") {
    const body = await readJson(req);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return json(res, 400, { error: "prompt 不能为空" });
    const imagePaths = await materializeImages(body.images, "in");

    let pinnedAccount = null;
    if (body.account) {
      const pinned = loadAccounts().find((a) => a.id === body.account || a.name === body.account);
      if (!pinned) return json(res, 404, { error: "账号不存在" });
      if (busy.has(pinned.id)) return json(res, 409, { error: "该账号正在生成" });
      if ((pinned.blockedUntil || 0) > Date.now()) return json(res, 429, { error: "该账号在冷却中" });
      if (overDailyCap(pinned)) return json(res, 429, { error: `该账号今天已达上限（${DAILY_CAP}）` });
      pinnedAccount = pinned.id;
    } else if (!pickAccount(loadAccounts())) {
      return json(res, 429, { error: "所有 Gemini 账号都在冷却或被占用", accounts: accountView() });
    }

    const id = Math.random().toString(36).slice(2, 10);
    const task = {
      id,
      prompt,
      imagePaths,
      aspect: String(body.aspect || ""),
      pinnedAccount,
      semi: body.semi === true,
      status: "queued",
      createdAt: Date.now(),
    };
    tasks.set(id, task);
    pump();
    return json(res, 200, { id, status: task.status, account: task.account || null, semi: task.semi });
  }

  const taskMatch = route.match(/^\/task\/([\w-]+)$/);
  if (taskMatch) {
    const t = tasks.get(taskMatch[1]);
    if (!t) return json(res, 404, { error: "任务不存在" });
    return json(res, 200, {
      id: t.id,
      status: t.status,
      account: t.account || null,
      error: t.error || null,
      url: t.file ? `http://127.0.0.1:${PORT}/media/${t.id}.mp4` : null,
    });
  }

  const mediaMatch = route.match(/^\/media\/([\w-]+)\.mp4$/);
  if (mediaMatch) {
    const t = tasks.get(mediaMatch[1]);
    if (!t?.file || !fs.existsSync(t.file)) return json(res, 404, { error: "文件不存在" });
    const stat = fs.statSync(t.file);
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": stat.size,
      "access-control-allow-origin": "*",
    });
    return fs.createReadStream(t.file).pipe(res);
  }

  json(res, 404, { error: "not found" });
});

// ---------------------------------------------------------------- CLI

const [cmd, arg] = process.argv.slice(2);

if (cmd === "list") {
  console.table(accountView());
} else if (cmd === "add") {
  const accounts = loadAccounts();
  const id = `a${accounts.length + 1}`;
  const account = {
    id,
    name: arg || `账号 ${accounts.length + 1}`,
    dir: path.join(PROFILE_ROOT, id),
    port: BASE_PORT + accounts.length,
    blockedUntil: 0,
    lastUsedAt: 0,
  };
  accounts.push(account);
  saveAccounts(accounts);
  await ensureChrome(account);
  console.log(`已创建 ${account.name}：${accountDir(account)}`);
  console.log("在刚打开的窗口登录 Google 账号，打开 https://gemini.google.com 确认能看到对话框。");
  console.log("确认后直接关掉窗口即可，桥在需要时会自动拉起。");
} else if (cmd === "check") {
  const args = process.argv.slice(3);
  const outIndex = args.indexOf("--out");
  const file = outIndex === -1 ? path.join(OUT, "check.mp4") : args[outIndex + 1];
  if (!file) throw new Error("--out 缺少文件路径");
  const account = loadAccounts()[0];
  await ensureChrome(account);
  const session = await Session.open(account.port);
  try {
    const cid = (arg === "--out" ? null : arg) || (await session.evaluate("location.href")).match(/\/app\/([0-9a-f]{8,})/)?.[1];
    if (!cid) throw new Error("请在账号 1 的 Chrome 窗口打开要恢复的 Gemini 会话");
    const url = await waitVideoUrl(session, cid.startsWith("c_") ? cid : `c_${cid}`, 90000);
    const bytes = await downloadVideo(session, url, file);
    console.log("OK", (bytes / 1e6).toFixed(2), "MB ->", file);
  } finally {
    session.close();
  }
} else if (cmd === "reset") {
  const accounts = loadAccounts();
  const a = accounts.find((x) => x.id === arg);
  if (!a) {
    console.error("没有这个账号：", arg);
  } else {
    a.blockedUntil = 0;
    saveAccounts(accounts);
    console.log(`已解除 ${a.name} 的冷却`);
  }
} else {
  server.listen(PORT, "127.0.0.1", () => {
    log(`Gemini 视频桥: http://127.0.0.1:${PORT}`);
    log(`账号: ${loadAccounts().map((a) => a.name).join(", ")}`);
    log(`新增账号: node bridge.mjs add <名称>`);
  });
}
