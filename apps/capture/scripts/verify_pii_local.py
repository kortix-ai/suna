#!/usr/bin/env python3
"""Real macOS screen -> OCR -> SQLite/FTS -> HEVC -> localhost S3 verification.
Only the native synthetic support task window is recorded. No production library,
credentials, or cloud endpoint is used. See scripts/README.md for prerequisites.
"""
import argparse
import html
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parents[1]
VALUES = {
    "email": "alice@example.com", "card": "4111 1111 1111 1111",
    "ssn": "123-45-6789", "phone": "+1 555 010 0100",
    "iban": "GB82 WEST 1234 5698 7654 32", "aws": "AKIAIOSFODNN7EXAMPLE",
    "github": "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa",
}
MODEL_SOURCE = None
PLACEHOLDERS = ["[email]", "[card]", "[ssn]", "[phone]", "[iban]", "[secret]"]

def normalized(text):
    return "".join(c.lower() for c in text if c.isalnum())

def require(condition, message):
    if not condition:
        raise AssertionError(message)

def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, capture_output=True, **kwargs)

class Engine:
    def __init__(self, binary):
        self.proc = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.sequence = 0
    def request(self, **request):
        self.sequence += 1
        request["id"] = self.sequence
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()
        response = json.loads(self.proc.stdout.readline())
        require(response.get("ok"), "native engine failed: " + str(response.get("error")))
        return response
    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=10)

