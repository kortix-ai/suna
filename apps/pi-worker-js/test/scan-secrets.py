#!/usr/bin/env python3
"""Does any deployed object carry a secret VALUE?

`celld deploy` uploads wrangler.json's vars into the deployment manifest, and
they land in `raw_metadata.bindings` as {"name": X, "text": Y, "type":
"plain_text"} — NOT as "X": "Y". The first version of this check used the
latter shape, so it reported clean while a planted canary sat in the manifest,
and it flagged 14 innocent objects because the var NAME appeared with an empty
value. Both failures came from pattern-matching a serialisation instead of
parsing it.

So: parse, walk the bindings, and judge on the value.

Reads object bodies as `path\\0body\\0` pairs on stdin. Prints one line per
finding, exits 1 if any.
"""
import json
import re
import sys

# Names whose VALUE must never be in a deployment. A pattern rather than a list,
# so a var added next year is covered without anyone remembering this file.
SECRET_NAME = re.compile(r"(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)", re.I)
# Names that carry the word but are addresses, not credentials.
ALLOWED = {"MODEL_BASE_URL", "TOOL_DAEMON_URL", "MODEL_PROVIDER", "MODEL_ID"}
JWT = re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}")


def findings(body: str):
    out = []
    if JWT.search(body):
        out.append("a JWT")
    try:
        doc = json.loads(body)
    except Exception:
        return out

    def walk(node):
        if isinstance(node, dict):
            name, text = node.get("name"), node.get("text")
            if isinstance(name, str) and isinstance(text, str) and text:
                if name not in ALLOWED and SECRET_NAME.search(name):
                    out.append(f"{name}={text[:8]}… ({len(text)} chars)")
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(doc)
    return out


def main() -> int:
    raw = sys.stdin.read()
    parts = raw.split("\0")
    bad = 0
    scanned = 0
    for i in range(0, len(parts) - 1, 2):
        path, body = parts[i].strip(), parts[i + 1]
        if not path:
            continue
        scanned += 1
        for f in findings(body):
            print(f"{path}: {f}")
            bad += 1
    print(f"scanned={scanned}")
    # A SCAN THAT EXAMINED NOTHING IS NOT A PASS.
    #
    # Everything above answers "did any object carry a secret", and with no
    # objects the answer is trivially no. The caller finds the objects with
    # `mc find` against a bucket path built from config — rename a prefix, break
    # an alias, purge a bucket, and this would report clean on zero objects while
    # protecting the one thing that has already gone wrong here once: three
    # manifests holding a complete OAuth JWT.
    #
    # Exit 2, distinct from 1, so the caller can say WHICH failure it was.
    if scanned == 0:
        print("scanned nothing — the object walk found no deployed manifests, so this proves nothing")
        return 2
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
