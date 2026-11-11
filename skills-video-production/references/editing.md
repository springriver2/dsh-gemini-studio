# 剪辑与合成（DSH 版）

DSH 里没有 ChatCut。镜头齐了之后，合成、字幕、核验全部在本机完成，工具都在 `dsh-gemini-studio` 插件里。
成片默认落在 `<工作区>/gemini-out/`，要交付时再复制进项目 `exports/`。

## 主路径：项目直接出片（`short_compose`）

镜头验收完，一条命令出片，不用手拼 manifest：

```
short_compose(project="projects/xxx")
```

它会：

1. 跑 `studio.mjs edit-plan`，只取**已通过验收**的镜头；有镜头没通过会直接报出镜号并停下（不静默跳过）
2. 按分镜顺序摆放，源片入点用验收记录里的 `sourceIn`，每镜时长用 `editSeconds`
3. 转场取 `transitionIn`：叠化/淡入/溶解类 → 0.6 秒叠化，硬切 → 直切
4. 配音取 `assets/voices/<镜号>.wav`（也认 `<镜号>-*.wav`），按镜号在时间线上的位置自动排 `delay_ms`
5. 字幕优先用 `assets/edits/` 里最新的 srt；没有就按分镜对白**自动生成**一份，写到 `assets/edits/<项目名>.srt`
6. 输出到 `exports/<项目名>.mp4`

**会报警的两种情况**（不要忽略）：

- 配音比画面长 → 尾部被截断，提示你加长镜头或精简配音
- 某镜没有通过验收 → 报镜号，拒绝出片

可选参数：`out`、`mode`（production/preview）、`mute`、`subtitle_chars`、`font`、`total`。

## 底层工具（需要手工控制时才用）

| 工具 | 用途 | 边界 |
| --- | --- | --- |
| `video_assemble` | 快速粗剪：镜头清单 → 一条 MP4，可剪头尾、统一画幅、丢原声 | 不混音、不烧字幕，用来先看节奏 |
| `video_compose` | 正式合成：manifest（镜头 + 配音时间轴 + SRT）→ 成片 | 归一化、拼接、`adelay/amix` 混音、烧字幕、`+faststart`；字幕失败自动降级 |
| `image_to_video` | 静态图 → 缓推/缓拉镜头（zoompan） | 不出 Gemini 额度，做空镜、定场、拉长时间 |
| `media_verify` | 成片核验：`astats` 配音/静默窗、`audio-ncc` 版本比对、`brightness` 防白屏 | 验收必跑，不要靠肉眼 |

## manifest 怎么写

```json
{
  "out": "exports/EP01-成片.mp4",
  "total": 32,
  "fps": 24,
  "shots": [{ "file": "assets/videos/S01.mp4" }, { "file": "assets/videos/S02.mp4" }],
  "audio": [{ "file": "assets/audio/vo0.wav", "delay_ms": 0 }],
  "subtitles": "assets/subs/EP01.srt"
}
```

- 相对路径按工作区解析；`total` 是硬截断，**必须 ≥ 最后一条配音结束时刻**
- `audio` 可以为空（纯画面），`subtitles` 可以省略
- `transition`：写在某个镜头上，表示**从上一镜叠化进本镜**的秒数（如 `0.8`）；省略就是硬切。
  转场会吃掉重叠时长，所以 `total` 要按「各镜时长之和 − 重叠总和」规划，别按总和写。
- `w` / `h`：成片尺寸，默认 720x1280（竖屏）；横版写 1280x720
- 竖屏字幕内置样式已经按平台 UI 遮挡调过（文字块底边约 69% 高度、底部留白），**不要改回贴底**
- 横版不要套竖屏样式（`FontSize` 过大、`MarginV` 过小会溢出裁切）

## 字幕

- SRT 用分镜里的精确对白做校对文本，按最终发声对齐
- 长句会按标点自动折行（默认每行 ≤16 字，可用 manifest 的 `subtitle_chars` 调）
- 字体按平台自动选：macOS 用 **Hiragino Sans GB**（PingFang SC 在 libass 下会渲染成豆腐块），
  Windows 用雅黑，Linux 用思源。要换字体写 manifest 的 `font` 字段
- 字号默认 `FontSize=8`：在 libass 默认 PlayResY=288 下，720 宽竖屏正好放得下 16 个字；
  调到 10 会撑出画幅被裁边
- **位置贴画面下方**（`MarginV=40`，720x1280 下离底约 178px）。用户明确要求字幕靠下，不要上移到画面中部；
  但也不要贴到最底（`MarginV<20` 会被平台账号/描述区压住）
