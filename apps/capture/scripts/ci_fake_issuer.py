"""CI helper: a stand-in for Kortix's device enrollment and credential issuer.

It speaks the enrollment contract (`POST /v1/capture/device/enroll`) and the
credential endpoint (`POST /v1/capture/credentials`) and hands out the
credentials of a local S3 server (MinIO in CI). The first enrollment answers
`pending` (no member yet), every later one `enrolled`, so a run sees both
paths. Every request goes to <log> as one JSON line, the enrollment token
replaced by "<redacted>".

Usage: python ci_fake_issuer.py --port 8787 --token <enrollment token> --log <file> [--approve-after <s>]
       --s3-endpoint http://127.0.0.1:9000 --bucket capture --access-key K --secret-key S
It creates the bucket first. With `--list <prefix>` it prints the bucket's keys
under the prefix (SigV4 ListObjectsV2), with `--get <key>` an object's body, and exits instead of serving.
"""

import argparse
import datetime
import hashlib
import hmac
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ACCOUNT = "00000000-0000-4000-8000-00000000c1c1"
DEVICE = str(uuid.UUID("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"))

p = argparse.ArgumentParser()
for a in ("--s3-endpoint", "--bucket", "--access-key", "--secret-key"):
    p.add_argument(a, required=True)
for a in ("--port", "--token", "--log", "--list", "--get", "--approve-after"):
    p.add_argument(a)
args = p.parse_args()


def s3(method, path, query=""):
    """One SigV4-signed path-style request to the S3 server; returns (status, body)."""
    u = urllib.parse.urlparse(args.s3_endpoint)
    now = datetime.datetime.now(datetime.timezone.utc)
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    empty = hashlib.sha256(b"").hexdigest()
    headers = {"host": u.netloc, "x-amz-content-sha256": empty, "x-amz-date": amz}
    signed = ";".join(sorted(headers))
    canonical = "\n".join([method, urllib.parse.quote(path), query,
                           "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), signed, empty])
    scope = f"{day}/us-east-1/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = ("AWS4" + args.secret_key).encode()
    for part in (day, "us-east-1", "s3", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = (f"AWS4-HMAC-SHA256 Credential={args.access_key}/{scope}, "
                                f"SignedHeaders={signed}, Signature={sig}")
    req = urllib.request.Request(f"{args.s3_endpoint}{path}" + (f"?{query}" if query else ""), method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


if args.list is not None:
    keys, token = [], None
    while True:
        q = {"list-type": "2", "prefix": args.list}
        if token:
            q["continuation-token"] = token
        status, body = s3("GET", f"/{args.bucket}", urllib.parse.urlencode(sorted(q.items()), quote_via=urllib.parse.quote))
        if status != 200:
            raise SystemExit(f"list failed: {status} {body[:300]}")
        keys += re.findall(r"<Key>([^<]+)</Key>", body)
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", body)
        if not m:
            break
        token = m.group(1)
    print("\n".join(keys))
    raise SystemExit(0)

if args.get is not None:
    status, body = s3("GET", f"/{args.bucket}/{args.get}")
    if status != 200:
        raise SystemExit(f"get failed: {status} {body[:300]}")
    print(body)
    raise SystemExit(0)

try:
    status, body = s3("PUT", f"/{args.bucket}")
except OSError:
    status, body = 200, ""  # no S3 server: the sign-in alone is under test
if status not in (200, 409):
    raise SystemExit(f"create bucket failed: {status} {body[:300]}")

lock = threading.Lock()
state = {"enrolls": 0, "token": None}


def log(entry):
    with lock, open(args.log, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = {}
        if self.path == "/v1/capture/device/enroll":
            ok = body.get("enrollment_token") == args.token
            logged = dict(body, enrollment_token="<redacted>" if ok else "<wrong>")
            if not ok:
                log({"path": self.path, "status": 401, "body": logged})
                return self.reply(401, {"error": "Unknown enrollment token", "code": "enrollment_token_invalid"})
            with lock:
                state["enrolls"] += 1
                first = state["enrolls"] == 1
                if not first:
                    state["token"] = "kortix_cap_ci" + uuid.uuid4().hex
                token = state["token"]
            if first:
                log({"path": self.path, "status": 202, "body": logged})
                return self.reply(202, {"status": "pending", "reason": "approval_required", "enrollment_id": "e-ci", "retry_after_s": 10})
            log({"path": self.path, "status": 200, "body": logged})
            return self.reply(200, {
                "status": "enrolled", "device_token": token, "token_type": "Bearer",
                "prefix": f"orgs/{ACCOUNT}", "device_id": DEVICE,
                "account": {"name": "Example Org"}, "member": {"email": "person@example.com"},
            })
        if self.path == "/v1/capture/device/authorize":
            log({"path": self.path, "status": 200})
            with lock:
                state["polls"] = 0
                state["authorized_at"] = time.time()
            return self.reply(200, {
                "device_code": "ci-device-code", "user_code": "CI12-3456", "expires_in": 600, "interval": 1,
                "verification_uri": f"http://{self.headers.get('host')}/device",
                "verification_uri_complete": f"http://{self.headers.get('host')}/device?user_code=CI12-3456",
            })
        if self.path == "/v1/capture/device/token":
            # RFC 8628: pending on the first poll, approved on the next (a person approving in the browser).
            with lock:
                state["polls"] = state.get("polls", 0) + 1
                waited = time.time() - state.get("authorized_at", 0)
                # A person approving in the browser takes a while: --approve-after seconds.
                first = state["polls"] == 1 or waited < float(args.approve_after or 0)
                if not first:
                    state["token"] = "kortix_cap_ci" + uuid.uuid4().hex
                token = state["token"]
            if first:
                log({"path": self.path, "status": 400})
                return self.reply(400, {"error": "authorization_pending"})
            log({"path": self.path, "status": 200})
            return self.reply(200, {
                "device_id": DEVICE, "device_token": token, "prefix": f"orgs/{ACCOUNT}",
                "account": {"name": "Example Org"}, "member": {"email": "person@example.com"},
            })
        if self.path == "/v1/capture/credentials":
            bearer = self.headers.get("authorization", "")
            ok = state["token"] is not None and bearer == f"Bearer {state['token']}"
            log({"path": self.path, "status": 200 if ok else 401})
            if not ok:
                return self.reply(401, {"error": "Invalid or revoked device token", "code": "capture_device_unauthorized"})
            return self.reply(200, {
                "endpoint": args.s3_endpoint, "bucket": args.bucket, "region": "us-east-1",
                "prefix": f"orgs/{ACCOUNT}", "device_id": DEVICE,
                "access_key_id": args.access_key, "secret_access_key": args.secret_key,
                "session_token": None, "expires_at_ms": int(time.time() * 1000) + 3_600_000, "path_style": True,
            })
        self.reply(404, {"error": "not found"})

    def log_message(self, *_):
        pass


ThreadingHTTPServer(("127.0.0.1", int(args.port)), Handler).serve_forever()
