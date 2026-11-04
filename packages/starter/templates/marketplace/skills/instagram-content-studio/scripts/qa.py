#!/usr/bin/env python3
"""Machine checks for a finished vertical short. Prints JSON; exit 1 on any failure.

    python3 qa.py final.mp4 --max 90 [--frames qa-frames]
"""
import json, os, re, subprocess, sys

def out(*a):
    r = subprocess.run(a, capture_output=True, text=True)
    return r.stderr + r.stdout

def main():
    f = sys.argv[1]; mx = float(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 90
    frames = sys.argv[sys.argv.index("--frames") + 1] if "--frames" in sys.argv else "qa-frames"
    p = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", f]))
    v = next(s for s in p["streams"] if s["codec_type"] == "video"); a = next((s for s in p["streams"] if s["codec_type"] == "audio"), {})
    dur = float(p["format"]["duration"])
    decode = subprocess.run(["ffmpeg", "-v", "error", "-i", f, "-f", "null", "-"], capture_output=True, text=True).stderr.strip()
    loud = out("ffmpeg", "-hide_banner", "-i", f, "-af", "ebur128=peak=true", "-f", "null", "-")
    lufs = re.findall(r"I:\s*(-?[\d.]+) LUFS", loud)
    peak = re.findall(r"Peak:\s*(-?[\d.]+) dBFS", loud)
    sil = out("ffmpeg", "-hide_banner", "-i", f, "-af", "silencedetect=noise=-40dB:d=0.7", "-f", "null", "-")
    gaps = [float(x) for x in re.findall(r"silence_duration: ([\d.]+)", sil)]
    os.makedirs(frames, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f, "-vf", "fps=1", f"{frames}/s%03d.png"], check=True)
    checks = {
        "format_1080x1920": (v["width"], v["height"]) == (1080, 1920),
        "h264_yuv420p": v["codec_name"] == "h264" and v.get("pix_fmt") == "yuv420p",
        "fps_23_to_60": 23 <= (lambda n, d: int(n) / int(d))(*v["r_frame_rate"].split("/")) <= 60,
        "aac_audio": a.get("codec_name") == "aac",
        "duration_ok": 3 <= dur <= mx,
        "decodes_clean": decode == "",
        "loudness_-16_to_-12": bool(lufs) and -16 <= float(lufs[-1]) <= -12,
        "true_peak_below_-1": bool(peak) and float(peak[-1]) <= -1.0,
        "no_dead_air_over_0.7s": not gaps,
        "faststart": open(f, "rb").read(200000).find(b"moov") != -1,
    }
    report = {"passed": all(checks.values()), "checks": checks, "duration": round(dur, 2),
              "lufs": float(lufs[-1]) if lufs else None, "frames_dir": frames, "frames": len(os.listdir(frames))}
    print(json.dumps(report, indent=1)); sys.exit(0 if report["passed"] else 1)

if __name__ == "__main__":
    main()
