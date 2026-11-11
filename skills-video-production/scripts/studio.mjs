#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { accounts, pollBridge, submitBridge, submitBridgeBatch } from "./gemini.mjs";
import { browserModes, importAsset, init, layout, load, prepare, readJson, render, requireValue, resolveProjectRoot } from "./project.mjs";
import { attachMedia, begin, editPlan, fail, markSubmitted, markSubmitting, recordEdit, resume, review, taskFor } from "./tasks.mjs";

const help = `用法：node studio.mjs <命令> <项目目录> [参数]（项目目录可用 .）

init <标题>                        初始化空白项目
layout                             补齐项目子目录并显示绝对路径
import-asset <类型> <ID> <版本> <源文件>  复制并登记到项目素材库
validate                           校验项目结构与引用
render                             输出十列分镜表和逐镜执行卡
prepare <镜号> [模式]              校验素材并输出提交包，默认 bridge（首帧）
begin <镜号> [browser|dual]        创建 Computer Use 网页备用任务，默认首帧
submitting <任务ID> <绑定JSON>      即将按实际映射提交，点击前登记
submitted <任务ID> <回执JSON>       登记已提交的原始 Gemini 会话 URL
fail <任务ID> <错误类型> <说明>      登记失败或额度暂停
resume <人工决定依据>               解除额度暂停
media <任务ID> <项目内相对路径>       校验和登记下载的 MP4
recover-media <任务ID> <路径> <JSON>  校验并补录从原会话下载的 MP4
review <任务ID> <检查JSON>           登记画面、声音和可用区间
edit-plan [模式]                   生成 ChatCut 交接计划，默认汇集正式镜头
record-edit <ChatCut回执JSON>       登记已确认的时间线放置记录
bridge-accounts                    查询已有 Gemini 桥的账号
bridge-generate <镜号>             用已有桥提交正式镜头（首帧）
bridge-batch <镜号...>              按空闲账号数并行生成独立镜头
bridge-preview <镜号>              用已有桥提交首帧试片
bridge-poll <任务ID>                查询或下载已提交的桥接镜头`;

async function withLock(root, run) {
  const lock = path.join(root, ".video-production.lock");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("项目状态正被其他命令写入；先确认前一个进程已退出");
    throw error;
  }
  try {
    return await run(load(root));
  } finally {
    fs.rmdirSync(lock);
  }
}

async function main() {
  const [command, directory, ...args] = process.argv.slice(2);
  const [first, second, third] = args;
  if (!command || command === "--help" || command === "help") return console.log(help);
  if (command === "bridge-accounts") return console.log(JSON.stringify(await accounts(), null, 2));
  requireValue(directory, "请提供项目目录");
  const root = resolveProjectRoot(directory);
  let result;
  switch (command) {
    case "init":
      result = init(root, first);
      break;
    case "validate": {
      const model = load(root);
      result = { valid: true, scenes: model.scenes.size, shots: model.shots.size, assets: model.assets.size };
      break;
    }
    case "render": result = render(load(root)); break;
    case "prepare": result = prepare(load(root), first, second); break;
    case "edit-plan": result = editPlan(load(root), first); break;
    default:
      result = await withLock(root, async (model) => {
        if (command === "layout") return layout(root);
        if (command === "import-asset") {
          requireValue(args.length === 4, "用法：import-asset <项目目录> <类型> <ID> <版本> <源文件>");
          return importAsset(model, ...args);
        }
        if (command === "begin") {
          const mode = second ?? "browser";
          requireValue(browserModes.includes(mode), "网页备用模式须为 browser 或 dual");
          return begin(model, first, mode);
        }
        if (command === "resume") return resume(model, first);
        if (command === "record-edit") return recordEdit(model, readJson(first));
        if (command === "bridge-batch") return submitBridgeBatch(model, args);
        if (command === "bridge-generate" || command === "bridge-preview") {
          return submitBridge(model, first, command === "bridge-generate" ? "bridge" : "preview");
        }
        const task = taskFor(model, first);
        switch (command) {
          case "submitting": return markSubmitting(model, task, readJson(second));
          case "submitted": return markSubmitted(model, task, readJson(second));
          case "fail": return fail(model, task, second, third);
          case "media": return attachMedia(model, task, second);
          case "recover-media": return attachMedia(model, task, second, readJson(third));
          case "review": return review(model, task, readJson(second));
          case "bridge-poll": return pollBridge(model, task);
          default: throw new Error(`未知命令：${command}`);
        }
      });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