- 字幕失败会自动降级成无字幕重试；**降级了要在报告里说明**，不能默认观众看到了字幕
- 花字、动效目前不在 DSH 里做，需要时用 `dsh-remotion` 走 React 工程

## 两种声音方案

| 方案 | 怎么做 | 优点 | 代价 |
| --- | --- | --- | --- |
| **原生语音**（推荐做口播） | `project.json` 的 `audioMode` 设 `native`，台词写进 `dialogue`；Gemini 生成时直接念 | 口型天然对得上，不用配音 | 每镜独立生成，音色可能漂；必须人工试听 |
| **后配 TTS** | `audioMode` 设 `post`，`tts_generate` 生成 wav 放 `assets/voices/<镜号>.wav` | 一个音色，前后绝对一致 | 口型对不上——画面里的人**不能张嘴** |

选原生语音时，`short_compose` 会自动保留每条镜头的同期声（视频用 `xfade`、音频用 `acrossfade` 同步过渡），不再混 TTS。

### 首帧接力（只有需要连续时才做）

相邻镜头是**同一个人物、同一个空间**时，用上一镜的尾帧当下一镜首帧，衔接才自然：

1. 上一镜验收通过
2. 从它的**采用区间末尾**抽一帧（`ffmpeg -ss <sourceOut-0.05> -i clip -frames:v 1`）
3. `import-asset <项目> startFrame <镜号>_START v00N <帧路径>`
4. 把这一镜的 `startFrame` 指到这版，`transitionIn` 改成「硬切」

**不需要接力的情况**：换场、换景别方向、明确要转场（叠化）——这时单独备首帧，不要等上一镜。接力会让两次生成共享同一个画面，衔接更顺但也会把上一镜的瑕疵带过来。

## 配音

用 `tts_generate`（MiMo TTS），三种模式：

| 模式 | 用途 | 关键参数 |
| --- | --- | --- |
| `preset`（默认） | 预置音色 | `voice`：茉莉 / 冰糖 / 苏打 / 白桦（中文），Mia / Chloe / Milo / Dean（英文） |
| `design` | 用一段话设计音色 | `style` 写音色描述，**必填**；`voice` 不用给 |
| `clone` | 用样本复刻音色 | `sample` 给 mp3/wav 路径，**必填**；样本不超过 10MB |

### 语气和节奏怎么控

**两条路，可以叠加**

1. **`style`（自然语言指令）** —— 走 user 消息，管整体：
   「语速偏慢，气声多一点，像自言自语」「用轻快上扬的语调，带着压抑不住的激动」
   复杂一点的可以按「角色 / 场景 / 指导」三段写，模型会照着演。

2. **文本里的标签** —— 走 assistant 消息，管细节：
   - **整体风格**：放文本最开头，`(怅然)`、`(东北话)`、`(磁性)`、`(慵懒)`；多个风格写在同一对括号里
   - **细粒度**：句中任意位置插 `[叹气]`、`[轻笑]`、`[语速加快]`、`[深呼吸]`、`[哽咽]`

   ```
   (紧张，深呼吸)呼……冷静，冷静。不就是一个面试吗……（语速加快，碎碎念）自我介绍已经背了五十遍了。
   ```

3. **唱歌**：`sing=true` 或让文本以 `(唱歌)` 开头。只有 `preset` 模式支持。

### 实战规则

- 多音字**在文本里直接写同音字**（朝 zhāo / 还 huán / 重 chóng），别指望模型读对
- 一条配音一个 wav，按 `delay_ms` 排进 manifest；别拼成一整条，改一句要重做
- 标签不要滥用：每句都加 `[叹气]` 会变得很吵，只在关键节点用
- 没有 key 时：给用户要 wav，或按无声成片交付并说明。**不要假装已经配好音。**

## 用剪切末帧接下一镜（替代 ChatCut 的做法）

1. 用 `video_assemble` 或 `video_compose` 把上一镜按保留区间定剪。
2. 用 ffmpeg 抽该区间的**最后一帧**作为下一镜首帧（成片里没有字幕/花字的那一版）。
3. 把这张图 `import-asset` 登记成 `startFrame`，再走 `gemini_image` 的参考图 → `bridge-generate`。
4. 上一镜的剪点改了，必须重新抽帧重生成续镜。

## 验收

合成后至少跑一次 `media_verify`：

- `brightness` 查白屏/黑屏；
- 有配音就跑 `astats`，核对每条配音窗口的能量和静默窗；
- 需要确认线上和本版一致时跑 `audio-ncc`。

抽帧证据存 `assets/frames/review/`，时间线/选段记录仍写进项目的 `tasks.json`。
