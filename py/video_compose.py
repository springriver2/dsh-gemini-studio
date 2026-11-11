#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""video-compose — 镜头 mp4 列表 + 配音 wav 时间轴 + SRT → 成片（原子合成一条）。

输入 = 一个 manifest JSON（编排层负责生成 manifest；本脚本只做合成）：
{
  "out": "EPxxA-成片.mp4",
  "total": 32,                    // 成片总秒数（-t）
  "fps": 24,
  "w": 720, "h": 1280,            // 可省略，默认竖屏 720x1280
  "shots":  [{"file": "v1.mp4"}, {"file": "v2.mp4", "transition": 0.4}],
  "audio":  [{"file": "vo0.wav", "delay_ms": 0}, ...],      // 可为 []
  "subtitles": "subs.srt",        // 可省略
  "style": "FontName=..."         // 可省略（用内置竖屏样式）
}

transition = 从上一个镜头叠化进本镜头的秒数（0/缺省 = 硬切）。

行为源自 build_ep11a/build_read_batch 的成熟路径：归一化 → 拼接 → adelay/amix 混音
→ 烧字幕 → -movflags +faststart；烧字幕失败自动降级重试。
有转场时改用 filter_complex 的 xfade/concat 链接，两遍编码（先合成、再烧字幕）。
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

# 字体必须选系统里真的有中文字形的：macOS 的 PingFang SC 在 libass 下会渲染成豆腐块，
# 实测 Hiragino Sans GB 正常；Windows 用雅黑；Linux 用思源。
import platform

DEFAULT_FONT = {
    "Darwin": "Hiragino Sans GB",
    "Windows": "Microsoft YaHei",
}.get(platform.system(), "Noto Sans CJK SC")

# FontSize 8 在 libass 默认 PlayResY=288 下、720 宽竖屏里正好放得下 16 个中文字；
# 原来的 10 会撑出画幅被裁边。
# 字幕要贴画面下方（用户 2026-11 明确要求）：MarginV=40 在 PlayResY=288 下
# 约等于离底 178px（720x1280 时），既靠下又不会压到平台底部的账号/描述区。
DEFAULT_STYLE = (f"FontName={DEFAULT_FONT},FontSize=8,PrimaryColour=&H00FFFFFF,"
                 "OutlineColour=&H00000000,BorderStyle=1,Outline=1.5,MarginV=40")


def find_ffmpeg():
    p = os.environ.get("FFMPEG")
    if p and os.path.exists(p):
        return p
    w = shutil.which("ffmpeg")
    if w:
        return w
    return None


def run(cmd, cwd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print((r.stderr or "")[-2500:])
    return r.returncode == 0


def probe_duration(ff, path):
    r = subprocess.run([ff, "-i", path], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr or "")
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))



def wrap_srt_line(line, limit=16):
    """中文按字数折行；拉丁文按词折行（按字数折会把单词劈开）。"""
    if len(line) <= limit:
        return line
    cjk = sum(1 for ch in line if "\u4e00" <= ch <= "\u9fff")
    if cjk >= max(1, int(len(line) * 0.3)):
        out, buf = [], ""
        for ch in line:
            buf += ch
            if len(buf) >= limit and ch in "，。！？；：、,.!?;:":
                out.append(buf)
                buf = ""
            elif len(buf) >= limit + 5:
                out.append(buf)
                buf = ""
        if buf:
            out.append(buf)
        return "\n".join(out)

    # 拉丁：按词装行，行宽约 2.2 倍字数
    limit_chars = max(20, int(limit * 2.2))
    out, buf = [], ""
    for word in line.split(" "):
        cand = (buf + " " + word).strip()
        if len(cand) > limit_chars and buf:
            out.append(buf)
            buf = word
        else:
            buf = cand
    if buf:
        out.append(buf)
    return "\n".join(out)


def wrap_srt(text, limit=16):
    lines = text.splitlines()
    res = []
    for i, line in enumerate(lines):
        bare = line.strip()
        is_meta = (not bare) or bare.isdigit() or "-->" in bare
        res.append(line if is_meta else wrap_srt_line(bare, limit))
    return "\n".join(res)



