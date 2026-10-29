"""Shared helpers: Kortix connector calls, 1-hour public media links, one-file-per-post ledger."""
import datetime, json, os, re, shutil, subprocess, urllib.parse

def kortix(args, timeout=600):
    r = subprocess.run(["kortix", *args, "--json"], capture_output=True, text=True, timeout=timeout)
    text = r.stdout[r.stdout.find("{"):] if "{" in r.stdout else r.stdout   # strip the CLI banner line
    try: return json.loads(text)
    except ValueError: raise RuntimeError(f"kortix {' '.join(args[:3])}: {(r.stderr or r.stdout)[-400:]}")

def call(slug, tool, args, account=None):
    """Call one connector tool. Returns the provider data or raises with the reason."""
    raw = kortix(["connectors", "call", slug, tool, json.dumps(args), *(["--account", account] if account else [])])
    if not raw.get("ok"): raise RuntimeError(f"{tool}: {raw.get('reason') or raw.get('error') or raw}"[:600])
    r = (raw.get("data") or {}).get("result", raw.get("data"))
    if isinstance(r, dict) and "successful" in r:
        if not r["successful"]: raise RuntimeError(f"{tool}: {json.dumps(r.get('error') or r)[:400]}")
        return r.get("data")
    return r

def share(path, label):
    """Expose one file at a public HTTPS URL for 1 hour. Returns (url, revoke)."""
    session = os.environ["KORTIX_SESSION_ID"]
    os.makedirs("/workspace/public", exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9._-]", "-", os.path.basename(path))
    target = f"/workspace/public/{name}"
    if os.path.abspath(path) != target: shutil.copyfile(path, target)
    expires = (datetime.datetime.utcnow() + datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    link = kortix(["sessions", "links", session, "create", "--file", f"public/{name}", "--expires", expires, "--label", label])
    token = link.get("public_token") or link.get("token")
    if not token: raise RuntimeError(f"share link failed: {json.dumps(link)[:200]}")
    api = urllib.parse.urlparse(os.environ.get("KORTIX_API_URL", "https://api.kortix.com/v1"))
    url = f"{api.scheme}://{api.netloc}/v1/p/public-share/{token}/file"
    def revoke():
        try: kortix(["sessions", "links", session, "revoke", link["share_id"]])
        except Exception: pass
        try: os.remove(target)
        except OSError: pass
    return url, revoke

def fingerprint(text):
    """Platforms re-flow whitespace; compare captions/titles on a stable prefix."""
    return re.sub(r"\s+", " ", text or "").strip().lower()[:80]

def record(ledger_dir, key, entry):
    """One new file per post: concurrent runs never edit the same file."""
    if not ledger_dir: return
    os.makedirs(ledger_dir, exist_ok=True)
    entry = {"key": key, "at": datetime.datetime.utcnow().isoformat() + "Z", **entry}
    with open(os.path.join(ledger_dir, re.sub(r"[^a-z0-9-]+", "-", key.lower()) + ".json"), "w") as f:
        json.dump(entry, f, indent=1)

def already(ledger_dir, key):
    p = os.path.join(ledger_dir or "", re.sub(r"[^a-z0-9-]+", "-", key.lower()) + ".json")
    return json.load(open(p)) if ledger_dir and os.path.exists(p) else None
