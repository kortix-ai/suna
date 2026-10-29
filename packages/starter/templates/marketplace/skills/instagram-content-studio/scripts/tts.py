#!/usr/bin/env python3
"""Narrate a script, one sentence per request, and write narration.wav + words.json.

    python3 tts.py script.txt out_dir [--voice VOICE_ID] [--gap 0.30]
    python3 tts.py --list-voices

Provider: ElevenLabs /with-timestamps (character timings -> exact word timings).
Each sentence is voiced separately, so one bad sentence can be re-voiced alone.
"""
import base64, json, os, re, subprocess, sys, urllib.request

def say(text, voice, model):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps?output_format=mp3_44100_128",
        data=json.dumps({"text": text, "model_id": model}).encode(),
        headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": "application/json",
                 "User-Agent": "curl/8"})
    return json.load(urllib.request.urlopen(req, timeout=120))

def words_from_alignment(al, offset):
    words, cur, start, end = [], "", None, None
    for ch, s, e in zip(al["characters"], al["character_start_times_seconds"], al["character_end_times_seconds"]):
        if ch.isspace():
            if cur: words.append({"text": cur, "start": round(offset + start, 3), "end": round(offset + end, 3)})
            cur, start = "", None
            continue
        if start is None: start = s
        cur, end = cur + ch, e
    if cur: words.append({"text": cur, "start": round(offset + start, 3), "end": round(offset + end, 3)})
    return words

def duration(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                          "-of", "csv=p=0", path]).decode())

def main():
    if "--list-voices" in sys.argv:
        req = urllib.request.Request("https://api.elevenlabs.io/v1/voices", headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"], "User-Agent": "curl/8"})
        for v in json.load(urllib.request.urlopen(req, timeout=60))["voices"]:
            print(v["voice_id"], "|", v["name"], "|", json.dumps(v.get("labels", {})))
        return
    script, out = sys.argv[1], sys.argv[2]
    voice = sys.argv[sys.argv.index("--voice") + 1] if "--voice" in sys.argv else os.environ.get("TTS_VOICE_ID", "")
    model = os.environ.get("TTS_MODEL", "eleven_multilingual_v2")
    gap = float(sys.argv[sys.argv.index("--gap") + 1]) if "--gap" in sys.argv else 0.30
    if not voice: sys.exit("set --voice or TTS_VOICE_ID")
    os.makedirs(out, exist_ok=True)
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", open(script).read().strip()) if s.strip()]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                    "-t", str(gap), f"{out}/gap.wav"], check=True)
    parts, words, t, timings = [], [], 0.0, []
    for i, s in enumerate(sentences):
        r = say(s, voice, model)
        mp3 = f"{out}/sentence-{i+1}.mp3"; wav = f"{out}/sentence-{i+1}.wav"
        open(mp3, "wb").write(base64.b64decode(r["audio_base64"]))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp3, "-ar", "44100", "-ac", "1", wav], check=True)
        w = words_from_alignment(r["alignment"], t)
        if w: w[0]["sentenceStart"] = True
        words += w
        d = duration(wav)
        timings.append({"text": s, "start": round(t, 3), "end": round(t + d, 3)})
        parts += [wav, f"{out}/gap.wav"]; t += d + gap
    open(f"{out}/concat.txt", "w").write("".join(f"file '{os.path.abspath(p)}'\n" for p in parts[:-1]))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", f"{out}/concat.txt",
                    "-c:a", "pcm_s16le", f"{out}/narration.wav"], check=True)
    json.dump(words, open(f"{out}/words.json", "w"), indent=1)
    json.dump(timings, open(f"{out}/sentences.json", "w"), indent=1)
    print(json.dumps({"sentences": len(sentences), "seconds": round(duration(f'{out}/narration.wav'), 2)}))

if __name__ == "__main__":
    main()