def probe_audio(ff, path):
    r = subprocess.run([ff, "-i", path], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return bool(re.search(r"Stream #\d+:\d+.*Audio:", r.stderr or ""))


def main():
    ap = argparse.ArgumentParser(description="manifest → 成片")
    ap.add_argument("manifest", help="manifest JSON 路径")
    ap.add_argument("--keep-build", action="store_true", help="保留中间目录")
    a = ap.parse_args()

    ff = find_ffmpeg()
    if not ff:
        sys.exit("ffmpeg 未找到：设置环境变量 FFMPEG=<路径>")
    with open(a.manifest, encoding="utf-8") as f:
        m = json.load(f)
    shots = m["shots"]
    audio = m.get("audio") or []
    total = float(m["total"])
    fps = int(m.get("fps") or 24)
    w = int(m.get("w") or 720)
    h = int(m.get("h") or 1280)
    out = os.path.abspath(m["out"])
    base = os.path.dirname(os.path.abspath(a.manifest))

    def res(p):
        return p if os.path.isabs(p) else os.path.join(base, p)

    bdir = out + ".build"
    if os.path.isdir(bdir):
        shutil.rmtree(bdir)
    os.makedirs(bdir)

    # 1) 归一化
    paths = []
    for i, s in enumerate(shots):
        src = res(s["file"])
        if not os.path.exists(src):
            sys.exit(f"镜头不存在: {src}")
        shot = os.path.join(bdir, f"shot{i:02d}.mp4")
        vf = f"scale={w}:{h}:flags=lanczos,fps={fps},format=yuv420p"
        cmd = [ff, "-y"]
        if s.get("start") not in (None, ""):
            cmd += ["-ss", str(s["start"])]
        native = m.get("audioSource") == "native"
        has_a = probe_audio(ff, src) if native else False
        if native and not has_a:
            cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        cmd += ["-i", src, "-vf", vf, "-c:v", "libx264",
                "-preset", "veryfast", "-crf", "18"]
        if native:
            cmd += ["-map", "0:v:0", "-map", "0:a:0" if has_a else "1:a:0",
                    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest"]
        else:
            cmd += ["-an"]
        if s.get("duration") not in (None, ""):
            cmd += ["-t", str(s["duration"])]
        cmd.append(shot)
        if not run(cmd, bdir):
            sys.exit("归一化失败")
        paths.append(shot)
    with open(os.path.join(bdir, "shots.txt"), "w", encoding="utf-8") as f:
        for p in paths:
            f.write(f"file '{os.path.basename(p)}'\n")

    # 2) 拷贝配音与字幕（相对路径规避中文/空格问题）
    subs_src = m.get("subtitles")
    if subs_src:
        src = res(subs_src)
        try:
            with open(src, encoding="utf-8") as f:
                wrapped = wrap_srt(f.read(), int(m.get("subtitle_chars") or 16))
            with open(os.path.join(bdir, "subs.srt"), "w", encoding="utf-8") as f:
                f.write(wrapped)
        except (OSError, UnicodeDecodeError):
            shutil.copyfile(src, os.path.join(bdir, "subs.srt"))
    for i, au in enumerate(audio, 1):
        shutil.copyfile(res(au["file"]), os.path.join(bdir, f"vo{i}.wav"))

    n = len(audio)
    style = m.get("style") or (
        DEFAULT_STYLE.replace(f"FontName={DEFAULT_FONT}", f"FontName={m['font']}") if m.get("font") else DEFAULT_STYLE
    )
    tmp = os.path.join(bdir, "out.mp4")

    def audio_parts(offset):
        parts, mixes = [], []
        for i, au in enumerate(audio, 1):
            parts.append(f"[{offset + i}:a]adelay={int(au['delay_ms'])}:all=1[a{i}]")
            mixes.append(f"[a{i}]")
        if n:
            parts.append("".join(mixes) + f"amix=inputs={n}:normalize=0:duration=longest,apad[aout]")
        return parts

    # ---- A. 有转场：filter_complex 链式 xfade / concat，两遍编码 ----
    has_trans = any(float(s.get("transition") or 0) > 0.05 for s in shots[1:])
    if has_trans:
        durs = [probe_duration(ff, p) for p in paths]
        if any(d is None for d in durs):
            sys.exit("探测镜头时长失败，无法计算转场偏移")

        # xfade 要求两路输入时间基一致；链式拼接时中间结果的时间基会变，
        # 所以每一路都先 fps + settb=AVTB 归一到同一时间基，否则第二处转场就会炸。
        parts = []
        labels = []
        for i in range(len(paths)):
            lbl = f"[p{i}]"
            parts.append(f"[{i}:v]fps={fps},settb=AVTB{lbl}")
            labels.append(lbl)
        cur = labels[0]
        cur_dur = durs[0]
        for i in range(1, len(paths)):
            t = float(shots[i].get("transition") or 0)
            outl = f"[v{i}]"
            if t > 0.05 and cur_dur > t + 0.1 and durs[i] > t + 0.1:
                offset = cur_dur - t
                parts.append(f"{cur}{labels[i]}xfade=transition=fade:duration={t:.3f}:offset={offset:.3f}{outl}")
                cur_dur = cur_dur + durs[i] - t
            else:
                parts.append(f"{cur}{labels[i]}concat=n=2:v=1:a=0{outl}")
                cur_dur += durs[i]
            cur = outl
        # 音频输入从 len(paths) 开始；audio_parts 内部用 offset+i（i 从 1 起），所以传 k-1
        if m.get("audioSource") == "native":
            acur = "[0:a]"
            for i in range(1, len(paths)):
                t = float(shots[i].get("transition") or 0)
                if t > 0.05:
                    aout = f"[ax{i}]"
                    parts.append(f"{acur}[{i}:a]acrossfade=d={t:.3f}:c1=tri:c2=tri{aout}")
                else:
                    aout = f"[ax{i}]"
                    parts.append(f"{acur}[{i}:a]concat=n=2:v=0:a=1{aout}")
                acur = aout
            aout_final = acur
        else:
            parts += audio_parts(len(paths) - 1)
            aout_final = "[aout]" if n else None

        cmd = [ff, "-y"]
        for p in paths:
            cmd += ["-i", os.path.basename(p)]
        for i in range(1, n + 1):
            cmd += ["-i", f"vo{i}.wav"]
        cmd += ["-filter_complex", ";".join(parts), "-map", cur]
        if aout_final:
            cmd += ["-map", aout_final]
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
        if aout_final:
            cmd += ["-c:a", "aac", "-b:a", "128k"]
        cmd += ["-t", str(total), "-movflags", "+faststart", tmp]
        if not run(cmd, bdir):
            sys.exit("转场合成失败")

        if subs_src:
            burned = os.path.join(bdir, "out-sub.mp4")
            vf = f"subtitles=subs.srt:force_style='{style}'"
            cmd2 = [ff, "-y", "-i", "out.mp4", "-vf", vf,
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
            cmd2 += ["-c:a", "copy"] if n else []
            cmd2 += ["-t", str(total), "-movflags", "+faststart", burned]
            if run(cmd2, bdir):
                tmp = burned
            else:
                print("retry without subs")

        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copyfile(tmp, out)
        if not a.keep_build:
            shutil.rmtree(bdir, ignore_errors=True)
        print(f"OK {out} {os.path.getsize(out)}B (total={total}s, shots={len(shots)}, "
              f"voices={n}, transitions={sum(1 for s in shots[1:] if float(s.get('transition') or 0) > 0.05)})")
        return

    # ---- B. 无转场：原来的单遍 concat 路径 ----
    vf = f"subtitles=subs.srt:force_style='{style}'"

    def build(with_subs, dest):
        cmd = [ff, "-y", "-f", "concat", "-safe", "0", "-i", "shots.txt"]
        for i in range(1, n + 1):
            cmd += ["-i", f"vo{i}.wav"]
        cmd += ["-map", "0:v"]
        if m.get("audioSource") == "native":
            cmd += ["-map", "0:a"]
            parts = []
        else:
            parts = audio_parts(0)
            if n:
                cmd += ["-filter_complex", ";".join(parts), "-map", "[aout]"]
        cmd += ["-vf", vf if with_subs else "null",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
        if n or m.get("audioSource") == "native":
            cmd += ["-c:a", "aac", "-b:a", "128k"]
        cmd += ["-t", str(total), "-movflags", "+faststart", dest]
        return run(cmd, bdir)

    if subs_src:
        if not build(True, tmp):
            print("retry without subs")
            if not build(False, tmp):
                sys.exit("合成失败")
    else:
        if not build(False, tmp):
            sys.exit("合成失败")

    os.makedirs(os.path.dirname(out), exist_ok=True)
    shutil.copyfile(tmp, out)
    if not a.keep_build:
        shutil.rmtree(bdir, ignore_errors=True)
    print(f"OK {out} {os.path.getsize(out)}B (total={total}s, shots={len(shots)}, voices={n})")


if __name__ == "__main__":
    main()
