import fs from "node:fs";
import path from "node:path";
import { bridgeModes, projectFile, projectOutput, requireValue, writeAtomic } from "./project.mjs";
import { attachMedia, begin, fail, markSubmitted, markSubmitting, planTask, recordPreparedTask } from "./tasks.mjs";

function bridgeUrl() {
  const port = Number(process.env.BRIDGE_PORT ?? 8787);
  requireValue(Number.isInteger(port) && port > 0 && port <= 65535, "BRIDGE_PORT 无效");
  return `http://127.0.0.1:${port}`;
}

async function request(route, options) {
  return fetch(bridgeUrl() + route, {
    ...options, redirect: "error", signal: AbortSignal.timeout(30000),
  });
}

export async function accounts() {
  const response = await request("/accounts");
  requireValue(response.ok, `桥的账号查询失败 HTTP ${response.status}`);
  const data = await response.json();
  requireValue(Array.isArray(data.accounts), "桥返回的账号格式无效");
  return data.accounts.map(({ id, name, blocked, busy, blockedUntil }) => ({ id, name, blocked, busy, blockedUntil }));
}

async function freeAccounts(model) {
  const registered = await accounts();
  const planned = model.project.bridgeAccountCount;
  requireValue(planned == null || registered.length === planned,
    `本次约定使用 ${planned} 个账号，桥当前登记 ${registered.length} 个。先与用户核对绑定范围`);
  return registered.filter((account) => !account.blocked && !account.busy).length;
}

async function submitPrepared(model, task) {
  const [image] = task.inputs;
  const base64 = fs.readFileSync(projectFile(model.root, image.path)).toString("base64");
  markSubmitting(model, task);
  const response = await request("/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: task.prompt, aspect: task.aspect, images: [`data:${image.mime};base64,${base64}`] }),
  });
  if (response.status === 429) {
    return fail(model, task, "quota", "Gemini 桥返回 HTTP 429，账号冷却或被占用");
  }
  if (!response.ok) {
    throw new Error(`桥提交返回 HTTP ${response.status}。任务仍在 submitting，先检查原请求是否被接收`);
  }
  const result = await response.json();
  return markSubmitted(model, task, { bridgeTaskId: result.id });
}

export async function submitBridge(model, shotId, mode) {
  requireValue(await freeAccounts(model), "桥没有空闲可用账号，已停止，本次未提交");
  return submitPrepared(model, begin(model, shotId, mode));
}

export async function submitBridgeBatch(model, shotIds) {
  requireValue(shotIds.length > 0 && new Set(shotIds).size === shotIds.length, "请提供互不重复的镜号");
  const packets = shotIds.map((shotId) => {
    const shot = model.shots.get(shotId);
    requireValue(shot && !shot.continuityFrom && !(shot.dependsOn ?? []).some((dep) => shotIds.includes(dep)),
      `${shotId} 缺少有效镜头或依赖上一镜，不能在本批并行提交`);
    return planTask(model, shotId, "bridge");
  });
  const capacity = await freeAccounts(model);
  const submitted = [];
  const pending = [...shotIds];
  for (const packet of packets.slice(0, capacity)) {
    const task = recordPreparedTask(model, packet);
    pending.shift();
    try {
      await submitPrepared(model, task);
    } catch (error) {
      return { status: "failed", submitted, pending,
        failed: { id: task.id, shotId: task.shotId, status: task.status, error: error.message } };
    }
    if (task.status === "failed") {
      return { status: "failed", submitted, pending,
        failed: { id: task.id, shotId: task.shotId, status: task.status, error: task.error } };
    }
    submitted.push({ id: task.id, shotId: task.shotId, bridgeTaskId: task.provider.bridgeTaskId });
  }
  return { status: submitted.length ? "submitted" : "waiting", submitted, pending };
}

export async function pollBridge(model, task) {
  requireValue(bridgeModes.includes(task.mode) && task.status === "submitted", "只能查询已提交的桥接镜头");
  const remoteId = task.provider.bridgeTaskId;
  const response = await request(`/task/${encodeURIComponent(remoteId)}`);
  if (response.status === 429) return fail(model, task, "quota", "查询时 Gemini 桥返回 HTTP 429");
  requireValue(response.ok, `桥查询失败 HTTP ${response.status}，请核对原任务 ${remoteId}`);
  const status = await response.json();
  if (status.status === "failed") {
    const detail = String(status.error || "桥报告任务失败");
    const code = /找不到视频入口/.test(detail) ? "video_entry_missing"
      : /429|额度|次数已用完|达到上限/.test(detail) ? "quota" : "provider_failed";
    return fail(model, task, code, detail);
  }
  if (status.status !== "completed") return { id: task.id, bridgeTaskId: remoteId, status: status.status };
  const filename = `${task.shotId}_${task.shotVersion}_${task.id}.mp4`;
  const relative = path.join("assets", "videos", filename);
  const output = projectOutput(model.root, relative);
  const needsDownload = !fs.existsSync(output);
  if (needsDownload) {
    const media = await request(`/media/${encodeURIComponent(remoteId)}.mp4`);
    if (media.status === 429) return fail(model, task, "quota", "下载时 Gemini 桥返回 HTTP 429");
    requireValue(media.ok && /^video\/mp4(?:;|$)/i.test(media.headers.get("content-type") ?? ""), "桥未返回有效的 MP4 响应");
    writeAtomic(output, Buffer.from(await media.arrayBuffer()));
  }
  try {
    return attachMedia(model, task, relative);
  } catch (error) {
    if (needsDownload) fs.rmSync(output, { force: true });
    throw error;
  }
}
