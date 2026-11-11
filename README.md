# dsh-gemini-studio

在 **DeepSeek Harness（DSH）** 里用你**自己已登录的 Gemini 网页账号**出图、出视频，并在本机把镜头合成成片。

不调用官方 API、不需要 API Key（配音除外），消耗的是 Gemini 账号自带的额度。

> ⚠️ 自动化操作 Gemini 网页版**违反 Google 服务条款**，多账号在同一出口 IP 上更容易触发风控。
> 这是本项目唯一无法消除的风险，请自己评估，别把唯一主号放进来。

---

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 出图 | `gemini_image`：设定图、场景、道具、首帧，可给参考图 |
| 出视频 | `gemini_video`：文生视频 / 图生视频，多账号轮换，额度冷却 |
| 账号管理 | `gemini_accounts`：添加（弹独立 Chrome 由本人登录）、体检、解冷却、移除 |
| 配音 | `tts_generate`：MiMo TTS，预置音色 / 文字设计音色 / 样本复刻，支持风格标签 |
| 分镜直出 | `short_compose`：读分镜和验收记录，自动配转场、配音时间轴、字幕，输出 MP4 |
| 手工合成 | `video_compose`（manifest）、`video_assemble`（无声快剪） |
| 静图运镜 | `image_to_video`：ffmpeg zoompan，不耗 Gemini 额度 |
| 成片核验 | `media_verify`：分窗能量、音频版本比对、白屏检测 |
| 剪点重排 | `retime_shots`：按人声收尾把剪入点落到自然停顿上 |
| 工作台面板 | 侧栏「Gemini 工作室」：账号状态、出图出片、作品墙、MiMo key |

插件还内置了一份短剧制作规范（技能 `video-production`），装完即可用。

---

## 安装

### 1. 前置

- macOS + Google Chrome（桥用独立 profile 驱动 Chrome，**必须有界面**）
- Node.js 22+
- Python 3.12+ 与 Pillow（DSH 自带运行时已包含，插件会自动优先使用它）

### 2. 装进 DSH

```bash
# 把本目录放到任意位置，然后（在 DSH 里让 agent 执行，或用带 plugin_manager 的界面）
# 目标填这个目录的绝对路径
plugin_manager install_bundle /绝对路径/dsh-gemini-studio
```

装完 DSH 会把它加进 `~/.dsh/profiles/<profile>/package.json` 的 bundles，并挂载 `gemini-studio` 这一行。
侧栏会出现「Gemini 工作室」图标，技能目录里会出现 `video-production`。

### 3. 绑定 Gemini 账号

打开「Gemini 工作室」面板 → 输入账号名 → **添加账号** → 会弹出一个独立的 Chrome 窗口，
**由你本人登录 Google 并打开 gemini.google.com**。登录完可以关掉那个窗口，登录态存在：

```
~/.gemini-video-bridge/profiles/<账号id>/
```

想加多个号就重复这一步。桥默认在可用账号里挑「最久没用过」的那个。

### 4.（可选）配音 key

面板「配音（MiMo）」卡片里粘贴 key，或设环境变量 `MIMO_API_KEY`。
没有 key 时配音功能不可用，其余功能正常。

---

## 用法

装好后直接在对话里说：

```
用 gemini 生成一张图：茶室里的五色手串，柔光，竖屏
用 gemini 生成一条 8 秒视频：雨后的青石板路，镜头低角度前推，9:16
看看我的 gemini 账号状态
```

**全流程制作**（剧本 → 分镜 → 设定图 → 镜头 → 成片）由技能 `video-production` 驱动，
直接说「用 video-production 做一个 30 秒的短剧」即可。

关键约定：

```
<项目>/
├── project.json       画幅 / fps / 声音模式（native 或 post）/ 字幕开关
├── storyboard.json    场次 + 镜头（十列分镜表的数据源）
├── tasks.json         生成任务、验收记录、媒介
├── assets/voices/     后配 TTS：<镜号>.wav
├── assets/videos/     生成的镜头
├── assets/edits/      字幕与回执
└── exports/           成片
```

- `studio.mjs render` 输出十列分镜表和逐镜执行卡
- `short_compose(project=...)` 一条命令出片；有镜头没通过验收会直接报镜号
- 原生语音（Gemini 自己念台词）时，字幕按**真实人声区间**生成

---

## 面板

侧栏「Gemini 工作室」：

- 账号：空闲 / 生成中 / 冷却到几点，可体检、解冷却
- 生成：视频 / 图片，画幅、账号、半自动（停在发送前由人点）
- 配音：MiMo key 配置
- 作品墙：`gemini-out/` 里的成片，直接预览

---

## 已知限制

- **只能跑在有界面的机器上**，Chrome 必须真实打开；无头模式更容易被判机器人
- **依赖 Gemini 网页结构**：改版就会失效（本项目已经因此重写过两次入口）
- **多账号**只是轮换额度，不解决「同一出口 IP」的关联风险
- 原生语音**跨镜音色可能漂移**（每次生成独立推理），要绝对一致就一条镜头一条镜头地听
- 首帧挂图依赖 Gemini 的拖放/文件框，偶尔会失效，详见 [故障排查](docs/TROUBLESHOOTING.md)

---

## 目录结构

```
dsh-gemini-studio/
├── index.js                  Host 插件：工具注册、桥生命周期、面板 API、py 脚本调用
├── client.js                 工作室面板（侧栏图标 + 主区页面）
├── bridge/                   Gemini 网页桥（CDP 驱动 Chrome，自带，可替换）
├── py/                       合成 / 运镜 / 核验 / TTS 脚本（含第三方 MIT 代码，见 THIRD-PARTY.md）
├── skills-video-production/  内置的短剧制作规范（安装时自动注册成技能）
├── docs/TROUBLESHOOTING.md   踩过的坑与处置
└── cordis.patch.yml          Loader 行
```

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖这一行的 `config`：

```yaml
- id: gemini-studio
  name: dsh-gemini-studio
  config:
    bridgePort: 8787
    bridgeDir: ""        # 空 = 用包内 bridge/；填绝对路径可复用外部桥
    autoStart: true
```

桥的环境变量（对自带桥同样生效）：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `BRIDGE_PORT` | 8787 | 桥的 HTTP 端口 |
| `MIN_GAP_SECONDS` | 90 | 两次提交最小间隔 |
| `DAILY_CAP` | 8 | 每账号每日上限 |
| `COOLDOWN_HOURS` | 5 | 额度冷却基准（再加 10–40 分钟随机） |
| `CHROME_BIN` | 系统 Chrome | 自定义 Chrome 路径 |

---

## 许可

MIT。`py/` 下三个脚本来自 [dsh-video-pipeline](https://www.npmjs.com/package/dsh-video-pipeline)（MIT），
详见 [THIRD-PARTY.md](THIRD-PARTY.md)。

## 参与

- 有问题请开 [Issue](https://github.com/springriver2/dsh-gemini-studio/issues/new/choose)
- 想改代码请先看 [CONTRIBUTING.md](CONTRIBUTING.md)，走 Fork + PR
- 提 Issue 前先翻 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## 免责

本项目只做「把你自己的账号、你自己的内容变成视频」这一件事，不含任何绕过付费或共享账号的功能。
使用自动化操作网页版服务可能违反服务条款，后果自负。
