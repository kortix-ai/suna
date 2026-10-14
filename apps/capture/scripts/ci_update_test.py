"""CI: the Kortix Capture updater, end to end, on a real Windows, macOS or Linux runner.

Needs two TEST builds (never released) made with the update test hooks:
  N   installed first          (installer --n-installer,  version --n-version)
  N+1 served as the update     (installer --n1-installer, version --n1-version)
Both carry the same compiled-in test public key, the manifest URL
http://127.0.0.1:8899/capture-update.json and a 15 s check interval. The private
key (--key) signs every manifest this script serves.

Cases, in order (every one waits for real checks of the real service):
  up to date      N installed, manifest names N                         -> no install
  tampered sig    manifest N+1, signature of other bytes                -> no install
  older version   manifest 0.0.1, valid signature                       -> no install
  corrupt file    manifest N+1, installer bytes changed (sha256 differs) -> no install
  paused          manifest N+1 with paused: true                        -> no install
  bad health      N+1 never reports healthy (marker file)               -> rollback to N, N+1 marked bad,
                                                                           not tried again
  update          marker removed, bad list cleared                      -> N+1 installed, service restarted,
                                                                           recording continues, device reports N+1
  no downgrade    manifest N while N+1 runs                             -> no install
"""

import argparse
import functools
import http.server
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request

p = argparse.ArgumentParser()
p.add_argument("--os", required=True, choices=["windows", "macos", "linux"])
p.add_argument("--work", required=True)
p.add_argument("--key", required=True, help="Ed25519 private key (PEM) of the test public key")
p.add_argument("--n-installer", required=True)
p.add_argument("--n1-installer", required=True)
p.add_argument("--n-version", required=True)
p.add_argument("--n1-version", required=True)
p.add_argument("--token", required=True)
p.add_argument("--evidence", required=True)
p.add_argument("--issuer", default="http://127.0.0.1:8787")
args = p.parse_args()

OS = args.os
HERE = pathlib.Path(__file__).resolve().parent
TOOL = HERE / "ci_update_tool.mjs"
WORK = pathlib.Path(args.work)
SERVE = WORK / "serve"
EV = pathlib.Path(args.evidence)
PORT = 8899
EXT = {"windows": "msi", "macos": "pkg", "linux": "deb"}[OS]
DEVICE_KEY = "orgs/00000000-0000-4000-8000-00000000c1c1/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/"

if OS == "windows":
    K = r"C:\Program Files\Kortix\Capture\kortix-capture.exe"
    MACH = pathlib.Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Kortix" / "Capture"
    UPD = MACH.parent / "CaptureUpdate"
elif OS == "macos":
    K = "/usr/local/bin/kortix-capture"
    MACH = pathlib.Path("/Library/Application Support/Kortix/Capture")
    UPD = MACH / "updates"
else:
    K = "/usr/bin/kortix-capture"
    MACH = pathlib.Path("/var/lib/kortix/capture")
    UPD = MACH / "updates"

T0 = time.time()


def say(msg):
    print(f"[{int(time.time() - T0):5d}s] {msg}", flush=True)


def run(cmd, root=False, check=True, timeout=900, **kw):
    cmd = [str(c) for c in cmd]
    if root and OS != "windows":
        cmd = ["sudo", *cmd]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kw)
    if check and r.returncode != 0:
        raise AssertionError(f"{cmd} exited {r.returncode}\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}")
    return r


def tool(*a):
    return run(["node", TOOL, *a]).stdout.strip()


def read_json(path, root=False):
    try:
        if root and OS != "windows":
            text = run(["cat", path], root=True).stdout
        else:
            text = pathlib.Path(path).read_text(encoding="utf-8-sig")
        return json.loads(text)
    except (OSError, ValueError, AssertionError):
        return {}


def upd():
    return read_json(UPD / "update.json")