class LocalS3(BaseHTTPRequestHandler):
    objects = {}
    lock = threading.Lock()
    def log_message(self, *args):
        pass  # Presigned query strings and credentials never go into evidence.
    def key(self):
        return unquote(urlsplit(self.path).path)
    def do_PUT(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        with self.lock:
            self.objects[self.key()] = body
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()
    def do_HEAD(self):
        with self.lock:
            body = self.objects.get(self.key())
        self.send_response(200 if body is not None else 404)
        self.send_header("Content-Length", str(len(body) if body is not None else 0))
        self.end_headers()
    def do_GET(self):
        with self.lock:
            body = self.objects.get(self.key())
        self.send_response(200 if body is not None else 404)
        self.send_header("Content-Length", str(len(body) if body is not None else 0))
        self.end_headers()
        if body is not None:
            self.wfile.write(body)
    def do_DELETE(self):
        with self.lock:
            self.objects.pop(self.key(), None)
        self.send_response(204)
        self.end_headers()

def env_for(library, engine):
    env = os.environ.copy()
    # Explicit synthetic test credentials override any inherited S3 settings.
    for key in ("KORTIX_CAPTURE_S3_ACCESS_KEY_ID", "KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY", "KORTIX_CAPTURE_S3_SESSION_TOKEN"):
        env.pop(key, None)
    env.update(KORTIX_CAPTURE_DIR=str(library), KORTIX_CAPTURE_ENGINE=str(engine))
    return env

def settings(library, endpoint, enabled, prefix):
    library.mkdir(parents=True)
    config = {
        "recording_enabled": True, "interval_ms": 1000, "capture_on_change": False,
        "pause_on_inactivity": False, "record_unknown_bundle_ids": True,
        "enabled_exclusion_groups": [], "max_height": 1440, "max_width": 2560,
        "staging_quality": 0.95, "video_quality": 0.9, "chunk_max_frames": 3,
        "ax_enabled": True, "ocr_languages": ["en-US"], "privacy": {"redact_pii": enabled, "use_local_model": MODEL_SOURCE is not None},
        "storage": {"min_free_gb": 0, "management_mode": "keep_all", "reserve_mb": 0},
        "sync": {"enabled": True, "provider": "s3", "s3": {"endpoint": endpoint, "bucket": "synthetic",
                 "region": "us-east-1", "prefix": prefix, "path_style": True},
                 "keep_local_hours": 24},
    }
    if MODEL_SOURCE:
        for source in MODEL_SOURCE.rglob('*'):
            if source.is_file() and not source.name.endswith(('.partial', '.download', '.tgz', '.zip')):
                target = library / 'privacy-model' / source.relative_to(MODEL_SOURCE)
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists(): os.link(source, target)
    (library / "settings.json").write_text(json.dumps(config))
    creds = library / "sync-credentials.json"
    creds.write_text(json.dumps({"access_key_id": "synthetic-local-access", "secret_access_key": "synthetic-local-secret"}))
    creds.chmod(0o600)

def check_text(text, enabled, label):
    compact = normalized(text)
    for kind, value in VALUES.items():
        found = normalized(value) in compact
        require(found != enabled, f"{label}: {kind} {'leaked' if enabled else 'missing from disabled recording'}")
    if enabled:
        for placeholder in PLACEHOLDERS:
            require(placeholder in text, f"{label}: missing {placeholder}")
    require(MODEL_SOURCE is not None or "4111111111111112" in compact, f"{label}: invalid Luhn card was incorrectly masked")
    require("demo2048" in compact, f"{label}: unrelated order context was lost")

def inspect_case(library, case, output, engine, enabled):
    conn = sqlite3.connect(library / "memory.db")
    conn.row_factory = sqlite3.Row
    frames = list(conn.execute("SELECT id, foreground, background, pii_redacted, ocr_status, video FROM frame ORDER BY id"))
    require(len(frames) >= 4, f"{case}: too few captured frames: {len(frames)}")
    require(all(row["pii_redacted"] == int(enabled) for row in frames), f"{case}: wrong per-frame policy")
    require(all(row["ocr_status"] in (1, 2) for row in frames), f"{case}: incomplete OCR")
    for row in frames:
        check_text((row["foreground"] or "") + (row["background"] or ""), enabled, f"{case} frame {row['id']}")
    count = conn.execute("SELECT count(*) FROM ocr_fts WHERE ocr_fts MATCH 'alice'").fetchone()[0]
    require((count == 0) == enabled, f"{case}: FTS did not reflect redaction")
    require(conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "SQLite integrity check failed")
    require(not list(conn.execute("PRAGMA foreign_key_check")), "SQLite foreign key violation")
    videos = list(conn.execute("SELECT id, path, uploaded_at, num_frames FROM video ORDER BY id"))
    require(videos and any(v["uploaded_at"] for v in videos), f"{case}: no verified localhost upload")
    with LocalS3.lock:
        objects = [(key, data) for key, data in LocalS3.objects.items() if f"/{case}/" in key]
    sidecars = [(key, data) for key, data in objects if key.endswith(".frames.jsonl.zst")]
    require(sidecars, f"{case}: no uploaded frame sidecar")
    for i, (_, compressed) in enumerate(sidecars):
        text = run(["zstd", "-d", "-q", "-c"], input=compressed).stdout.decode()
        for line in text.splitlines():
            frame = json.loads(line)
            require(frame.get("pii_redacted") == enabled, "uploaded sidecar has the wrong frame privacy state")
            check_text((frame["ocr"]["foreground"] or "") + (frame["ocr"]["background"] or ""), enabled, f"{case} sidecar")
            if enabled:
                for value in VALUES.values():
                    require(normalized(value) not in normalized(line), f"{case}: metadata leaked a value")
        (output / f"{case}-sidecar-{i}.json").write_text(text)
    video = library / "videos" / videos[0]["path"]
    destination = output / f"{case}.mp4"
    shutil.copyfile(video, destination)
    require(any(data == destination.read_bytes() for key, data in objects if key.endswith(".mp4")), f"{case}: uploaded video differs from the inspected local video")
    image = output / f"{case}.png"
    engine.request(cmd="extract", video=str(video), index=0, out=str(image))
    visible = verify_video_frame(engine, image, enabled)
    checked = 1
    scratch = output / "video-check.png"
    for chunk in videos:
        for index in range(chunk["num_frames"]):
            if chunk["id"] == videos[0]["id"] and index == 0:
                continue
            engine.request(cmd="extract", video=str(library / "videos" / chunk["path"]), index=index, out=str(scratch))
            verify_video_frame(engine, scratch, enabled)
            checked += 1
    scratch.unlink(missing_ok=True)
    require(checked == len(frames), f"{case}: some captured frames were not encoded and checked")
    if enabled:
        # Raw synthetic strings must not exist in the DB, WAL, or any text log.
        for candidate in library.glob("memory.db*"):
            content = candidate.read_bytes()
            for value in VALUES.values():
                require(value.encode() not in content, f"raw value found in {candidate.name}")
    conn.close()
    return {"frames": len(frames), "chunks": len(videos), "verified_uploads": sum(bool(v['uploaded_at']) for v in videos),
            "sidecars": len(sidecars), "fts_alice_matches": count, "uploaded_video_matches_local": True,
            "video_frames_ocr_checked": checked, "video_ocr": visible,
            "text": frames[0]["foreground"], "checks": "passed"}

def verify_video_frame(engine, image, enabled):
    ocr = engine.request(cmd="ocr", path=str(image), level="accurate", languages=["en-US"])
    visible = " ".join(box["text"] for box in ocr["boxes"])
    if enabled:
        for kind, value in VALUES.items():
            require(normalized(value) not in normalized(visible), f"encoded video leaked {kind}")
        require("demo2048" in normalized(visible), "video lost unrelated context")
        require(MODEL_SOURCE is not None or "4111111111111112" in normalized(visible), "video incorrectly hid the invalid card")
    else:
        check_text(visible, False, "disabled encoded video")
    return visible

def record_case(binary, engine, library, output, name, duration, task_state):
    task_state.write_text(f"{name} — review details")
    env = env_for(library, engine)
    with (output / f"{name}-recorder.log").open("wb") as log:
        proc = subprocess.Popen([str(binary), "record", "--duration", str(duration)], env=env, stdout=log, stderr=log)
        started = time.monotonic()
        changed = False
        while proc.poll() is None:
            if time.monotonic() - started > duration / 2 and not changed:
                task_state.write_text(f"{name} — refund approved")
                changed = True
            if time.monotonic() - started > duration + 45:
                proc.terminate()
                raise RuntimeError(f"{name}: recorder exceeded timeout")
            time.sleep(0.2)
        require(proc.returncode == 0, f"{name}: recorder failed; inspect its test log")


def verify_toggles(binary, engine_path, library, output, endpoint, task_state):
    settings(library, endpoint, True, "toggles")
    task_state.write_text("toggle test — identical screen throughout")
    env = env_for(library, engine_path)
    log = (output / "toggles-recorder.log").open("wb")
    proc = subprocess.Popen([str(binary), "record", "--duration", "26"], env=env, stdout=log, stderr=log)
    def wait_frames(enabled, after=0, count=3):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if (library / "memory.db").exists():
                with sqlite3.connect(library / "memory.db") as conn:
                    rows = conn.execute("SELECT id FROM frame WHERE id > ? AND pii_redacted = ? ORDER BY id", (after, int(enabled))).fetchall()
                    if len(rows) >= count:
                        return rows[-1][0]
            require(proc.poll() is None, "recorder stopped during toggle test")
            time.sleep(0.2)
        raise AssertionError("setting toggle did not produce enough frames in the expected mode")
    try:
        end = wait_frames(True)
        valid = (library / "settings.json").read_text()
        (library / "settings.json").write_text('{"privacy":')
        end = wait_frames(True, end)
        (library / "settings.json").write_text(valid)
        run([binary, "settings", "privacy.redact_pii", "false"], env=env)
        end = wait_frames(False, end)
        run([binary, "settings", "privacy.redact_pii", "true"], env=env)
        wait_frames(True, end)
        proc.wait(timeout=40)
        require(proc.returncode == 0, "toggle recorder failed")
        with sqlite3.connect(library / "memory.db") as conn:
            rows = conn.execute("SELECT foreground, pii_redacted, ocr_status FROM frame ORDER BY id").fetchall()
            for text, flag, status in rows:
                check_text(text or "", bool(flag), "live toggle frame")
                require(not flag or status == 1, "private frame used copied OCR")
            matches = conn.execute("SELECT count(*) FROM ocr_fts WHERE ocr_fts MATCH 'alice'").fetchone()[0]
            require(matches == sum(not flag for _, flag, _ in rows), "toggle FTS leaked a private frame")
        return {"frames": len(rows), "private_frames": sum(flag for _, flag, _ in rows),
                "unfiltered_frames": sum(not flag for _, flag, _ in rows),
                "invalid_settings_kept_privacy_enabled": True, "copied_disabled_frames": sum(not flag and status == 2 for _, flag, status in rows), "checks": "passed"}
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=15)
        log.close()


