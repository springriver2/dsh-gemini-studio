# 第三方代码

## dsh-video-pipeline（MIT）

`py/video_compose.py`、`py/image2video.py`、`py/media_verify.py`、`py/mimo_tts.py`
来自 npm 包 [`dsh-video-pipeline`](https://www.npmjs.com/package/dsh-video-pipeline) v0.1.3，
作者 vfvrpq，MIT License。

- `video_compose.py`：在原脚本基础上增加了**转场（xfade/acrossfade）**、**原生音轨**、
  **按语言折行**、**平台字体**、**每镜裁剪** 等改动，其余逻辑保持一致。
- 其余三个脚本只做了重命名，未改逻辑。

Copyright (c) 2026 vfvrpq — MIT License。

## 字体

字幕默认使用系统字体（macOS: Hiragino Sans GB / Windows: Microsoft YaHei / Linux: Noto Sans CJK SC），
不随包分发任何字体文件。

## ffmpeg

插件不打包 ffmpeg 二进制。使用顺序：配置的路径 → 工作区 `tools/ffmpeg/node_modules/ffmpeg-static` → 系统 `ffmpeg`。
FFmpeg 采用 LGPL/GPL 许可，分发二进制时请自行遵守其条款。