def dump():
    out = []
    out.append("update.json: " + json.dumps(upd(), indent=1))
    out.append("person status: " + json.dumps({k: v for k, v in person().items() if k in ("recorder_running", "state", "counts", "inactive_reason", "effective_state", "recorder")}, indent=1)[:2500])
    if OS == "linux":
        me = os.environ.get("USER", "runner")
        out.append(run(["bash", "-c", f"systemctl --machine={me}@.host --user status kortix-capture.service --no-pager | tail -15; ps -eo pid,args | grep -E 'kortix' | grep -v grep"], check=False).stdout)
    for f in (UPD / "update.log", MACH / "logs" / "machine.log"):
        try:
            text = run(["cat", f], root=True, check=False).stdout if OS != "windows" else f.read_text(errors="replace")
            out.append(f"--- {f}\n" + "\n".join(text.splitlines()[-40:]))
        except OSError:
            pass
    return "\n".join(out)


def wait_for(what, fn, timeout=300, every=3):
    t0 = time.time()
    while True:
        v = fn()
        if v:
            say(f"ok: {what}")
            return v
        if time.time() - t0 > timeout:
            raise AssertionError(f"timeout ({timeout}s): {what}\n{dump()}")
        time.sleep(every)


def wait_check(what, pred, timeout=180):
    """A check that ran after now and whose one-line result satisfies pred."""
    mark = int(time.time() * 1000)
    return wait_for(
        what,
        lambda: (lambda s: s.get("last_check_ms", 0) > mark and pred(s.get("last_check") or ""))(upd()),
        timeout,
        every=2,
    )


def version():
    return json.loads(run([K, "--json", "machine", "status"]).stdout).get("version")


def machine_pid():
    return read_json(MACH / "machine.json").get("pid")


def person():
    try:
        return json.loads(run([K, "--json", "status"], check=False).stdout)
    except ValueError:
        return {}


def frames():
    return (person().get("counts") or {}).get("frames", 0)


def stable_version(tag):
    return tag.lstrip("v")


# ─── What this OS does to install ───────────────────────────────────────────

def install(path):
    say(f"install {pathlib.Path(path).name}")
    if OS == "windows":
        run(["msiexec.exe", "/i", path, "/qn", "/norestart", "/l*v", EV / "msi-test-install.log",
             f"KORTIX_URL={args.issuer}", f"ENROLLMENT_TOKEN={args.token}"])
    elif OS == "macos":
        cfg = "/Library/Application Support/Kortix/Capture/config.json"
        run(["install", "-d", "-m", "755", "-o", "root", "-g", "wheel", "/Library/Application Support/Kortix", str(MACH)], root=True)
        run(["tee", cfg], root=True, input=json.dumps({"url": args.issuer, "enrollment_token": args.token}))
        run(["chmod", "600", cfg], root=True)
        run(["installer", "-pkg", path, "-target", "/"], root=True)
    else:
        run(["install", "-d", "-m", "755", "/etc/kortix"], root=True)
        run(["tee", "/etc/kortix/capture.json"], root=True, input=json.dumps({"url": args.issuer, "enrollment_token": args.token}))
        run(["chmod", "600", "/etc/kortix/capture.json"], root=True)
        run(["apt-get", "install", "-y", "-q", path], root=True, env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})


def uninstall(path):
    if OS == "windows":
        run(["msiexec.exe", "/x", path, "/qn", "/norestart"], check=False)
    elif OS == "macos":
        run(["/Applications/Kortix Capture.app/Contents/Resources/uninstall.sh"], root=True, check=False)
    else:
        run(["apt-get", "purge", "-y", "-q", "kortix-capture"], root=True, check=False)


def root_ls(d):
    if OS == "windows":
        return [x.name for x in pathlib.Path(d).glob("*")] if pathlib.Path(d).exists() else []
    r = run(["ls", d], root=True, check=False)
    return r.stdout.split() if r.returncode == 0 else []


def touch(path, present):
    if OS == "windows":
        pth = pathlib.Path(path)
        if present:
            pth.write_text("1")
        elif pth.exists():
            pth.unlink()
    else:
        run(["touch" if present else "rm", *(["-f"] if not present else []), path], root=True)


