#!/usr/bin/env python3
"""Generate one image for a short, a story or a feed post.

    python3 image.py "<prompt>" out.png [--aspect 9:16|4:5|1:1] [--quality low|medium|high]

Provider by env IMAGE_PROVIDER: "openai" (default, gpt-image-2, needs OPENAI_API_KEY) or "gemini"
(Nano Banana, needs GEMINI_API_KEY). Override the model with IMAGE_MODEL. In an interactive or
triggered Kortix session you can use the built-in `image_gen` tool instead of this script.
Every call is appended to image-spend.jsonl next to the output, so the monthly budget is checkable.
"""
import base64, json, os, sys, time, urllib.request

SIZES = {"9:16": "1024x1536", "4:5": "1024x1536", "2:3": "1024x1536", "1:1": "1024x1024", "16:9": "1536x1024"}
PRICE = {"low": 0.006, "medium": 0.053, "high": 0.211}   # OpenAI calculator estimates, 1024px gpt-image-2; check your plan

def post(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": "curl/8", **headers})
    try: return json.load(urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e: sys.exit(f"{url.split('/')[2]} HTTP {e.code}: {e.read()[:400].decode(errors='ignore')}")

def main():
    prompt, out = sys.argv[1], sys.argv[2]
    aspect = sys.argv[sys.argv.index("--aspect") + 1] if "--aspect" in sys.argv else "9:16"
    quality = sys.argv[sys.argv.index("--quality") + 1] if "--quality" in sys.argv else "medium"
    provider = os.environ.get("IMAGE_PROVIDER", "openai")
    if provider == "openai":
        model = os.environ.get("IMAGE_MODEL", "gpt-image-2")
        r = post("https://api.openai.com/v1/images/generations",
                 {"model": model, "prompt": prompt, "size": SIZES.get(aspect, "1024x1536"), "quality": quality, "n": 1},
                 {"Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]})
        data = base64.b64decode(r["data"][0]["b64_json"]); cost = PRICE.get(quality, 0.05)
    elif provider == "gemini":
        model = os.environ.get("IMAGE_MODEL", "gemini-2.5-flash-image")
        r = post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                 {"contents": [{"parts": [{"text": f"{prompt}\nAspect ratio {aspect}."}]}],
                  "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": aspect}}},
                 {"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
        part = next((p for c in r.get("candidates", []) for p in c.get("content", {}).get("parts", []) if "inlineData" in p), None)
        if not part: sys.exit("gemini returned no image: " + json.dumps(r)[:300])
        data = base64.b64decode(part["inlineData"]["data"]); cost = 0.04
    else:
        sys.exit("IMAGE_PROVIDER must be openai or gemini")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    open(out, "wb").write(data)
    with open(os.path.join(os.path.dirname(os.path.abspath(out)), "image-spend.jsonl"), "a") as f:
        f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "provider": provider, "model": model,
                            "aspect": aspect, "quality": quality, "usd_est": cost, "file": os.path.basename(out), "prompt": prompt}) + "\n")
    print(json.dumps({"out": out, "provider": provider, "model": model, "usd_est": cost}))

if __name__ == "__main__":
    main()
