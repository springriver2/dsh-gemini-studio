# 项目数据约定 v1

所有命令以技能内 `scripts/studio.mjs` 为入口。项目参数可以是绝对路径或相对于终端当前目录的路径。已在作品目录时用 `.`。JSON 中的素材路径相对于作品根目录，作品整体搬迁后可以继续使用。

## 目录与资源归档

```text
作品目录/
  project.json             项目参数
  storyboard.json          场次和分镜
  tasks.json               任务、验收和剪辑回执
  scripts/                 剧本、十列分镜和逐镜执行卡
  assets/
    registry.json          素材索引
    characters/            人物设定
    scenes/                场景设定
    props/                 道具设定
    styles/                风格参考
    frames/inputs/         生视频使用的首尾帧
    frames/review/         源片及合成验收抽帧
    frames/cuts/           剪入区间的抽帧
    voices/                音色基线和配音
    audio/                 配乐和音效
    prompts/               需要独立留档的生成提示词
    videos/                下载并校验的镜头源片
    edits/                 本地剪辑交接、字幕与回执文件
  exports/                 导出的成片和交付字幕
```

- 新作品用 `init <项目> <标题>` 创建目录和 JSON。已有作品用 `layout <项目>` 补齐目录，保留当前文件和素材引用。
- 对生图、配音等工具返回的本地文件，可运行 `import-asset <项目> <类型> <ID> <版本> <源文件>`，例如 `import-asset . character C01 v001 /绝对路径/人物.png`。命令按类型复制到项目内，登记为 `pending_review`，返回实际路径和素材引用。已有项目内文件也可按原路径登记。素材修订用新版本。
- 生成视频通过桥下载到 `assets/videos/`。网页下载后先复制到该目录，再用 `media` 登记。对参与生成或剪辑的项目文件，用项目内副本；临时缓存和 ChatCut 云端 ID 仅供传输、回查和继续编辑。
- ChatCut 可编辑时间线保留在 ChatCut，项目内用 `tasks.json` 和 `assets/edits/` 记录位置和回执。需要交付时，把实际下载的成片和字幕放进 `exports/` 并核对文件可读。桥的账号、登录态和缓存属于运行环境，独立于作品归档。

## 项目、剧本和素材

- `project.json` 保存 `schemaVersion: 1`、标题 `title`、`aspect`（16:9、9:16、1:1）、时间线 `fps`、全片风格 `style`、`audioMode`、`subtitles` 与 `stylizedText`。声音模式选 `silent`（最终无声）、`native`（保留合格同期声）或 `post`（后期混音）。无对白可有环境声、动作声和非语言发声，按实际制作方式选 `native` 或 `post`。
- `scripts/剧本.md` 按场次写人物、时间、地点、目标、阻碍、动作、精确对白、结果和转场。用场次 ID 与分镜关联。变更剧本或参考后，同步提高受影响镜头版本，保留历史提交。
- `assets/registry.json` 包含 `assets` 数组。每条有 `id`、`version`、`type`、`path`、`status`。素材类型是 `character`、`scene`、`prop`、`style`、`startFrame`、`endFrame`、`voice`、`video` 或 `audio`。审核用 `pending_review`、`approved`、`rejected`。可加 `platformAssetId`、`purpose`、`approvalEvidence`、`characterId` 等。引用统一用 `id@version`。不同造型、布置和声音参数建立新版本。
- `tasks.json` 由脚本更新。每次生成记录输入路径与散列、提示词、镜号及版本、远端回执、校验信息、验收和剪辑映射。提交确认丢失时保留 `submitting`，核实原提交后再录回执；有明确拒绝才按具体原因记失败。运行命令后读取真实状态。

## 设定素材与账号范围

新项目默认启用 `requireDesignRefs`，每个提交的镜头都要引用已落盘的制作设定。把人物四视图、道具多角度图和场景空间图分别登记为 `character`、`prop`、`scene`。旧项目可在准备新一轮生成时启用该检查。把每镜实际用于制作首帧的设定素材写入 `designRefs`。任务保存这些素材的版本和散列作为制作依据，桥只收到单张实际首帧。

向用户确认本轮桥接账号数后填写 `bridgeAccountCount`。桥状态列出的数量是已登记账号数，用户本人确认哪些账号已登录。桥的实际登记数不等于约定数时，脚本阻止提交。

## 分镜

`storyboard.json` 使用 `scenes` 和 `shots` 两个数组。场次字段 `id`、`title`、`beat`；镜头顺序以数组顺序为准。下例字段值仅说明写法。

```json
{
  "scenes": [
    { "id": "SC01", "title": "等候", "beat": "来信让角色决定提前出发。" }
  ],
  "shots": [
    {
      "id": "S001",
      "version": "v001",
      "sceneId": "SC01",
      "editSeconds": 4,
      "requestSeconds": 6,
      "description": "人物看完信，把信收进左侧衣袋。",
      "framing": "中近景",
      "lighting": "晨光从右侧窗户斜照",
      "camera": "固定机位",
      "dialogue": [
        { "kind": "dialogue", "speaker": "旅人", "text": "现在就走。", "delivery": "低声，念完信后停半拍", "voiceRef": "VOICE01@v001" }
      ],
      "sfx": ["折信声先于入袋"],
      "transitionIn": { "type": "硬切", "reason": "视线从窗外切到桌面" },
      "startState": "双手展开信件，右肩朝窗。",
      "endState": "信已收进左侧衣袋，右手离开信件。",
      "startFrame": "S001_START@v001",
      "endFrame": "S001_END@v001",
      "designRefs": ["C01@v001", "L01@v001", "P01@v001"],
      "references": [],
      "stillPrompt": "旅行者在窗边读信，桌面空间与窗的方向固定。",
      "motionPrompt": "先读完并停顿，折信，放入左侧衣袋，随后右手松开。",
      "dependsOn": [],
      "graphics": [
        { "text": "出发", "start": 2.5, "end": 3.5, "reason": "突出决定发生的节点" }
      ]
    }
  ]
}
```

- `requestSeconds` 可省略，`editSeconds` 为计划剪入时长。实际媒体时长由校验记录。剪辑计划以时间线帧计，源片入点仍用秒。
- 镜头可用 `audioMode` 覆盖项目声音模式，便于保留同期口播，同时给其他镜头后配旁白。
- 无转场的首帧接力镜头用 `continuityFrom` 引用紧邻上一镜。下一镜的 `startFrame` 应绑定 [ChatCut 剪切末帧](chatcut.md#用剪切末帧接下一镜)。明确转场的镜头填写 `transitionIn`。
- 首帧路线需要实际首帧，尾帧引用可留空。只有走双帧路径时要求实际尾帧。对白、音效、视觉参考没有时用空数组。角色图与场景图可用于首尾帧生图；`references` 只列本镜还需要实际传给正式视频生成器的参考。
- `transitionIn` 记录切入方式和剧情理由。跨场对白、旁白或声音可加 `soundBridge`，填写 `direction`（`lead` 为下一场声音先入，`carry` 为上一场声音延续）、`cue`（承接的台词或声音）及 `seconds`。转场按源余量和当前时间线检查后执行。
- `dependsOn` 只引用数组中更早的镜头。确实使用上镜成片或验收结论时才建立依赖。花字的时间相对本镜计划剪入点，正片字幕的时间以最终发声为准。
- `render` 更新 `scripts/分镜总表.md` 和 `scripts/逐镜执行卡.md`。在 JSON 和剧本修改源内容。保留一份历史交付时，按版本保存已经生成的文档和媒体。