# ─── The update server ──────────────────────────────────────────────────────

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def serve():
    SERVE.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(Quiet, directory=str(SERVE))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def publish(tag, installer, *, channel="dev", paused=False, sig="ok", corrupt=False, previous=None, version_in_manifest=None):
    name = f"KortixCapture-{tag}.{EXT}"
    shutil.copyfile(installer, SERVE / name)
    served = SERVE / "asset-source" / name
    served.parent.mkdir(exist_ok=True)
    shutil.copyfile(installer, served)
    man = WORK / "next-manifest.json"
    cmd = ["manifest", "--out", man, "--version", version_in_manifest or tag, "--channel", channel,
           "--asset", f"{OS}={served}", "--url-base", f"http://127.0.0.1:{PORT}"]
    if paused:
        cmd.append("--paused")
    if previous:
        cmd += ["--previous-manifest", previous]
    tool(*cmd)
    if corrupt:  # the manifest keeps the hash of the good file
        data = bytearray((SERVE / name).read_bytes())
        data[len(data) // 2] ^= 0xFF
        (SERVE / name).write_bytes(bytes(data))
    if sig == "tampered":
        other = WORK / "other.json"
        other.write_text('{"not": "the manifest"}')
        tool("sign", "--key", args.key, other, "--out", WORK / "next-manifest.json.sig")
    else:
        tool("sign", "--key", args.key, man, "--out", WORK / "next-manifest.json.sig")
    # The service never sees half of a manifest: signature first, manifest last, both moved into place.
    os.replace(WORK / "next-manifest.json.sig", SERVE / "capture-update.json.sig")
    os.replace(man, SERVE / "capture-update.json")
    say(f"published {version_in_manifest or tag} (sig={sig}, paused={paused}, corrupt={corrupt}, previous={bool(previous)})")


# ─── Assertions that repeat ─────────────────────────────────────────────────

def recording_ok(baseline_frames, state0, what):
    """The recorder of the signed-in person runs, and, if it recorded before, saves new frames."""
    def ok():
        st = person()
        if st.get("recorder_running") is not True:
            return False
        # A recorder that says paused (screen locked, idle) is the person's state, not the update's.
        return state0 != "recording" or st.get("state") != "recording" or (st.get("counts") or {}).get("frames", 0) > baseline_frames
    wait_for(f"recording continues {what}", ok, timeout=300, every=5)


def no_install(what, case_version):
    time.sleep(3 * 15)  # three more checks
    assert version() == case_version, f"{what}: the version changed to {version()}"
    stray = [f for f in root_ls(UPD / "staging") if not f.startswith(".")]
    assert not stray, f"{what}: files left in staging: {stray}"
    say(f"{what}: nothing was installed (still {case_version})")


def bucket_status():
    r = run([sys.executable, HERE / "ci_fake_issuer.py", "--s3-endpoint", "http://127.0.0.1:9000", "--bucket", "capture",
             "--access-key", "cikortix", "--secret-key", "cikortix-secret-123", "--get", DEVICE_KEY + "status.json"], check=False)
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {}


def main():
    EV.mkdir(parents=True, exist_ok=True)
    n, n1 = args.n_version, args.n1_version
    n_s, n1_s = stable_version(n), stable_version(n1)
    serve()
    prev_manifest = WORK / "prev-n.json"
    tool("manifest", "--out", prev_manifest, "--version", n, "--channel", "dev", "--asset", f"{OS}={args.n_installer}",
         "--url-base", f"http://127.0.0.1:{PORT}")
    # N's installer is served too: it is the `previous` of N+1.
    shutil.copyfile(args.n_installer, SERVE / pathlib.Path(args.n_installer).name)

    publish(n, args.n_installer)
    install(args.n_installer)
    wait_for("the machine service reports version N", lambda: version() == n, 120)
    wait_for("the person is enrolled", lambda: any(s.get("state") in ("enrolled", "recording") for s in read_json(MACH / "machine.json").get("sessions", [])), 300, 5)
    wait_for("the recorder of the person runs", lambda: person().get("recorder_running") is True, 300, 5)
    state0 = person().get("state")
    frames0 = frames()
    say(f"baseline: version={n}, recorder state={state0}, frames={frames0}")

    # 0. up to date
    wait_check("N sees it is up to date", lambda c: "up to date" in c)
    assert upd().get("installed") == n_s, upd()

    pid0 = machine_pid()
    # 1. tampered signature
    publish(n1, args.n1_installer, sig="tampered")
    wait_check("a tampered signature is refused", lambda c: "signature" in c)
    no_install("tampered signature", n)

    # 2. older version, valid signature
    publish(n1, args.n1_installer, version_in_manifest="0.0.1")
    wait_check("an older version is not installed", lambda c: "up to date" in c)
    no_install("older version", n)

    # 3. corrupted download
    publish(n1, args.n1_installer, corrupt=True)
    wait_check("a corrupted download is refused", lambda c: "sha256 mismatch" in c)
    no_install("corrupted download", n)

    # 4. paused
    publish(n1, args.n1_installer, paused=True)
    wait_check("a paused release is not installed", lambda c: "paused" in c)
    no_install("paused release", n)
    assert machine_pid() == pid0, "the service restarted although nothing was installed"

    # 5. N+1 installs but never reports healthy: rollback
    touch(UPD / "test-fail-health", True)
    publish(n1, args.n1_installer, previous=prev_manifest)
    r = wait_for("the failing update is rolled back", lambda: (upd().get("last_result") or {}).get("outcome") in ("rolled_back", "failed", "install_failed", "updated"), 900, 5)
    res = upd()["last_result"]
    say(f"result: {res}")
    assert res["outcome"] == "rolled_back", res
    assert res["to"] == n1_s and res["from"] == n_s, res
    wait_for("the old version runs again", lambda: version() == n, 120)
    assert n1_s in upd()["bad"], upd()
    assert machine_pid() != pid0, "the service did not restart (it should have, twice)"
    log = run(["cat", UPD / "update.log"], root=True).stdout if OS != "windows" else (UPD / "update.log").read_text()
    assert "did not report healthy" in log and "rolling back to" in log, log[-1500:]
    recording_ok(frames0, state0, "after the rollback")
    # Not tried again.
    wait_check("a version marked bad is not tried again", lambda c: "marked bad" in c)
    no_install("bad version", n)

    # 6. the real update
    touch(UPD / "test-fail-health", False)
    run([K, "machine", "update-reset"], root=True)
    assert not upd().get("bad"), upd()
    pid1 = machine_pid()
    frames1 = frames()
    wait_for("N+1 is installed and healthy", lambda: (upd().get("last_result") or {}).get("outcome") == "updated" and version() == n1, 900, 5)
    res = upd()["last_result"]
    assert res["from"] == n_s and res["to"] == n1_s, res
    assert upd()["installed"] == n1_s, upd()
    wait_for("the service restarted", lambda: machine_pid() not in (None, pid1), 120)
    wait_for("the service runs the new version", lambda: read_json(MACH / "machine.json").get("sessions") is not None, 60)
    recording_ok(frames1, state0, "after the update")
    say(f"kept installers: {root_ls(UPD / 'kept')}")
    assert root_ls(UPD / "kept") == [f"{n1_s}.{EXT}"], root_ls(UPD / "kept")
    # The device reports the new version in status.json.
    s = wait_for("status.json in the bucket says N+1", lambda: (lambda b: b if b.get("appVersion") == n1 and ((b.get("update") or {}).get("lastResult") or {}).get("outcome") == "updated" else None)(bucket_status()), 300, 10)
    assert (s.get("update") or {}).get("installed") == n1_s, s.get("update")
    assert (s["update"].get("lastResult") or {}).get("outcome") == "updated", s["update"]
    say(f"status.json update: {json.dumps(s['update'])}")

    # 7. never a downgrade
    publish(n, args.n_installer)
    wait_check("N+1 does not go back to N", lambda c: "up to date" in c)
    no_install("downgrade", n1)
    say("ALL UPDATER ASSERTIONS PASSED")


try:
    main()
finally:
    try:
        EV.mkdir(parents=True, exist_ok=True)
        (EV / "updater-state.txt").write_text(dump())
    except Exception as e:  # noqa: BLE001
        print("could not write evidence:", e)
    uninstall(args.n1_installer)
