# 第三方脚本来源

本目录三个脚本取自 npm 包 `dsh-video-pipeline@0.1.3`（作者 vfvrpq），MIT License：

- `video_compose.py` ← `skills/video-compose/scripts/video-compose.py`
- `image2video.py` ← `skills/image-to-video/scripts/image2video.py`
- `media_verify.py` ← `skills/media-verify/scripts/media_verify.py`

Copyright (c) 2026 vfvrpq — MIT License（见上游 LICENSE）。
本插件只做了重命名与调用封装，未修改脚本逻辑。
运行时通过环境变量 `FFMPEG` 指定 ffmpeg 路径。
- `mimo_tts.py` ← `skills/chinese-tts/scripts/mimo_tts.py`（同上 MIT）
