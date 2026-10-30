#!/usr/bin/env python3
"""Render a vertical short (1080x1920, 30 fps, H.264 + AAC) from stills, narration and word timings.

    python3 render_short.py spec.json

spec: {"shots": [{"image": "a.png", "duration": 3.2, "motion": "in"|"out"|"left"|"right"|"none",
                  "headline": "OPTIONAL 2-6 WORD ON-SCREEN TEXT"}],
       "narration": "narration.wav", "words": "words.json", "out": "final.mp4",
       "music": "bed.mp3" (optional), "music_db": -22, "caption_y": 1380, "headline_y": 330}
Shot durations must cover the whole narration; end 0.5-1.0 s after the last word.
Captions sit above the bottom 540 px and headlines below the top 250 px (platform UI zones).
"""
import json, os, subprocess, sys, tempfile

W, H, FPS = 1080, 1920, 30
ACTIVE, WHITE = r"{\c&H3FD8FF&}", r"{\c&HFFFFFF&}"     # ASS colours are BGR

def run(*a): subprocess.run(a, check=True)

def ts(t):
    h, r = divmod(max(t, 0), 3600); m, s = divmod(r, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"

def phrases(words, size=3):
    out, cur = [], []
    for w in words:
        if cur and (len(cur) == size or w.get("sentenceStart") or w["start"] - cur[-1]["end"] > 0.25
                    or cur[-1]["text"][-1] in ".!?"):
            out.append(cur); cur = []
        cur.append(w)
    return out + ([cur] if cur else [])

def esc(t): return t.replace("\\", "/").replace("{", "(").replace("}", ")").replace("\n", " ")

def ass(words, path, y, shots=(), head_y=330):
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,74,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,6,0,2,110,110,{H - y},1
Style: Head,DejaVu Sans,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,3,18,0,8,90,90,{head_y},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines, t = [], 0.0
    for s in shots:
        if s.get("headline"):
            lines.append(f"Dialogue: 1,{ts(t)},{ts(t + s['duration'])},Head,,0,0,0,,{esc(s['headline'])}")
        t += s["duration"]
    for p in phrases(words):
        for i, w in enumerate(p):
            end = p[i + 1]["start"] if i + 1 < len(p) else w["end"]
            text = " ".join(ACTIVE + esc(x["text"]) + WHITE if j == i else esc(x["text"]) for j, x in enumerate(p))
            lines.append(f"Dialogue: 0,{ts(w['start'])},{ts(end)},Cap,,0,0,0,,{text}")
    open(path, "w").write(head + "\n".join(lines) + "\n")

def motion(kind, frames):
    z = {"in": "min(1+0.10*on/{n},1.10)", "out": "max(1.10-0.10*on/{n},1)"}.get(kind, "1.08").format(n=frames)
    x = {"left": "(iw-iw/zoom)*(1-on/{n})", "right": "(iw-iw/zoom)*on/{n}"}.get(kind, "iw/2-(iw/zoom/2)").format(n=frames)
    return f"zoompan=z='{z}':x='{x}':y='ih/2-(ih/zoom/2)':d={frames}:s={W}x{H}:fps={FPS}"

def main():
    spec = json.load(open(sys.argv[1])); tmp = tempfile.mkdtemp(prefix="short-")
    words = json.load(open(spec["words"]))
    clips = []
    for i, s in enumerate(spec["shots"]):
        frames = max(1, round(s["duration"] * FPS)); clip = f"{tmp}/shot{i}.mp4"
        vf = (f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},scale={W*2}:{H*2},"
              f"{motion(s.get('motion', 'in'), frames)},format=yuv420p")
        run("ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", s["image"], "-frames:v", str(frames), "-vf", vf,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-r", str(FPS), clip)
        clips.append(clip)
    open(f"{tmp}/list.txt", "w").write("".join(f"file '{c}'\n" for c in clips))
    run("ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", f"{tmp}/list.txt", "-c", "copy", f"{tmp}/visual.mp4")
    ass(words, f"{tmp}/captions.ass", spec.get("caption_y", 1380), spec["shots"], spec.get("headline_y", 330))
    total = sum(s["duration"] for s in spec["shots"])
    inputs = ["-i", f"{tmp}/visual.mp4", "-i", spec["narration"]]
    voice = f"[1:a]apad,atrim=0:{total},aresample=48000[vo]"
    if spec.get("music"):
        inputs += ["-stream_loop", "-1", "-i", spec["music"]]
        audio = (f"{voice.replace('[vo]', ',asplit[vo][key]')};[2:a]atrim=0:{total},volume={spec.get('music_db', -22)}dB,afade=t=out:st={max(0, total-1.5)}:d=1.5,aresample=48000[mu];"
                 f"[mu][key]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[duck];"
                 f"[vo][duck]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]")
    else:
        audio = f"{voice};[vo]loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    run("ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex",
        f"[0:v]ass={tmp}/captions.ass,format=yuv420p[v];{audio}", "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", str(total), "-movflags", "+faststart", spec["out"])
    print(json.dumps({"out": spec["out"], "seconds": round(total, 2)}))

if __name__ == "__main__":
    main()
