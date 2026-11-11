#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mimo_tts — MiMo TTS 直调（预置音色 / 音色设计 / 音色复刻）。

POST https://api.xiaomimimo.com/v1/chat/completions

三种模式（对应官方三个模型）：
  preset    mimo-v2.5-tts             预置音色，支持 (唱歌)
  design    mimo-v2.5-tts-voicedesign  用一段文字描述音色
  clone     mimo-v2.5-tts-voiceclone   用音频样本复刻音色

风格控制两条路（都随请求发出）：
  自然语言  → --style，落在 user 消息里
  音频标签  → 直接写进 --text，例如 "(怅然)这么多年过去了……"、"[叹气]我先眯一会儿"

key：~/.dsh/gemini-studio/secrets.json 的 mimoApiKey（插件面板里填的），
或 env MIMO_API_KEY，或 ~/.config/mimocode/mimocode.jsonc。

用法：
  python mimo_tts.py --text "(怅然)这么多年过去了，再走过那条街，心里一下子空了一块。" \
      --out vo.wav --voice 茉莉 --style "语速偏慢，气声多一点，像自言自语"
  python mimo_tts.py --model voicedesign --style "五十多岁的北方男人，嗓音沙哑沉稳" \
      --text "这事儿啊，得从三十年前说起。" --out vo.wav
  python mimo_tts.py --model clone --sample my.mp3 --text "这句话用我的声音读。" --out vo.wav
"""
import argparse
import base64
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request

URL = "https://api.xiaomimimo.com/v1/chat/completions"
MODELS = {
    "preset": "mimo-v2.5-tts",
    "design": "mimo-v2.5-tts-voicedesign",
    "clone": "mimo-v2.5-tts-voiceclone",
}
DEFAULT_VOICE = "茉莉"


def load_key():
    env = os.environ.get("MIMO_API_KEY")
    if env and env.strip():
        return env.strip()
    own = os.path.join(os.path.expanduser("~"), ".dsh", "gemini-studio", "secrets.json")
    try:
        data = json.loads(io.open(own, encoding="utf-8").read())
        if data.get("mimoApiKey"):
            return data["mimoApiKey"]
    except (OSError, ValueError):
        pass
    cfg = os.path.join(os.path.expanduser("~"), ".config", "mimocode", "mimocode.jsonc")
    try:
        raw = io.open(cfg, encoding="utf-8").read()
        m = re.search(r'"xiaomi"\s*:\s*\{[\s\S]*?"apiKey"\s*:\s*"([^"]+)"', raw)
        if m:
            return m.group(1)
    except OSError:
        pass
    sys.exit("缺少 MiMo API key：设 env MIMO_API_KEY，或写进 ~/.dsh/gemini-studio/secrets.json 的 mimoApiKey")


def audio_data_url(sample_path):
    if not os.path.exists(sample_path):
        sys.exit(f"音频样本不存在: {sample_path}")
    ext = os.path.splitext(sample_path)[1].lower()
    if ext not in (".mp3", ".wav"):
        sys.exit("音色复刻只支持 mp3 / wav 样本")
    raw = open(sample_path, "rb").read()
    if len(raw) > 7 * 1024 * 1024:
        sys.exit("样本过大：base64 后会超过 10MB 上限")
    mime = "audio/mpeg" if ext == ".mp3" else "audio/wav"
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def build_body(a):
    model = MODELS[a.mode]
    text = a.text
    if a.sing and not re.match(r"^\s*[(（\[]\s*(唱歌|sing|singing)", text):
        text = f"(唱歌){text}"

    user_style = a.style.strip()
    if a.mode == "preset":
        audio = {"format": "wav", "voice": a.voice or DEFAULT_VOICE}
        messages = [
            {"role": "user", "content": user_style or f"{audio['voice']}音色，自然朗读"},
            {"role": "assistant", "content": text},
        ]
    elif a.mode == "design":
        if not user_style:
            sys.exit("音色设计模式必须给 --style（音色描述）")
        audio = {"format": "wav"}
        if a.optimize_text_preview:
            audio["optimize_text_preview"] = True
        messages = [
            {"role": "user", "content": user_style},
            {"role": "assistant", "content": text},
        ]
    else:
        if not a.sample:
            sys.exit("音色复刻模式必须给 --sample（mp3/wav 样本路径）")
        audio = {"format": "wav", "voice": audio_data_url(a.sample)}
        messages = [
            {"role": "user", "content": user_style},
            {"role": "assistant", "content": text},
        ]

    return {
        "model": model,
        "modalities": ["audio", "text"],
        "audio": audio,
        "messages": messages,
    }


def main():
    ap = argparse.ArgumentParser(description="MiMo TTS：预置音色 / 音色设计 / 音色复刻")
    ap.add_argument("--text", required=True, help="朗读文本；风格标签 (怅然)、音频标签 [叹气] 直接写在这里")
    ap.add_argument("--out", help="输出 wav 路径（--dry-run 时可省）")
    ap.add_argument("--mode", choices=list(MODELS), default="preset", help="preset / design / clone")
    ap.add_argument("--voice", default=DEFAULT_VOICE, help="预置音色：茉莉/冰糖/苏打/白桦/Mia/Chloe/Milo/Dean")
    ap.add_argument("--style", default="", help="自然语言风格指令（user 消息）")
    ap.add_argument("--sample", default="", help="音色复刻的样本文件（mp3/wav）")
    ap.add_argument("--sing", action="store_true", help="唱歌模式：自动在开头加 (唱歌)")
    ap.add_argument("--optimize-text-preview", action="store_true", help="音色设计模式下让模型润色文本")
    ap.add_argument("--dry-run", action="store_true", help="只打印请求体，不真的调用")
    a = ap.parse_args()

    if a.mode == "preset" and a.voice not in (
        "mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean",
    ):
        print(f"[warn] 未在预置列表里的音色：{a.voice}", file=sys.stderr)

    body = build_body(a)
    if a.dry_run:
        safe = json.loads(json.dumps(body))
        if "voice" in safe["audio"] and str(safe["audio"]["voice"]).startswith("data:"):
            safe["audio"]["voice"] = safe["audio"]["voice"][:40] + "...(base64)"
        print(json.dumps(safe, ensure_ascii=False, indent=2))
        return

    if not a.out:
        sys.exit("缺 --out")

    key = load_key()
    req = urllib.request.Request(
        URL,
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            j = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read()[:300]}")
    except urllib.error.URLError as e:
        sys.exit(f"网络错误: {e}")

    try:
        b64 = j["choices"][0]["message"]["audio"]["data"]
    except (KeyError, IndexError, TypeError):
        sys.exit("响应无 audio: " + json.dumps(j, ensure_ascii=False)[:300])

    raw = base64.b64decode(b64)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
    open(a.out, "wb").write(raw)
    print(f"OK {a.out} {len(raw)}B mode={a.mode} voice={a.voice}")


if __name__ == "__main__":
    main()
