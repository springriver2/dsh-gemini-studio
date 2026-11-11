---
name: video-production
description: 在 DSH 里按 video_check 规范制作 AI 视频、漫剧和短剧：剧本、十列分镜、逐镜执行卡、角色场景道具参考，Gemini 网页账号出图出片，本机 ffmpeg 合成带字幕成片并核验。适用于从创意到成片或继续已有制作项目。
---

# 视频制作

## 在 DSH 里运行（优先于下文 Codex 专用步骤）

本技能在 DSH 复用同一套 `scripts/` 和项目 JSON，但**不要在 DSH 里起 `video-gen/dashboard.mjs`**：Gemini 这层已经由 `dsh-gemini-studio` 插件接管，桥就是同一个（`127.0.0.1:8787`）。

| 要做的事 | 在 DSH 里用什么 |
| --- | --- |
| 看账号 / 加账号 / 解冷却 / 体检 | `gemini_accounts` 工具（`list` / `add` / `doctor` / `reset`） |
| 出设定图、场景图、道具图、首帧 | `gemini_image` 工具，落到 `<工作区>/gemini-out/` |
| 一次性出镜头（不记账） | `gemini_video` 工具 |
| 要记账的正式镜头 | `node <本技能目录>/scripts/studio.mjs bridge-generate <项目> <镜号>`，再 `bridge-poll` 回查 |
| 项目状态、分镜表、执行卡、校验 | `node <本技能目录>/scripts/studio.mjs ...`，命令不变 |
| **项目直接出片** | `short_compose`：读分镜和验收记录，自动配转场/配音/字幕，出 `exports/<项目>.mp4` |
| 手工拼镜头 | `video_compose`（manifest 级别）、`video_assemble`（无声快剪） |
| 配音 | `tts_generate` 工具（MiMo，需要 key） |

两条硬规则：

1. **要进项目的图，先 `gemini_image` 生成，再登记**：
   `node <本技能目录>/scripts/studio.mjs import-asset <项目> character C01 v001 <绝对路径>`
   类型可用 `character` / `scene` / `prop` / `frame` 等，按 [目录约定](references/project.md)。不要直接引用 `gemini-out/` 里的临时文件。
2. **正式镜头一律走 `bridge-generate`**：任务 ID、输入图和验收状态才会写进 `tasks.json`；`gemini_video` 只用于临时试片或不属于某个项目的镜头。

调度差异：桥现在**全局串行**——一次只跑一个账号，两次提交间隔 90 秒起，每天每号上限 8 条，额度耗尽会进冷却并停机。
`bridge-batch` 仍可一次提交多镜，但会排队慢慢跑，**不要以为它会并行出片**，也不要因为慢就重复提交。

剪辑：DSH 里没有 ChatCut，镜头齐了用 **`short_compose(project=…)` 一条出片**——
它按分镜自动配转场、配音时间轴和字幕。细节见 [剪辑与合成](references/editing.md)。
需要手工控制时才降级到 `video_compose`（manifest）或 `video_assemble`（无声快剪）。
成片必跑 `media_verify`。

配音：有 MiMo key 就用 `tts_generate`（一条配音一个 wav，按 `delay_ms` 排进 manifest）；没有 key 就给用户要 wav，或按无声交付并说明，**不要假装配好了**。

## 制作流程

按用户授权的阶段推进。仅要求剧本、分析或提示词时停在对应交付。已有项目先看剧本、素材索引、任务日志和用户最后的决定，保留已采用版本。

## 先定位作品目录

