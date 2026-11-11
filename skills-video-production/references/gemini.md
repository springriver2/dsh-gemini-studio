> **DSH 环境**：账号、出图、出片用插件的 `gemini_accounts` / `gemini_image` / `gemini_video` 工具，
> 不要起 `video-gen/dashboard.mjs`。要记账的正式镜头仍然走 `studio.mjs bridge-generate` + `bridge-poll`。
> 详见 SKILL.md「在 DSH 里运行」。

# Gemini 生成与回查

## 默认用本地桥生成正式镜头

1. 确认用户已授权生成并亲自登录了用于生成的账号。复用已就绪的桥。首次配置、缺少账号或需要重新登录时，用 `gemini_accounts` 工具（`add` 弹窗由本人登录，`doctor` 体检）；不要起 dashboard。插件的桥接命令访问本机 `127.0.0.1:8787`；改过端口时同桥设置 `BRIDGE_PORT`。先向用户确认本次桥接账号数量；用 `bridge-accounts` 查看登记、占用和冷却。已有账号使用对应行的「打开登录窗口」。需要额外账号时先在管理页登记，再由用户本人登录。管理页不可用时，可用 `node cli.mjs accounts` 检查或启动桥，新增账号用 `node cli.mjs add <名称>`。
2. 运行 `prepare <项目> <镜号>` 检查实际首帧和提示词，再运行 `bridge-generate <项目> <镜号>`。现有桥只接收首帧，插件直接用它生成正式镜头。尾部画面作为运动提示词中的目标；尾帧设计图可用于制作和验收。任务的 inputs 只登记实际提交的图片。
3. 保存本地任务 ID，用 `bridge-poll <项目> <任务ID>` 回查原任务。桥完成时，插件会校验媒体响应、下载并探测 MP4。已通过画面和所需声音检查的桥接镜头可直接进入默认剪辑计划。只有明确要做试片时使用 `bridge-preview`。
4. 遇到 HTTP 429、额度耗尽或找不到视频入口时停止新提交并报告。桥请求超时或回执缺失时，先回查原任务及会话，避免重复生成。桥使用原 Chrome 会话下载 MP4。下载失败时可从第一个桥接账号当前的原会话运行 `node bridge.mjs check --out <视频路径>` 恢复。需要操作其他账号的网页下载时用 Computer Use。然后用 `recover-media <项目> <任务ID> <视频相对路径> <回执JSON>` 补录。回执填写 `conversationUrl` 和 `evidence`。

独立首帧已准备好且镜头之间无依赖时，运行 `bridge-batch <项目> <镜号...>`。每批最多提交当前空闲账号数，每个账号同时生成一条。按返回的 `submitted` 查询各任务，完成核对后再提交 `pending` 中的镜头。含 `continuityFrom` 的镜头等上一镜定剪并取帧后，用单镜命令提交。批次遇到失败或回执不明时，先回查已提交任务及未确认的镜头。

桥内的 Chrome 自动打开带 `?hl=zh-CN` 的 Gemini 页面，视频工具和画幅依赖中文控件。提示词可以用中英文。如果 Gemini 实际显示英文，先检查中文参数是否生效。桥自动驱动 Chrome，Codex 在这条路径只调用本地接口。

## 技术故障时用 Computer Use 操作 Gemini 网页

1. 当桥因启动、连接或自动化故障无法使用，且已核实没有在途的同一生成请求时，改用 Computer Use 在用户已登录的 Gemini 网页中生成。识别当前页面的实际控件，适配现场显示语言。出现登录时交给用户完成。额度、429 和找不到视频入口属于停发条件。明确的内容拒绝按原结果记录。
2. 默认用 `begin <项目> <镜号>` 登记网页备用任务，上传首帧并核对缩略图、提示词与画幅。若当前页面明确支持首尾帧绑定，并且已具备两张实际图片且该镜头要用双帧，可在开始前改用 `begin <项目> <镜号> dual`。普通附件的顺序或提示词里的文字标签不足以证明双帧绑定。已创建双帧任务却发现不支持时，用 `fail <项目> <任务ID> binding_unavailable <说明>` 记录未提交，再建立网页首帧任务。
3. 点击提交前运行 `submitting <项目> <任务ID> <绑定JSON文件>`。绑定 JSON 使用 `kind`（首帧用 `first_frame`，双帧用 `dedicated_fields` 或 `explicit_source_roles`）、`evidence`（实际看到的缩略图或栏位）、`submittedPrompt`（即将提交的完整原文，含任务提示词）和 `assignments`。映射按任务输入顺序填写，每条含 `role`、`asset`、`slot`，记录实际可见且唯一的栏位或附件位置。命令成功后点击一次。
4. 页面接收后，用 `submitted <项目> <任务ID> <回执JSON文件>` 登记 `{"conversationUrl":"实际 Gemini 会话 URL"}`。从原会话下载 MP4 到项目内，用 `media <项目> <任务ID> <项目内相对路径>` 登记。回执不明时查看原会话。确认失败时按实际原因记录；恢复额度后，经用户决定可用 `resume` 继续其他待处理镜头。

## 源片验收

检查首、中、末和生成内切点，观察动作、持物、角色和空间；保存抽帧证据。纯后配旁白优先用安静表演、动作或产品特写，逐段确认人物没有可见的说话口型。发现人物在说话时，该区间的画面不通过，静音也不改变判定。局部瑕疵可从同一源片选用仍能覆盖时长、动作和构图的合格区间。关键动作、口型或构图无法用合格区间满足时，只重生成受影响的镜头或连续片段，保留旧版缺陷与证据；新源片通过验收后再替换。需要同步后配对白的镜头则按实际发声核对口型。

运行 `review <项目> <任务ID> <检查JSON文件>`，填写 `picture`（passed、failed、pending）、`sound`（passed、failed、pending、not_required）和 `notes`。画面通过时填采用区间 `sourceIn`、`sourceOut`（秒）和 `evidenceFrames`（至少三张项目内抽帧相对路径）；纯后配旁白再填 `visibleSpeech: "absent"`。只有实际听过且通过才填 `sound: "passed"` 和 `listeningNotes`（试听范围与听感）。画面、音轨存在、ASR 和试听分别记录；不保留的源音可记 `not_required`，最终混音仍要试听。
