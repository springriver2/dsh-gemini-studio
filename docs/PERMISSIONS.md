# 系统权限

插件只做两件事：**用 CDP 驱动一个独立的 Chrome**，和**在本机跑 ffmpeg/python**。
所以需要的东西比想象中少——大部分「权限」其实是 macOS 的隐私授权，而且只有一条是可选的。

## 一张表

| 项目 | 是否必须 | 用在哪 | 不给会怎样 |
| --- | --- | --- | --- |
| **Google Chrome** | ✅ 必须 | 桥要真实启动一个 Chrome 实例 | 什么都做不了 |
| **辅助功能**（Accessibility） | ⚠️ 可选 | 用 AppleScript 往 Chrome 的「打开文件」对话框里填路径 | 回退到拖放挂图；拖放再失效就报 `首帧图挂载失败` |
| **自动化**（Automation） | ⚠️ 可选 | 同上，脚本要控制「Google Chrome」和「System Events」 | 首次运行会弹授权框，拒绝后上面那条路径失效 |
| 完全磁盘访问（Full Disk Access） | ❌ 不需要 | — | — |
| 屏幕录制（Screen Recording） | ❌ 不需要 | 截图走 CDP `Page.captureScreenshot`，不碰系统截屏 | — |
| 麦克风 / 摄像头 | ❌ 不需要 | — | — |
| 防火墙 | ❌ 不需要改 | 桥只监听 `127.0.0.1` | — |

> **授权对象是运行 DSH 的那个 App**（桌面版就是 `DeepSeek Harness`），不是 Chrome，也不是终端。
> 如果你是从终端里手工跑 `bridge.mjs` 调通的，那授权对象是终端。

## 面板里直接看

「Gemini 工作室」面板上有一张**系统权限**卡片：

- 实时显示「辅助功能」是否已授权（绿点 = 已授权）
- **打开设置** / **自动化设置** 两个按钮，点了直接跳到系统设置里对应的那一页
- 不需要自己去翻菜单

## 怎么给「辅助功能」

1. 打开 **系统设置 → 隐私与安全性 → 辅助功能**
2. 点 `+`，选 `/Applications/DeepSeek Harness.app`
3. 勾上；如果它已经在列表里，先关掉再打开一次

## 怎么确认已经生效

```bash
osascript -e 'tell application "System Events" to keystroke ""'
```

- 没有输出 → 已授权
- 报 `osascript is not allowed assistive access` / `not authorized` → 没给

再验证自动化：

```bash
osascript -e 'tell application "Google Chrome" to get name of every window'
```

第一次会弹「终端/DSH 想要控制 Google Chrome」，点允许即可。

## 没给权限还能用吗

能，只是**带首帧的生成会退化成"只能纯文生视频"**：

- 出图：不受影响（不需要挂图）
- 出视频（无首帧）：不受影响
- 出视频（给首帧）：需要挂图 → 先试文件框，再试拖放，都不行就失败

纯文生视频的代价是**人物一致性会掉**，做短剧不建议。

## 其他平台

- **Windows**：不需要额外授权，走 CDP 即可（`CHROME_BIN` 可指定 Chrome 路径）
- **Linux**：同上；文件框那条路径不实现，只用拖放

## 首次启动会遇到的系统弹窗

| 弹窗 | 原因 | 怎么处理 |
| --- | --- | --- |
| 「Chrome 想要访问文件」 | Chrome 用独立 profile 写在 `~/.gemini-video-bridge/` | 允许 |
| 「DSH 想要控制 Google Chrome」 | AppleScript 自动化 | 允许 |
| 「DSH 想要控制 System Events」 | 同上 | 允许 |
| 「Chrome 想要使用你的麦克风」 | 某些视频页面会请求，我们不用 | 拒绝即可 |

## 数据都写在哪

```
~/.gemini-video-bridge/
├── accounts.json        账号登记与冷却
├── profiles/a1, a2 …    每个账号一份 Chrome 登录态（等价于你的账号，别拷给别人）
└── videos/              中间产物

~/.dsh/gemini-studio/
└── secrets.json         面板里填的 MiMo key（0600）
```

**不要把这两个目录提交到 git、贴进 Issue 或分享给别人。**