以用户指定的项目目录为根。用户在作品工作区调用时，直接使用该工作区（命令中的 `.` 指执行命令的目录）。当前在插件、Gemini 桥或通用规范库时，先找用户指定的作品目录。新作品需要独立目录时，在用户选择的工作区创建作品子目录。工具脚本的位置与作品目录分开。所有项目资源按 [目录约定](references/project.md#目录与资源归档) 保存，工具输出到临时目录时，先复制进项目并登记，再在后续步骤引用。

## 桥接账号先确认

第一次走 Gemini 桥生成前，先问用户**本次希望使用几个桥接账号**。用户已经明确数量时沿用。读 `bridge-accounts` 核对桥登记的账号和冷却状态，区分登记数与实际已登录数，确认需要补登几个。首次配置、缺少账号或需要重新登录时，用 `gemini_accounts` 工具：`add` 会弹一个独立 Chrome 窗口，由用户本人登录；`doctor` 检查登录态和视频入口。**不要起 dashboard**。把已确认的目标数写入 `project.json` 的 `bridgeAccountCount`。登记数量和目标不符时先解决绑定范围，桥默认会在所有已登记的可用账号间选择。制作设定图、剧本和分镜可以在用户登录期间推进。

## 制作顺序

1. 新项目运行 `node <本技能目录>/scripts/studio.mjs init <项目目录> <标题>`。已有项目可运行 `layout <项目目录>` 补齐目录并读取绝对路径。用 [数据约定](references/project.md) 填写项目及分镜。项目的声音方式、字幕和花字由用户需求决定。
2. 先写完整剧本，再按场次拆镜。每场明确人物想办成什么、遇到什么、结果发生什么变化。对白与旁白按场次和说话人拆开，明确谁说、谁听、哪些动作跨句。按叙事选择转场和跨场对白或声音衔接，记录理由和落点。以最终可听到的语音安排对白时长。
3. 定角色、场景、道具和音色。先保存用于跨镜复用的设定图，再生成正式首帧。反复出现的人物制作一张大头特写＋全身正、侧、背四视图。关键道具制作多角度统一图，保存颜色、材质、尺度、数量及必要的使用状态。反复使用的场景保存空间全景及必要的第二机位，固定出入口、轴线、主光和陈设。将三类资料分别落盘至 `assets/characters/`、`assets/props/`、`assets/scenes/`，在素材索引分别登记版本和审核状态。使用已有合格设定图时直接复用。
4. 写逐镜执行数据。将每镜使用的设定素材填入 `designRefs`，用实际设定图作为生图参考制作单画面首帧。角色拼图、道具图和场景图与正式首帧分别留档。需要尾帧时另备一张；首帧路线仍描述本镜应到达的结束状态。说明可观察的开始、关键中间步骤与结束，补上对白、音效、运镜、视线和切点。角色多视图用于设计和身份约束。首尾输入、原视频抽帧和剪入区间抽帧各自保存。运行 `validate` 和 `render`，交付十列分镜总表及逐镜执行卡。需要更多创作字段时参照 [分镜模板](references/storyboard-template.md) 和 [角色与音色模板](references/identity-template.md)。
5. 用户授权生成后，先用本地 Gemini 桥跑有代表性的关键镜头，首帧即可用于正式生成。独立首帧的镜头可按空闲账号数并行生成，依赖上一镜结果的镜头等前置检查完成。桥遇到技术故障且已确认原请求未在途时，按 [Gemini 执行流程](references/gemini.md) 的网页备用流程处理；DSH 里没有 Computer Use，改为请用户手动在那个 Chrome 窗口操作，并按 `submitted` / `media` 登记回执。读 [Gemini 执行流程](references/gemini.md)，记录实际输入、提交回执、媒体和验收。遇额度、429 或视频入口缺失立即停发。超时先回查原任务。
6. 用户授权剪辑后，读 [剪辑与合成](references/editing.md)。按真实选段排可编辑时间线。对白字幕根据最终发声校对，花字单独设计和放置，控制出现时机，避免遮挡脸、手或动作。按 [源片验收](references/gemini.md#源片验收) 保存抽帧与选段；纯后配旁白要排除可见说话口型。再检查合成画面和实际声音，未完成验收记为草稿。用户要求成片时，再导出并核实文件。

仅能提交首帧时，无转场的相邻镜头使用 `continuityFrom`。上一镜生成后先按保留区间定剪，再抽该区间最后一帧作为下一镜首帧。明确转场的镜头单独准备首帧。具体做法见 [剪辑与合成](references/editing.md#用剪切末帧接下一镜替代-chatcut-的做法)。

`studio.mjs --help` 查看命令。把 CLI 返回的任务 ID、素材及时间线证据用于后续查询，重开聊天从项目 JSON 接续。
