/**
 * 低特征交互层
 *
 * 目标：让"脚本操作页面"尽量接近"人手操作页面"。
 * 四条原则：
 *   1. 点击走 CDP Input.dispatchMouseEvent（事件 isTrusted = true），不用 element.click()
 *   2. 输入走 CDP Input.insertText 分段写入，字间带抖动
 *   3. 等待一律带随机抖动，不用固定 sleep
 *   4. 一旦出现验证 / 登录 / 异常流量页面，立刻抛 ChallengeError，由上层停机
 *
 * 注意：这只能降低被判定为自动化的概率，不能消除风险。
 */

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 随机停顿 */
export const pause = (min, max) => sleep(rand(min, max));

/** 页面出现了不该出现的东西：验证、异常流量、掉登录 */
export class ChallengeError extends Error {
  constructor(reason) {
    super(`风控信号：${reason}`);
    this.name = "ChallengeError";
    this.code = "challenge";
  }
}

/** 鼠标上次落点，避免每次都从屏幕角落瞬移过去 */
const pointers = new WeakMap();

const pointerOf = (session) => {
  let p = pointers.get(session);
  if (!p) {
    p = { x: rand(30, 160), y: rand(30, 160) };
    pointers.set(session, p);
  }
  return p;
};

async function moveMouse(session, x, y) {
  const from = pointerOf(session);
  const steps = rand(2, 4);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const nx = Math.round(from.x + (x - from.x) * t + (Math.random() - 0.5) * 10);
    const ny = Math.round(from.y + (y - from.y) * t + (Math.random() - 0.5) * 10);
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: nx,
      y: ny,
      button: "none",
      buttons: 0,
    });
    await sleep(rand(16, 60));
  }
  pointers.set(session, { x, y });
}

/** 在视口坐标上做一次真实鼠标点击 */
export async function clickAt(session, x, y) {
  await moveMouse(session, x, y);
  await sleep(rand(60, 210));
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(rand(45, 130));
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  pointers.set(session, { x, y });
  return true;
}

/**
 * 找到元素 → 滚到视口中间 → 取其真实矩形 → 用可信鼠标事件点它。
 * expr 是一段返回 DOM 元素的 JS 表达式。
 */
export async function clickElement(session, expr, label = "元素") {
  const raw = await session.evaluate(`(() => {
    const el = (${expr});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return JSON.stringify({
      x: Math.round(r.x + r.width * (0.35 + Math.random() * 0.3)),
      y: Math.round(r.y + r.height * (0.35 + Math.random() * 0.3)),
    });
  })()`);
  if (!raw) throw new Error(`找不到可点击的${label}`);
  const { x, y } = JSON.parse(raw);
  await pause(140, 480);
  await clickAt(session, x, y);
  return true;
}

/** 把文本切成 2–5 个字一块，别整段灌进去 */
function chunks(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + rand(2, 5));
    // 别把代理对劈开
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end = Math.min(text.length, end + 1);
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * 像人一样把话打进去：先聚焦、光标移到末尾，再分段 insertText。
 * 返回写入后的文本长度，上层用它判断是否真的写进去了。
 */
export async function humanType(session, text) {
  await session.evaluate(`(() => {
    const ed = document.querySelector(".ql-editor");
    if (!ed) return;
    ed.focus();
    const sel = getSelection();
    sel.selectAllChildren(ed);
    sel.collapseToEnd();
  })()`);
  await pause(240, 720);

  for (const chunk of chunks(String(text))) {
    await session.send("Input.insertText", { text: chunk });
    await sleep(rand(45, 135));
    if (Math.random() < 0.07) await pause(320, 900);
    if (Math.random() < 0.02) await pause(1200, 2600);
  }

  return session.evaluate(
    `(() => { const ed = document.querySelector(".ql-editor"); return ed ? ed.innerText.trim().length : -1; })()`,
  );
}

/** 页面打开后先随便动一动，别一上来就直奔目标 */
export async function humanWarmup(session) {
  await pause(800, 2400);
  const x = rand(180, 640);
  const y = rand(180, 520);
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY: rand(80, 220),
  });
  await pause(400, 1200);
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY: -rand(50, 150),
  });
  await pause(300, 900);
}

const CHALLENGE_URL = /accounts\.google\.com|\/sorry\/|\/v2\/signin|consent\.google/i;
const CHALLENGE_TEXT =
  /确认是你本人|验证你的身份|异常流量|unusual traffic|不是机器人|无法验证此账号|verify it'?s you|choose an account|选择账号|重新登录/i;

/**
 * 检查页面是否掉登录 / 被要求验证。
 * 命中就抛 ChallengeError —— 上层必须停机，绝不可重试。
 */
export async function assertNoChallenge(session) {
  const raw = await session.evaluate(
    `JSON.stringify({ url: location.href, text: ((document.body && document.body.innerText) || "").slice(0, 2500) })`,
  );
  const { url, text } = JSON.parse(raw);
  if (CHALLENGE_URL.test(url)) throw new ChallengeError(url.slice(0, 140));
  const hit = CHALLENGE_TEXT.exec(text || "");
  if (hit) throw new ChallengeError(hit[0]);
  return true;
}