def verify_rejected_capture(binary, output, endpoint):
    library = output / "library-rejected"
    settings(library, endpoint, True, "rejected")
    config = json.loads((library / "settings.json").read_text())
    config["sync"]["enabled"] = False
    (library / "settings.json").write_text(json.dumps(config))
    mock = output / "reject-engine"
    mock.write_text("#!" + sys.executable + "\n" +
        "import sys,json\nfor line in sys.stdin:\n r=json.loads(line); c=r.get('cmd'); o={'ok':True,'screen':True,'accessibility':True,'id':r.get('id')}\n if c=='capture_private': o.update(ok=False,error='synthetic OCR unavailable for alice@example.com')\n print(json.dumps(o),flush=True)\n")
    mock.chmod(0o700)
    result = run([binary, "record", "--duration", "3"], env=env_for(library, mock))
    (output / "rejected-recorder.log").write_bytes(result.stderr)
    require(b"alice@example.com" not in result.stderr, "native private error leaked into logs")
    require("alice@example.com" not in (library / "recorder.json").read_text(), "native private error leaked into status")
    with sqlite3.connect(library / "memory.db") as conn:
        require(conn.execute("SELECT count(*) FROM frame").fetchone()[0] == 0, "failed private capture stored a frame")
        require(conn.execute("SELECT count(*) FROM video").fetchone()[0] == 0, "failed private capture encoded video")
    require(not list((library / "frames").glob("*")), "failed private capture left an image artifact")
    return {"frames": 0, "videos": 0, "image_artifacts": 0, "checks": "passed"}


