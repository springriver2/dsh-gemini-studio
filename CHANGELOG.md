# 变更记录

## 0.3.0

- `short_compose`：读分镜与验收记录直接出片，自动配转场、声音、字幕
- 原生语音（`audioMode: native`）：Gemini 自己念台词，视频/音频同步过渡
- `retime_shots`：按人声收尾重排剪入时长
- `tts_generate`：MiMo TTS 三种模式（预置音色 / 文字设计 / 样本复刻）
- 字幕：平台字体、字号 8、中文按字数折行、拉丁按词折行、位置贴画面下方
- 内置短剧制作规范技能，安装后自动注册
- 桥改为随包分发，默认走包内 `bridge/`

## 0.2.0

- 工作室面板：账号、生成、作品墙、MiMo key
- 面板 API 改为 Node handler（支持 POST）

## 0.1.0

- 首个版本：`gemini_image` / `gemini_video` / `gemini_accounts`
