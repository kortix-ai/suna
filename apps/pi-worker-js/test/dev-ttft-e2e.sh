#!/usr/bin/env bash
# FROM SEND TO ANSWER, WHICH IS THE ONLY LATENCY A USER HAS.
#
# Every other number in this suite measures a part: a route's isolate time, an
# attach, a provision. This one measures the whole thing the way the product
# experiences it — open the session's event stream, post a prompt, and stamp
# what comes back. Measured on dev 2026-09-15, warm session:
#
#   accepted 240ms · user echo 630ms · FIRST TOKEN 2056ms · done 2112ms
#
# and the cell's own share of that turn was ~10 ms. So the budget here is not a
# performance target, it is a REGRESSION FENCE: the model is most of it and we
# do not control the model, but the ~600 ms in front of it is ours, and a change
# that doubles it must fail something.
#
# The stream is stamped in python, not in a shell loop — a per-line shell stamp
# adds ~50 ms a line and invents a throttle that is not there.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$PATH
N=$(dirname "$0")
BASE=${KORTIX_E2E_BASE:-https://pi-js.kortix.com}
PROJ=${KORTIX_E2E_PROJECT:-}
[ -n "${PROJ:-}" ] || { echo "  SKIP: no KORTIX_E2E_PROJECT"; exit 0; }
export BASE PROJ
python3 - <<'PYEOF'
import json, os, random, string, threading, time, urllib.request, sys

BASE, PROJ = os.environ["BASE"], os.environ["PROJ"]
UA = "curl/8.7.1"   # the edge answers 1010 to a default python agent
PASS = FAIL = 0
def ck(name, cond, detail=""):
    global PASS, FAIL
    if cond: print(f"  PASS {name}"); PASS += 1
    else: print(f"  FAIL {name} {detail}"); FAIL += 1

def api(path, token, method="GET", body=None, timeout=120):
    req = urllib.request.Request(f"{BASE}{path}", method=method)
    req.add_header("user-agent", UA)
    if token: req.add_header("authorization", f"Bearer {token}")
    if body is not None:
        req.add_header("content-type", "application/json"); body = json.dumps(body).encode()
    with urllib.request.urlopen(req, body, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")

try:
    tok = api("/v1/auth/sign-in/password", "", "POST",
              {"email": os.environ.get("KORTIX_E2E_USER", "pt-e2e-1788648166@example.test"),
               "password": os.environ.get("KORTIX_E2E_PASS", "Pt-e2e-2026!x")})["session"]["access_token"]
except Exception as e:
    print(f"  SKIP: sign-in unreachable ({e})"); sys.exit(0)

sid = api(f"/v1/projects/{PROJ}/sessions", tok, "POST", {})["session_id"]
for _ in range(8):
    if api(f"/v1/projects/{PROJ}/sessions/{sid}/start?wait_ms=8000", tok, "POST", {}).get("stage") == "ready": break
print(f"  session {sid[:8]}")

def turn(prompt):
    marks, done, state = [], threading.Event(), {"t0": None}
    def stream():
        req = urllib.request.Request(f"{BASE}/v1/p/{sid}/8080/global/event")
        req.add_header("user-agent", UA); req.add_header("authorization", f"Bearer {tok}")
        req.add_header("accept", "text/event-stream")
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                for raw in r:
                    if state["t0"] is None:
                        marks.append((0, "attached")); continue
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"): continue
                    ms = int((time.time() - state["t0"]) * 1000)
                    try: kind = (json.loads(line[5:].strip()) or {}).get("type") or "?"
                    except Exception: continue
                    marks.append((ms, kind))
                    if kind == "session.idle": done.set(); return
        except Exception as e:
            marks.append((-1, f"stream-error:{e}")); done.set()
    threading.Thread(target=stream, daemon=True).start()
    for _ in range(120):
        if marks: break
        time.sleep(0.05)
    marks.clear()
    h = "".join(random.choice("0123456789abcdef") for _ in range(12))
    t = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(14))
    state["t0"] = time.time()
    api(f"/v1/projects/{PROJ}/sessions/{sid}/prompts", tok, "POST",
        {"client_message_id": "cm-" + h, "message_id": "msg_" + h + t, "parts": [{"type": "text", "text": prompt}]})
    accepted = int((time.time() - state["t0"]) * 1000)
    done.wait(90)
    first = lambda *kinds: next((ms for ms, k in marks if k in kinds), None)
    return {"accepted": accepted, "echo": first("message.updated"), "token": first("message.part.delta", "message.part.updated"),
            "idle": first("session.idle"), "marks": marks}

cold = turn("Reply with only the word: one")
ck("a prompt is ACCEPTED promptly — the composer must not sit on the user's message",
   cold["accepted"] is not None and cold["accepted"] < 2_000, f"accepted in {cold['accepted']} ms")

warm = turn("Reply with only the word: two")
ck("the user's own message is echoed BEFORE the model answers, so the transcript is never empty",
   warm["echo"] is not None and (warm["token"] is None or warm["echo"] <= warm["token"]),
   f"echo {warm['echo']} ms, first token {warm['token']} ms")
ck("a warm turn reaches its FIRST TOKEN within the fence — most of it is the model, the front of it is ours",
   warm["token"] is not None and warm["token"] < 8_000, f"first token {warm['token']} ms; marks {warm['marks'][:6]}")
ck("and the turn finishes, rather than leaving the stream open on a turn that never ends",
   warm["idle"] is not None and warm["idle"] < 60_000, f"idle {warm['idle']} ms")
ck("the answer arrives on the STREAM, not only in the transcript — a client that polls is a client that waits",
   any(k.startswith("message.part") for _, k in warm["marks"]), str(warm["marks"][:6]))

# THE CELL'S OWN SHARE, from its per-turn timing. The model dominates the wall
# clock; what must not grow is the part this repository owns.
turns = api(f"/v1/p/{sid}/8080/turns", tok).get("turns", [])
timing = None
for t in turns:
    raw = t.get("timing")
    if raw: timing = json.loads(raw) if isinstance(raw, str) else raw
own = None
if timing:
    own = sum(v for k, v in timing.items() if k in ("queued", "checkout", "plugins", "skills", "buildAgent", "modelOpen"))
ck("the cell's own work in a warm turn is a rounding error next to the model",
   own is not None and own < 300, f"cell share {own} ms of {timing}")

try:
    api(f"/v1/projects/{PROJ}/sessions/{sid}/environment/stop", tok, "POST", {})
except Exception:
    pass
print()
print(f"  send to answer, live: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
PYEOF