def forward_engine(native, fixture_pid):
    """Keep background desktop metadata out of synthetic test evidence.
    Capture, OCR, image encoding and video encoding all remain native.
    """
    engine = Engine(Path(native))
    try:
        for line in sys.stdin:
            request = json.loads(line)
            identifier = request.pop("id", None)
            try:
                if request.get("cmd") in ("capture", "capture_private"):
                    request["_test_window_pid"] = fixture_pid
                    response = engine.request(**request)
                    if "windows" in response:
                        response["windows"] = [w for w in response["windows"] if w.get("pid") == fixture_pid]
                else:
                    response = engine.request(**request)
            except Exception:
                response = {"ok": False, "error": "synthetic native engine request failed"}
            response["id"] = identifier
            print(json.dumps(response), flush=True)
    finally:
        engine.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "artifacts" / "pii-local" / time.strftime("%Y%m%d-%H%M%S"))
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--model", type=Path, help="Installed offline model directory; adds names and addresses to the visual checks")
    parser.add_argument("--duration", type=int, default=18)
    args = parser.parse_args()
    global MODEL_SOURCE
    MODEL_SOURCE = args.model.resolve() if args.model else None
    if MODEL_SOURCE:
        VALUES.update({'person': 'Alice Example', 'address': '42 Fictional Lane, Example City'})
        PLACEHOLDERS.extend(['[person]', '[address]'])
    require(sys.platform == "darwin", "This visual native verification requires macOS")
    for command in ("xcrun", "ffmpeg", "zstd"):
        require(shutil.which(command), f"missing prerequisite: {command}")
    output = args.out.resolve()
    require(not output.exists(), "Choose a fresh output directory; existing evidence is never overwritten")
    output.mkdir(parents=True)
    binary = ROOT / "target" / "release" / "kortix-capture"
    if not args.skip_build:
        print("PII_E2E building recorder and native engine", flush=True)
        run(["cargo", "build", "--release", "--features", "native-recorders", "--bin", "kortix-capture"], cwd=ROOT)
    engines = list((ROOT / "target" / "release" / "build").glob("kortix-backend-*/out/kortix-capture-engine"))
    require(engines, "native engine not built")
    engine_path = max(engines, key=lambda p: p.stat().st_mtime)
    engine = Engine(engine_path)
    permissions = engine.request(cmd="permissions")
    require(permissions.get("screen") and permissions.get("accessibility"), "Screen Recording and Accessibility permissions are required; no capture was attempted")
    fixture_binary = output / "pii-sample-task"
    run(["xcrun", "swiftc", ROOT / "scripts" / "fixtures" / "pii_sample_task.swift", "-o", fixture_binary])
    task_state = output / "task-state.txt"
    task_state.write_text("review details")
    fixture = subprocess.Popen([str(fixture_binary), str(task_state)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    server = ThreadingHTTPServer(("127.0.0.1", 0), LocalS3)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    summary = {"detector": "OpenAI Privacy Filter q4 + patterns" if MODEL_SOURCE else "patterns", "platform": "macOS", "permissions": permissions, "cases": {}, "synthetic_only": True}
    try:
        deadline = time.monotonic() + 10
        while not Path(str(task_state) + ".ready").exists():
            require(fixture.poll() is None, "synthetic task exited before capture")
            require(time.monotonic() < deadline, "synthetic task window did not open")
            time.sleep(0.2)
        forwarder = output / "synthetic-engine"
        forwarder.write_text(f"#!/bin/sh\nexec '{sys.executable}' '{Path(__file__).resolve()}' --forward '{engine_path}' {fixture.pid}\n")
        forwarder.chmod(0o700)
        # Verify the native privacy command does not create its requested output.
        never_written = output / "must-not-exist.jpg"
        response = engine.request(cmd="capture_private", out=str(never_written), record_unknown=True,
                                  ax=True, max_height=1440, max_width=2560, quality=0.95, languages=["en-US"], _test_window_pid=fixture.pid)
        require(response.get("privacy_capture") and response.get("image_base64"), "native in-memory capture unavailable")
        require(not never_written.exists(), "native private capture wrote raw pixels")
        recognized = " ".join(box["text"] for box in response["boxes"])
        for kind, value in VALUES.items():
            require(normalized(value) in normalized(recognized), f"synthetic task is not fully visible to OCR: {kind}")
        del response  # Raw image and text were held only in RAM.
        summary["native_private_capture_wrote_no_file"] = True
        engine.close()
        engine = None
        for name, enabled in (("disabled", False), ("enabled", True)):
            print(f"PII_E2E {name}: real screen capture, database, video and localhost upload", flush=True)
            library = output / f"library-{name}"
            settings(library, endpoint, enabled, name)
            record_case(binary, forwarder, library, output, name, max(18, args.duration), task_state)
            engine = Engine(engine_path)
            summary["cases"][name] = inspect_case(library, name, output, engine, enabled)
            engine.close()
            engine = None
        print("PII_E2E toggles: enabled -> invalid reload -> disabled -> enabled, unchanged screen", flush=True)
        summary["cases"]["toggles"] = verify_toggles(binary, forwarder, output / "library-toggles", output, endpoint, task_state)
        print("PII_E2E failure: native OCR rejected, no frame/image/video writes", flush=True)
        summary["cases"]["rejected"] = verify_rejected_capture(binary, output, endpoint)
        summary["result"] = "passed"
        (output / "summary.json").write_text(json.dumps(summary, indent=2))
        report = f'''<!doctype html><meta charset="utf-8"><title>Kortix local privacy verification</title>
<style>body{{background:#f3f6fa;color:#182438;font:16px system-ui;margin:40px auto;max-width:1440px}}h1{{font-size:38px}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:24px}}section{{background:white;border-radius:16px;padding:20px;box-shadow:0 4px 20px #1231}}img,video{{width:100%;border-radius:8px}}pre{{white-space:pre-wrap;font-size:13px}}.tag{{color:#14734a;font-weight:600}}</style>
<h1>PII masking: native end-to-end verification</h1><p class="tag">Verified native macOS recording · synthetic data only · localhost sync target</p>
<p>The same synthetic support task captured with the setting disabled and enabled. Images below are extracted from the actual encoded video.</p>
<div class="grid"><section><h2>Redaction disabled</h2><img src="disabled.png"><video controls src="disabled.mp4"></video><h3>Stored OCR text</h3><pre>{html.escape(summary['cases']['disabled']['text'])}</pre></section>
<section><h2>Redaction enabled</h2><img src="enabled.png"><video controls src="enabled.mp4"></video><h3>Stored OCR text</h3><pre>{html.escape(summary['cases']['enabled']['text'])}</pre></section></div>
<p>Detected regions are covered before the first image write. OCR placeholders also appear in SQLite, FTS and the uploaded sidecar. OCR and patterns can miss unrecognized or unsupported values; The optional local model adds names and addresses. Neither detector guarantees every possible PII value is recognized.</p>
<p>Repeat this task with <code>python3 scripts/verify_pii_local.py</code>. <a href="summary.json">Machine-readable evidence</a></p>'''
        (output / "report.html").write_text(report)
        print(f"PII_E2E PASS evidence={output}", flush=True)
    finally:
        fixture.terminate()
        fixture.wait(timeout=10)
        server.shutdown()
        if engine is not None:
            engine.close()

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--forward":
        forward_engine(sys.argv[2], int(sys.argv[3]))
    else:
        main()
