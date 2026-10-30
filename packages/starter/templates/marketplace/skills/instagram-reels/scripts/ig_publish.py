#!/usr/bin/env python3
"""Publish to Instagram through a Kortix connector (Composio Instagram toolkit).

    python3 ig_publish.py reel     --media final.mp4 --caption-file caption.txt [--cover cover.jpg]
    python3 ig_publish.py story    --media story.jpg            # or a 9:16 .mp4
    python3 ig_publish.py post     --media post.jpg --caption-file caption.txt
    python3 ig_publish.py carousel --media 1.jpg --media 2.jpg ... --caption-file caption.txt   # 2-10 JPEGs
    common: --key <unique-post-key> --ledger-dir <dir> [--slug instagram] [--account NAME] [--dry-run]

Safety: the ledger key and the live feed (caption fingerprint) are checked before any write and again
after an ambiguous publish error, so a lost response never becomes a double post.
"""
import argparse, json, os, sys, time
from kx import already, call, fingerprint, record, share

VIDEO = (".mp4", ".mov")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["reel", "story", "post", "carousel"])
    ap.add_argument("--media", action="append", required=True)
    ap.add_argument("--caption-file"); ap.add_argument("--cover")
    ap.add_argument("--key", required=True); ap.add_argument("--ledger-dir")
    ap.add_argument("--slug", default=os.environ.get("IG_CONNECTOR", "instagram"))
    ap.add_argument("--account", default=os.environ.get("IG_ACCOUNT"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    caption = open(a.caption_file).read().strip() if a.caption_file else ""
    ig = lambda tool, args: call(a.slug, tool, args, a.account)

    if (prev := already(a.ledger_dir, a.key)) and prev.get("status") == "published":
        print(json.dumps({"result": "already-published", **prev})); return
    user = str(ig("get_user_info", {"ig_user_id": "me", "fields": "id,username"})["id"])
    feed = lambda: (ig("get_user_info", {"ig_user_id": "me", "fields": "media.limit(50){id,caption,permalink,timestamp}"}) or {}).get("media", {}).get("data", [])
    if a.kind != "story" and caption:
        live = next((m for m in feed() if fingerprint(m.get("caption")) == fingerprint(caption)), None)
        if live:
            record(a.ledger_dir, a.key, {"status": "published", "id": live["id"], "url": live.get("permalink"), "note": "found live"})
            print(json.dumps({"result": "already-live", "url": live.get("permalink")})); return
    if a.dry_run:
        print(json.dumps({"result": "dry-run ok", "ig_user_id": user, "kind": a.kind, "media": a.media})); return

    links = []
    def url(path):
        u, revoke = share(path, f"ig-{a.kind}"); links.append(revoke); return u
    def wait(container):
        for _ in range(60):                       # video transcoding: up to 10 minutes
            s = ig("get_multiple_nodes", {"object_ids": [container], "fields": "status_code"})
            status = ((s or {}).get("objects", {}).get(container) or s or {}).get("status_code")
            if status == "FINISHED": return
            if status in ("ERROR", "EXPIRED"): raise RuntimeError(f"container {container} {status}")
            time.sleep(10)
        raise RuntimeError(f"container {container} still processing")
    def container(path, extra):
        key = "video_url" if path.lower().endswith(VIDEO) else "image_url"
        c = str(ig("post_ig_user_media", {"ig_user_id": user, key: url(path), **extra})["id"])
        wait(c); return c
    try:
        if a.kind == "reel":
            extra = {"media_type": "REELS", "caption": caption, "share_to_feed": True}
            if a.cover: extra["cover_url"] = url(a.cover)
            cid = container(a.media[0], extra)
        elif a.kind == "story":
            cid = container(a.media[0], {"media_type": "STORIES"})
        elif a.kind == "post":
            cid = container(a.media[0], {"caption": caption})
        else:
            if not 2 <= len(a.media) <= 10: sys.exit("carousel needs 2-10 items")
            if any(m.lower().endswith(VIDEO) for m in a.media): sys.exit("carousel: JPEG slides only")
            kids = [container(m, {"is_carousel_item": True}) for m in a.media]
            cid = str(ig("post_ig_user_media", {"ig_user_id": user, "media_type": "CAROUSEL", "children": kids, "caption": caption})["id"])
            wait(cid)
        record(a.ledger_dir, a.key, {"status": "publishing", "container": cid})
        try:
            mid = str(ig("post_ig_user_media_publish", {"ig_user_id": user, "creation_id": cid})["id"])
        except Exception:
            time.sleep(15)                        # ambiguous: did it go live anyway?
            m = next((m for m in feed() if caption and fingerprint(m.get("caption")) == fingerprint(caption)), None)
            if not m: raise
            mid = m["id"]
        node = ig("get_multiple_nodes", {"object_ids": [mid], "fields": "permalink,timestamp"})
        link = ((node or {}).get("objects", {}).get(mid) or {}).get("permalink")
        record(a.ledger_dir, a.key, {"status": "published", "id": mid, "url": link, "kind": a.kind})
        print(json.dumps({"result": "published", "kind": a.kind, "id": mid, "url": link}))
    except Exception as e:
        record(a.ledger_dir, a.key, {"status": "failed", "error": str(e)[:500], "kind": a.kind})
        print(json.dumps({"result": "error", "error": str(e)[:500]})); sys.exit(1)
    finally:
        for revoke in links: revoke()

if __name__ == "__main__":
    main()
