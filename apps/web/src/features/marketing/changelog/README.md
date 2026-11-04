# Weekly brief media

`briefs.json` on `refs/kortix/changelog-weekly` stays version 1. Existing
text-only weeks need no changes. An editor may add this optional field to a
week **after** reviewing the exported cover and the real demo:

```json
"media": {
  "reviewed": true,
  "cover": {
    "url": "https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/changelog/cover.png",
    "alt": "Describe the reviewed cover",
    "width": 1200,
    "height": 630
  },
  "demoUrl": "https://www.youtube.com/watch?v=REAL_VIDEO_ID"
}
```

This is a schema example, not a published asset or demo. Covers must be public,
unsigned HTTPS PNG, JPEG, WebP or AVIF files on the existing approved Vercel
Blob host, with nonblank alt text and integer dimensions from 1 to 8192.
Demo links accept YouTube or Loom HTTPS URLs only. Invalid covers and drafts
are omitted; invalid demos are omitted independently. Failed image loads hide
the cover. No draft gets published automatically and this code writes no ref.
The company `changelog-weekly` writer currently serializes highlights only;
its existing JSON readers preserve optional fields when updating Slack status.
Adding media authoring to that writer needs the same validation/review gate.
