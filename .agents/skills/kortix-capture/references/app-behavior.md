# Kortix Capture

Kortix Capture records the screen 24/7 on macOS, Windows and Linux, extracts
its text, and keeps a searchable library: people use the timeline window,
agents use the `kortix-capture` CLI. Opt-in audio memory adds the microphone
and what the computer plays to the same timeline (see "Audio memory"), and the
action recorder adds clicks, keys and typed text with screenshots (see "Action
recording"). With sync on, the library goes to an S3-compatible bucket in the
Kortix Capture format (`capture-format.md` (this skill)), the app's only contract with
any cloud: your own bucket, or Kortix's after "Sign in with Kortix".

## Unified desktop application

The desktop package is **Kortix Capture**: one tray application with action recording,
keyboard/mouse tracking, screen memory, timeline/search, and cloud sync. It bundles
`kortix-tray`, `kortix-capture`, the native capture engine, backend tools, and the
ONNX runtime. Separate capture/action edition selectors are retired. Tray and
stealth release packages remain available for macOS and Windows.

## Always on: launch at login and crash restart

"Launch at Login" is on by default. It is a checkbox in the tray menu and a
switch under Settings, Recording (`launch_at_login` in `settings.json`; the tray
applies a change within a second). The tray installs the login entry on every
start, so an entry left by an older install or another app location is repaired.

| OS | Starts at login | Restarts after a crash | A user Quit |
|---|---|---|---|
| macOS | LaunchAgent `~/Library/LaunchAgents/ai.kortix.capture.tray.plist`, `RunAtLoad` | launchd `KeepAlive { SuccessfulExit = false }`, at most every 10 s | exits 0: stays stopped until the next login |
| Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value "Kortix Tray" | `kortix-tray` runs as a watchdog parent and restarts its child (2 s, doubling to 60 s; 5 min of uptime resets it) | exits 0: the watchdog ends too |
| Linux | XDG autostart `~/.config/autostart/ai.kortix.capture.tray.desktop` | the same watchdog | exits 0, or SIGTERM / SIGHUP / SIGINT (logout, `kill`): not restarted |

- Inside the tray, a supervisor keeps `kortix-capture record` running with its
  own backoff (2 s, doubling to 60 s; a minute of uptime resets it). The
  recorder stops when the tray dies (`--supervised` closes with the tray's pipe).
- Sleep, wake and screen lock do not stop anything: the recorder reports
  `locked` and resumes on unlock.
- macOS: a tray started by hand (Finder, or the timeline window reopening it)
  is supervised by launchd from the next login on.
- No login entry points at a Gatekeeper App Translocation copy or a temp
  folder: move the app to Applications first. Dead LaunchAgents of the
  predecessor app (labels `ai.kortix.memory*` whose program no longer exists)
  are removed on install.
- `KORTIX_TRAY_AUTO_LAUNCH=0` (test harnesses) leaves login entries alone;
  `KORTIX_TRAY_WATCHDOG=0` runs the tray without its watchdog (debugging).

## One computer, one device

- A device's id under a bucket prefix is 32 hex characters of SHA-256 over a
  domain string, the machine key and the prefix (`sync::device_id_for`). The
  machine key is SHA-256 of a fixed app prefix plus the OS machine id (macOS
  `IOPlatformUUID`, Windows `MachineGuid`, Linux `/etc/machine-id`; a random key
  in `<library>/machine-key` on a machine without one). The raw id never leaves
  the device (`src/machine.rs`); `device.json` carries the key hashed once more.
- One computer keeps one id under one prefix: reinstalling or restoring keeps it,
  another prefix gives another id.
- With "Sign in with Kortix" the issuer returns the device id (it scopes the
  credentials) and the device uses it. Signing in again on the same computer
  replaces the token; the registration (`<library>/sync-issuer.json`) and the
  token (OS secret store) belong to this library.
- Sign-in runs only from an explicit "Sign in with Kortix" in the welcome screen, the
  settings window, or `kortix-capture sync setup --provider kortix`.
- `device.json` names the hostname and the computer's name (System Settings
  name on macOS, pretty hostname on Linux), null while encryption or local PII
  masking is on.

## Live device status

Every 60 s, and about 15 s after the policy in force changes, the sync thread
writes `<prefix>/<device_id>/status.json` with the
device's live status (`memory::cli::device_status`): `recording`, `paused`,
`permission_missing` (with the missing permissions) or `not_recording` with a
reason; audio on or off; sync `ok`, `queued` (count), `error` (class) or `off`;
the newest frame; whether actions record; the policy in force; the app version;
`host.awakeSinceMs` (when the computer last woke from sleep or the app started;
a gap over 120 s between sync ticks counts as a sleep); `reportedAtMs`. A reader
shows a device as offline when `reportedAtMs` is older than 120 s.

## Fleet health and alerts

The API classifies every device from its last `status.json`
(`apps/api/src/capture/health.ts`, one pure function). The Devices page, the
`health` field of `GET /v1/accounts/:id/capture/devices` and the alert worker
all use it. States: `healthy`, `attention`, `not_recording`. A healthy device
that is locked, inactive or silent while idle is `idle`.

| Rule | Result |
|---|---|
| Silent over 120 s, last report `locked`, `inactive` or `paused` | healthy, idle (asleep or off) |
| Silent for 30 min or more (`KORTIX_CAPTURE_ALERT_AFTER_MINUTES`), last report otherwise | `not_recording`, reason `offline` |
| Silent over 7 days | `attention`, `unseen` |
| Never reported | `attention`, `never_reported` |
| `recording`, no frame for 5 min of awake time (since `host.awakeSinceMs`) | `not_recording`, `stalled` |
| `not_recording` (not locked, inactive), no frame for 5 min of awake time | `not_recording`, `error` |
| `permission_missing` | `attention` |
| `paused` by a person | `attention` |
| sync `error` | `attention`, `sync_error` |
| items pending, no upload for 30 min of awake time | `attention`, `backlog` |
| app older than the newest version in `capture-update.json` | `attention`, `behind_version` |

A closed laptop cannot report. A computer that was recording when it went
silent therefore shows `offline` after 30 min and clears when it wakes. The
host cannot tell a closed lid from a dead app until it reports again.

Alerts: the leader worker `workers/capture-health-worker.ts` runs
`capture/health-alerts.ts` every 60 s. A device `not_recording` for the
threshold (default 30 min) writes one `capture_device_down` inbox row for each
member with `capture.manage`; when the spell ends it writes one
`capture_device_recovered` row. The row's dedupe key is
`capture-down:<device_id>:<since_ms>` (and `capture-up:`), so a repeat tick or a
second replica writes nothing. Push and email follow each person's notification
preferences (default on for down, push only for recovered). The device sync
route runs the same check for its account, which is how the CAP-8 flow
observes it (the local profile runs no leader loops).

## Architecture

```text
kortix-tray ── supervises ──> kortix-capture record ──JSON lines──> kortix-capture-engine
    │  menu, shortcuts,            │  capture loop (2 s)                 macOS: Swift (ScreenCaptureKit,
    │  deep links                  │  OCR worker (incremental)           Vision, AX, AVFoundation HEVC)
    └─> kortix-capture ui           │  finalizer (HEVC chunks)            Windows/Linux: Rust engine
        (timeline, search)         │  retention, favicons
                                   v
                     <library>/memory.db  frames/  videos/  audio/  icons/  settings.json  recorder.json
agents ──> kortix-capture list|usage|query|now|link|grab-screen (read-only SQLite)
```

- The engine is the only platform-specific process. The protocol (one JSON
  request per stdin line, one response per stdout line) is documented at the
  top of `native/macos/CaptureEngine.swift`; the Windows/Linux engine
  (`src/capture_engine/`) implements the same commands, except incremental OCR
  (always `mode: "full"`).
- A request that exceeds its timeout kills the engine; the next request
  respawns it. A wedged OS API never stalls the recorder.
- Queries open the database read-only (WAL), so the CLI works while the
  recorder writes and when it is stopped.

## Library layout

| Path | Content |
|---|---|
| `memory.db` | SQLite: `frame`, `segment`, `application`, `domain`, `video`, `ocr`, `window_bound`, `ocr_fts` (FTS5, porter), `ax_blob`/`ax_snapshot`, `timezone`, `app_version`, `metadata`, `once_tasks` (one-shot data migrations already applied), `audio`, `audio_transcript`, `audio_fts` (FTS5, porter) |
| `frames/` | Staged JPEG stills awaiting OCR and encoding |
| `videos/` | 1 fps HEVC MP4 chunks, frame *i* at *t* = *i* s, ≤ 30 frames each |
| `icons/` | App icons and website favicons |
| `audio/` | Audio memory segments, `<start_ms>.m4a`; `audio/staging/` holds the raw PCM of the open segment. Created only once audio is turned on |
| `audio.json` | Audio heartbeat: state, each source's state and device, the open segment. Written only once audio is turned on |
| `settings.json` | User settings, hot-reloaded by the recorder |
| `recorder.json` | Recorder heartbeat: state, `inactive_reason`, reason, last frame, OCR backlog, permissions |
| `.kortix-storage-reserve` | Pre-allocated disk reserve, `storage.reserve_mb` (default 500). See "Disk reserve" |
| `actions/` | Action segments, `<start_ms>-x<id>.actions.jsonl.zst`, and their screenshots in `actions/assets/sha256-<hex>.<ext>` (see "Action recording") |
| `actions.json` | Action recorder heartbeat: recording or not, and why the policy blocks it |
| `policy.json` | The operator's policy the sync thread last read (see "Operator policy") |
| `sync.json`, `sync-credentials.json`, `sync-issuer.json` | Sync state; static S3 credentials (0600); the Kortix sign-in registration (no secrets) |
| `diagnostics/` | Diagnostics bundles saved while sync is off |

Default location: `~/Library/Application Support/ai.kortix.capture` (macOS),
`%APPDATA%\ai.kortix.capture` (Windows), `~/.local/share/ai.kortix.capture`
(Linux). `KORTIX_CAPTURE_DIR` overrides it.


## Pipeline

1. **Capture** every `interval_ms` (2000), and also right after the focus
   changes (see "Change-driven capture"). The engine returns the frontmost
   app, focused window, browser URL (AX `AXWebArea`/`AXURL`), the window
   stack, an optional AX tree of the focused window, and a JPEG still of the
   display that holds the focused window. Excluded apps' windows are removed
   from the image (ScreenCaptureKit filter).
2. **Skip** instead of capture when: screen locked, no input for
   `inactivity_seconds`, excluded app or domain in front, private browsing
   window, app without a bundle id (unless allowed), recording disabled or
   paused, free disk below `storage.min_free_gb`, or a sync backlog larger
   than the storage limit. Every reason shows as `inactive_reason` in
   `status` (see "Why recording is not happening").
3. **OCR** runs on its own engine process. A still that is byte-identical to
   the previous one copies its text. Otherwise the engine diffs the still
   against the previous one (32 px tiles), re-reads only changed regions grown
   to the old lines they touch, and keeps the rest; a full pass runs every 60
   frames or when more than 45% changed. Text inside the focused window goes
   to `foreground`, the rest to `background`; box offsets index into
   `foreground || background`.
4. **Finalize**: OCR'd stills are packed into HEVC chunks and deleted.

5. **Retain**: every 10 min, `storage_cap` mode deletes (or downscales) the
   oldest chunks until the library is 5% under `limit_gb`; `retention` mode
   acts on chunks older than `retention_days`. The default ("Keep recordings on this
   computer": 7 days) is `retention`, 7 days, `delete`; with sync on it never deletes a
   chunk that is not uploaded yet. Text, titles, URLs and search survive; the timeline
   shows "removed to save storage".

### Experimental local personal-data masking

At the bottom of Settings, the collapsed **Experimental · Local privacy**
section contains **Enable experimental local PII masking**, which controls
`privacy.redact_pii` (default `false`). The controls remain hidden until the
section is expanded. Opening Settings and downloading model files never enable
masking. When off, normal capture and configured sync continue without PII
masking, subject to recording exclusions. Existing opt-ins survive updates.
Both the settings UI and CLI support it:

```bash
kortix-capture settings privacy.redact_pii true
kortix-capture settings privacy.redact_pii false
```

When enabled, the native engine captures and recognizes the screen in memory.
The raw pixels and recognized text travel only through the local process pipe.
The recorder replaces detected values with `[email]`, `[card]`, `[ssn]`,
`[phone]`, `[iban]`, or `[secret]`, covers every matching OCR rectangle with an
opaque black mask, and writes the masked JPEG. No raw staged image is written
by this path. Frame text and updated character offsets commit together in one
SQLite transaction; FTS triggers and the uploaded metadata sidecar therefore
inherit the masked values. Titles, URLs, app names, and accessibility strings
are filtered before persistence too. Each frame and its sidecar carry
`pii_redacted` to identify the policy applied at capture time.
Private sidecars also replace application display names with `[redacted]`,
because shared application records can contain names cached before masking was
enabled. Application bundle IDs remain available for grouping.

Patterns cover emails, Luhn-valid cards, US SSNs, common international and US
phone formats, checksum-valid IBANs, AWS access-key IDs, GitHub/Slack/Stripe/API
key shapes, bearer tokens, and JWT shapes. With masking enabled,
`privacy.use_local_model` defaults to `true`: the pinned, quantized
[OpenAI Privacy Filter](https://huggingface.co/openai/privacy-filter) adds local
name, address, account, date, URL, and secret detection. Install its approximately
945 MB tokenizer/weights once using **Download model · ~945 MB** in the experimental section,
or `kortix-capture privacy-model --install`. The application runs inference
in-process on the CPU through ONNX Runtime; it needs no Python, API key, remote
inference, or network connection after installation. Downloads are explicit and
checksum verified. ONNX runtime telemetry is explicitly disabled. Offline provisioning can copy the verified `privacy-model/`
directory into the library. Airgap mode prohibits downloads.

The settings UI shows downloaded bytes and the checking, download, runtime and
verification stages. It offers retry after installation failure and status
recovery after connection failure; reopening the section resumes tracking an
ongoing installation. The model-based enable switch stays unavailable until
installation finishes. Patterns-only mode is an explicit lighter alternative
that does not detect names or addresses. Existing enabled users can always turn
masking off, even if the model becomes unavailable.

Missing/invalid required model assets or inference failures stop private frame
capture; they never fall back to unfiltered recording. Users can explicitly
choose patterns alone by setting `privacy.use_local_model` to `false`. Matched
OCR boxes are covered in full, which can also hide surrounding text on that line.
The model may mask more than the checksum-based patterns, including card-shaped
account values that fail Luhn. Turning `redact_pii` off restores normal capture.

### Keyboard and mouse activity

The same flag applies before both raw and processed action event writers. Keyboard
and mouse tracking stays active: timestamps, mouse coordinates, buttons,
scrolling, and known navigation/modifier keys remain. Typed characters are
replaced with `[redacted]`; native key codes, text payloads, titles, unknown
fields and accessibility content are removed. Action-recorder screenshots are fully
black in privacy mode because that recorder has no OCR rectangles. The screen
memory timeline provides the finer masks described above. Unknown event types
are dropped. Action recording uploads pause while privacy is enabled; masked
screen-memory chunks and sidecars can still sync. Disabling privacy resumes the
normal event path for subsequent callbacks.

Setting changes apply to subsequent captures. Existing frames retain their
original policy, including pending OCR and chunks awaiting upload; enabling the
filter does not rewrite old recordings or remove old cloud copies. Invalid hot
reloads retain the last valid settings. Invalid/unreadable initial settings
stop screen capture and conceal action events. Unsupported engines or failed
private OCR produce no frame, image, or video, with no unfiltered fallback.

OCR, patterns, and the model can miss values. This is detection-based masking,
not a guarantee of complete anonymization. Independent synthetic text evaluation
and native synthetic screen verification are repeatable; dataset-wide model
coverage remains preliminary. Synthetic screenshot benchmarks are a follow-up.

Run `python3 scripts/verify_pii_local.py` from `apps/capture/` for the repeatable
synthetic support task, actual native OCR and video, SQLite/FTS checks,
localhost S3 upload, live setting changes, and failure-path verification.
See `scripts/README.md` for prerequisites and visual evidence output.

## Cloud sync

With sync on, the bucket is the durable copy of the library and the machine
is a cache: every finished chunk goes up with everything needed to rebuild
search and the timeline, and `kortix-capture sync restore` rebuilds a library
on a new machine from the bucket alone. After a verified upload the local
video is deleted (`sync.keep_local_hours`, default 0). Search text stays in
the local database, so search works offline. Playback of a remote-only chunk
downloads it into `cache/videos/` (capped by `sync.cache_mb`, default 1024).

Every upload is plain S3 in the Kortix Capture format
(`capture-format.md` (this skill), schema 2). `sync.provider` picks where the S3
credentials come from: `s3` (default; your own AWS S3, Cloudflare R2, MinIO,
versitygw or any S3-compatible bucket, static credentials, settings under
`sync.s3`) or `kortix` (short-lived credentials from a credential issuer after
"Sign in with Kortix"; see "Sign in with Kortix"). Settings files from before
`sync.provider` kept the S3 fields flat (`sync.endpoint`, ...); they load
unchanged and save nested.

```bash
kortix-capture sync setup --endpoint https://s3.us-east-1.amazonaws.com --bucket my-bucket \
  --access-key-id AKIA... --secret-access-key ...        # or KORTIX_CAPTURE_S3_* env vars
kortix-capture sync status        # queue, bytes pending, oldest unsent, throughput, last error and its class
kortix-capture sync test          # PUT + HEAD + DELETE a probe object
kortix-capture sync devices       # machines that sync under this prefix
kortix-capture sync restore [--from 2026-09-01] [--device <id>]
kortix-capture sync sign-out      # forget the Kortix sign-in; Kortix sync off
kortix-capture sync key export    # print the encryption key (when sync.encrypt is on)
kortix-capture sync key import <key>
kortix-capture sync off
```

- `setup` probes the target first and turns sync on only when the probe
  passes. Credentials go to `<library>/sync-credentials.json` (mode 0600),
  never to `settings.json`. MinIO and most self-hosted servers need
  `--path-style`. `--encrypt` turns on client-side encryption.
- `airgap: true` disables sync.

### What goes up

Under `<prefix>/<device_id>/`, per item, in this order (the format spec has
every field):

| Object | Content |
|---|---|
| `assets/sha256-<hex>.<ext>` | App and site icons the chunk's frames use, and action screenshots; content-addressed, uploaded once per bucket key |
| `<YYYY>/<MM>/<DD>/<start_ms>-<id>.frames.jsonl.zst` | One JSON line per frame: time, app, window title, URL, domain, display, window list, OCR text with box offsets, AX tree, icon names |
| `….mp4` | The video chunk |
| `<YYYY>/<MM>/<DD>/<start_ms>-a<id>.m4a` | An audio segment (see "Audio memory") |
| `<YYYY>/<MM>/<DD>/<start_ms>-x<id>.actions.jsonl.zst` | An action segment: one JSON line per processed action (see "Action recording") |
| `….manifest.json` | Schema 2, kind (`chunk`, `audio`, `actions`), time range, privacy, and the size and SHA-256 of every object. It is written last: a manifest means the item is complete |
| `index/<YYYY-MM-DD>.jsonl` | Append-only daily index: one `put` line per item, one `delete` line per removal (UTC day of the item start) |
| `device.json` | Device id, machine-key hash, OS, app version, member, first and last chunk time, encryption key id |
| `status.json` | The live status, every 60 s (see "Live device status") |
| `diagnostics/<ts>.tar.zst` | A redacted diagnostics bundle, only when the person sends one |

### Integrity and failures

- Every PUT and every multipart part carries a signed
  `x-amz-checksum-sha256` header; the server rejects a body that does not
  match (`400 BadDigest`, retried). Every object is then read back by HEAD for
  its size. The manifest records the SHA-256 of each object, and restore and
  playback check it.
- Bodies stream from disk. A file larger than `sync.part_mb` (default 16 MB,
  min 5) uploads as multipart; finished parts are recorded in the library, so
  a crash, a network loss or a server restart resumes at the first missing
  part instead of starting over.
- `sync.concurrency` (default 3, max 8) chunks upload in parallel;
  `sync.max_upload_kbps` (default 0 = unlimited) caps the total upload rate.
- Errors have a class (`sync status` and `sync.json` show it as
  `last_error_class`):

| Class | Cause | What sync does |
|---|---|---|
| `auth` | 401/403: wrong or revoked credentials | Stops the pass; retries the target with backoff; nothing is deleted locally and no chunk spends an attempt |
| `config` | Bad endpoint, bucket or region, missing credentials or encryption key | Same as `auth` |
| `clock_skew` | The local clock is far off and the server gave no usable time | Same as `auth`. A 401/403 whose `Date` header is more than 5 min off is retried once with the server clock |
| `transient` | 5xx, 408, 429, timeouts, connection loss | Backs off per chunk: jittered, 5 s doubling to 10 min |
| `integrity` | Checksum or size mismatch | Same as `transient` |
| `local` | The local file cannot be read | Same as `transient` |

- With sync on, the storage cap never removes a chunk that has not been
  uploaded unless it is older than 7 days; an uploaded chunk freed by the cap
  stays playable from the cloud.

### Restore and devices

`sync restore` rebuilds the current library (`KORTIX_CAPTURE_DIR`, or the
default one) from a device's daily index: frames, OCR text and boxes,
windows, AX trees, apps, domains and icons. Videos stay in the bucket and
stream on demand, so search and the timeline work at once. On a new machine:
run `sync setup` with the same bucket and prefix, `sync key import` when the
bucket is encrypted, then `sync restore`. Without `--device` restore picks
this machine's id when the bucket has it, else the only device; with several
devices it lists them. `--from` skips chunks that ended earlier. Chunks
already in the library are skipped, so restore can run again to resume or
catch up. Frames keep their segments across chunks and restore runs (the
sidecar carries each frame's segment id), so search collapses repeats the
same way on both machines. Chunks uploaded before the index existed are found
by listing.

### Deletion and cloud retention

- `kortix-capture storage forget --tr <range> --yes` deletes everything
  recorded in the range: frames, text, windows, AX trees, videos, staged
  stills, and the bucket's copies (video, sidecar, manifest, and an open
  multipart upload). Whole chunks go, so the removed range can be wider than
  asked; without `--yes` it prints what it would delete. Remote deletes queue
  in the library and run on the next sync pass, also after sync was off.
- Local storage management (`storage.*`) only frees disk on this machine: an
  uploaded chunk it removes stays in the bucket and stays playable.
- `sync.remote_retention_days` (default 0 = keep) deletes chunk objects from
  the bucket once they are that many days old. Their text stays searchable in
  this library; a chunk with no local video shows "removed to save storage".
  A restore no longer sees them. Icons and the daily index are kept. A bucket
  lifecycle rule works too; add one that aborts incomplete multipart uploads
  after 7 days.

### Client-side encryption

`sync.encrypt` (default off; `sync setup --encrypt`, or `settings sync.encrypt
true`) encrypts every object except `device.json` before upload with
AES-256-GCM (1 MiB segments, so any size works in constant memory), and the
bucket holds ciphertext only. With encryption on, `device.json` names the key
id and omits the hostname. The key is generated on this machine. On macOS it
is kept in the login Keychain (service `ai.kortix.capture.sync`); elsewhere,
or when the Keychain refuses, in `<library>/sync-key` (mode 0600).
`settings.json` holds only its id (`sync.key_id`).

**Losing the key loses the data.** Nobody, including Kortix, can decrypt the
bucket without it. Run `kortix-capture sync key export` right after turning
encryption on and keep the key in a password manager. A new machine needs
`sync key import <key>` before `sync restore` or playback of remote chunks;
without it restore stops with a `config` error and writes nothing.

### Status

`sync status` and `<library>/sync.json` (read by the tray and UI) report
`state` (`off`, `ok`, `error`), `provider`, `sign_in_required`, `pending` (queue
depth), `audio_pending`, `actions_pending` (and `_uploaded`, `_remote_only`),
`status_reported_ms`, `bytes_pending`,
`oldest_unsent_ms`, `retrying`, `uploaded`, `remote_only`, `tombstones`
(remote deletes queued), `multipart_in_progress`, `throughput_bps`,
`bytes_uploaded`, `last_error`, `last_error_class`, `next_retry_ms`,
`encrypted`, `key_id` and `clock_offset_ms`.

| Setting | Default | Meaning |
|---|---|---|
| `sync.provider` | `s3` | `s3` (static credentials) or `kortix` (credential issuer) |
| `sync.kortix.url` | `""` | Issuer URL; empty uses the build's default (`KORTIX_DEFAULT_ISSUER_URL`) |
| `sync.s3.endpoint`, `.bucket`, `.region`, `.prefix`, `.path_style` | -, -, `us-east-1`, `kortix-capture`, false | S3 target |
| `sync.keep_local_hours` | 0 | Keep the local video this long after a verified upload |
| `sync.cache_mb` | 1024 | Playback cache for remote chunks |
| `sync.concurrency` | 3 | Parallel chunk uploads (1-8) |
| `sync.max_upload_kbps` | 0 | Upload bandwidth cap, KB/s; 0 = unlimited |
| `sync.part_mb` | 16 | Multipart threshold and part size, MB (min 5) |
| `sync.remote_retention_days` | 0 | Delete chunk objects from the cloud after this many days; 0 = keep |
| `sync.encrypt` | false | Client-side AES-256-GCM |

## Sign in with Kortix

"Sign in with Kortix" (tray, settings window, or `kortix-capture sync setup
--provider kortix [--issuer <url>] [--no-browser]`) syncs to your organization's
bucket without S3 keys on the computer. Kortix is one credential issuer; any
server that speaks the protocol in `capture-format.md` (this skill) ("Credentials") is
another.

1. The app runs an OAuth 2.0 device authorization grant (RFC 8628) against the
   issuer: it opens the approval page in the browser and shows a code; the
   person approves. The issuer is `sync.kortix.url`, else the build's default
   (`KORTIX_DEFAULT_ISSUER_URL`, set by `capture-build.yml` from the release channel:
   `https://api.kortix.com` for a release, `https://dev-api.kortix.com` for dev); a build without one asks for the URL in Settings.
2. The device token goes to the OS secret store (macOS Keychain, Windows
   Credential Manager, Linux Secret Service; a mode-0600 file in the library
   where none is available, or with `KORTIX_CAPTURE_KEY_STORE=file`). The
   prefix, device id and member go to `<library>/sync-issuer.json`.
3. Each pass gets S3 credentials from `POST <issuer>/v1/capture/credentials`,
   keeps them in memory, and fetches new ones 5 minutes before they expire or
   after the store refuses them. Everything else is the same S3 sync.
4. Only the issuer's own refusal (401 with `code: capture_device_unauthorized`)
   marks the device refused. Any other 401/403 (a proxy, a firewall, a load
   balancer) and `capture_disabled` (the organization switched Capture off) are
   transient: sync keeps the sign-in and retries with backoff (up to 10 min).
   `capture_disabled` shows as "Paused. Kortix Capture is turned off for your
   organization." On a managed computer `capture_disabled` counts as a refusal:
   it stops recording, and the machine service enrolls it again (hourly) once
   the organization turns Capture back on.
5. A refused device is not given up: it asks the issuer again every 15 min and
   at every process start (an update, a reboot) with the token it still holds.
   When the issuer accepts it (an admin restored it, the person was added back),
   sync resumes with no new sign-in. Meanwhile `sync status` says
   `sign_in_required`, and the line reads "Disconnected from Kortix. Sign in
   again to resume." ("… Reconnecting." on a managed computer, which the machine
   service enrolls again). Recordings stay on the computer.
6. When nothing reached the bucket (no upload, no minute status report) for
   30 min while sync is on, the line says "Last synced 2 h ago." and why. The
   tray notifies once when sync stays broken for 5 min ("Kortix Capture is not
   syncing") and once when it is back ("Kortix Capture is syncing again"); its
   tooltip carries the line meanwhile.
7. An update or reinstall keeps the device: the registration lives in the
   library and the token in the OS store (or the 0600 file), which installers
   never touch. CI asserts the same device id stays signed in and fetches
   credentials again after the macOS reinstall and the Windows MSI upgrade.

- `sync.encrypt` is refused with Kortix: Kortix reads the bucket to index it.
- `kortix-capture sync sign-out` (settings: Sign out) forgets the token and the
  registration and turns Kortix sync off; nothing is deleted.
- Restore and `sync devices` work with the issued credentials as far as the
  issuer's scope allows (the device's own prefix at least).

## Organization rollout (Windows, MSI)

IT installs Kortix Capture on many computers with one enrollment token; nobody
signs in by hand. Kortix creates the token (Account settings, Kortix Capture,
Devices) and shows it once.

```text
msiexec /i KortixCapture-<tag>-x64.msi /qn KORTIX_URL=https://api.kortix.com ENROLLMENT_TOKEN=kortix_enr_...
```

The MSI (`installer/windows/kortix-capture.wxs`, built by
`installer/windows/build-msi.ps1` and by `capture-build.yml`):

- installs `kortix-capture`, `kortix-capture-engine`, `kortix-backend` and the
  ONNX runtime to `%ProgramFiles%\Kortix\Capture`, per machine;
- registers the Windows service `KortixCapture` (LocalSystem, automatic,
  restarts 10 s after a failure): `kortix-capture machine run`;
- writes `Url` and `EnrollmentToken` to `HKLM\SOFTWARE\Policies\Kortix\Capture`
  (`EnrollmentToken` through a deferred custom action, `kortix-capture machine
  configure`, whose command line is hidden: Windows Installer logs every
  Registry-table value, hidden property or not).
  The key has a protected ACL: SYSTEM and Administrators only, so nobody who
  uses the computer can read the token. `ENROLLMENT_TOKEN` is a hidden
  property: it never reaches the MSI log. Without the two properties the
  values stay as they are: IT may set them by Group Policy or Intune instead,
  and an upgrade keeps them;
- uninstall stops the service (and every recorder it started), removes the
  files, the two values and `%ProgramData%\Kortix\Capture`. People's
  recordings stay in their profiles.

For every person who signs in to the computer, the machine service:

1. reads who it is from the session's token: the user principal name
   (`GetUserNameEx`; for Entra ID accounts the identity store) and the login
   name. Nothing the person types decides it;
2. asks the person's library whether it is enrolled with this Kortix
   (`kortix-capture --json sync status`, run as the person);
3. if not, enrolls itself (`POST <Url>/v1/capture/device/enroll`) and hands
   only the resulting device token to the person's process (`kortix-capture
   sync adopt`, JSON on stdin), which stores it like a sign-in (Credential
   Manager, `sync-issuer.json` with `managed: true`) and turns Kortix sync on;
4. keeps one `kortix-capture service run --managed` running as the person in
   their session. It records, uploads, and starts `kortix-capture tray`: the
   tray icon ("Kortix Capture — recording for <organization>") that shows the
   organization's notice and opens the timeline. It has no quit item on a
   managed computer.

`kortix-capture tray` is one cross-platform program (the `tray-icon` crate on a
`tao` event loop): the notification area on Windows, the menu bar on macOS, and
AppIndicator/StatusNotifier on Linux (built with the `tray-linux` feature, which
needs gtk and libayatana-appindicator). Its menu shows the status and the
account; on a computer the person set up themselves (not managed) it also offers
"Pause for 1 hour" / "Resume" and "Quit". Signing in lives in Settings, Sync. `member` is `null` on the device until an
admin links it to a Kortix user; the tray then shows the account name only.

| Enrollment answer | Effect | Next attempt |
|---|---|---|
| `enrolled` | records and uploads | checked again every 5 min |
| `pending` (`approval_required`) | records nothing | after `retry_after_s` |
| `enrollment_token_invalid`, `capture_disabled`, `enrollment_limit_reached` | records nothing | 1 h |
| `enrollment_denied`, `enrollment_domain_not_allowed` | records nothing | 6 h |
| network error, 429, 5xx | records nothing | 1 min |

A managed library records only while its enrollment stands: a revoked device
(401 `capture_device_unauthorized` from the issuer) stops recording, and the machine service enrolls again
(an admin revoke then shows as `approval_required` in Kortix). The person
cannot opt out on that computer: `kortix-capture start` reports `managed`,
`stop`, `logout` and `sync sign-out` refuse, killed processes come back within
30 s (18 s measured), and `service run --managed` turns Kortix sync back on if it was
turned off. `kortix-capture machine status` shows the configuration (never
the token), the service and every session's state; the service writes
`%ProgramData%\Kortix\Capture\machine.json` and `logs\machine.log` (no secrets).

On Linux and macOS (and for a manual test), `kortix-capture sync enroll
--issuer <url> [--principal <upn>] [--account-name <name>]` enrolls the
current user with a token read from stdin and prints `enrolled`, `pending` or
`refused`.

`kortix-capture --json status` and `--json sync status` carry `"managed": true`
and `"enrollment": {"state", "reason", "code", "next_attempt_at_ms", "account_name"}`
on a managed computer: `enrolled` (with a member, or `member: null` until an admin links the device to
a Kortix user), `pending` (`reason`: `approval_required`), `refused` (`code`),
`error`, or `enrolling` before the
machine service's first answer. The machine service records each answer in the
person's library (`managed.json`, via the hidden `sync enrollment-state`); the
Kortix desktop app shows it.

## Standalone installs (macOS pkg, Linux deb)

Kortix Capture installs without the Kortix desktop app on every OS. A person
installs the package and signs in with their Kortix account from the tray; or IT
installs it with an enrollment token and nobody signs in. The release attaches
one installer per OS:

| OS | Asset | Installs |
|---|---|---|
| Windows | `KortixCapture-<tag>-x64.msi` | see "Organization rollout (Windows, MSI)" |
| macOS | `KortixCapture-<tag>-universal.pkg` (arm64 + x86_64) | `/Applications/Kortix Capture.app`, LaunchDaemon `ai.kortix.capture.machine`, LaunchAgent `ai.kortix.capture.agent` |
| Linux (X11) | `kortix-capture_<tag>_amd64.deb` | `/usr/bin/kortix-capture` (+ engine, action recorder, ONNX runtime), `kortix-capture-machine.service`, user unit `kortix-capture.service` |

### A person installs it for themselves

Kortix Capture records on this computer from the moment it is installed, and the window is a
timeline and search over those recordings. Sync to Kortix is the default.

- **First launch.** Recording starts at install, in the background. The first window asks the
  person to sign in with Kortix; signing in turns sync on. Two quiet exits: "Use your own S3
  bucket" and "Skip. Keep recordings on this computer".
- **Sync**, under Settings, shows where recordings go now: the Kortix account and the person
  signed in, the S3 bucket, or, when sync is off, one sentence and "Sign in with Kortix".
  Changing it is under Advanced, Sync destination: **Kortix**, **Your S3 bucket** (endpoint,
  bucket, region, folder, access key; the secret is write-only) or **Off**. Choosing Off, or
  "Sign out", asks first ("Stop syncing?": new recordings stay only on this computer, with no
  backup); nothing changes until the person confirms. Changing the destination never needs
  the recording stopped. Only recordings made after the change go to the new destination;
  earlier ones stay on this computer (`local_only` in the database). Signing out of Kortix
  turns sync off, keeps the recordings, and keeps recording.
- **Menu bar / tray.** Status line, sync line, "Open Kortix Capture", "Settings…", the
  pauses (1 hour, until tomorrow, until resumed) or "Resume". There is no Quit. A managed
  computer shows the organization and has no pauses.
- **Errors** in the window are one short sentence. The detail is in the log
  (Settings, About, Open logs).

The service starts the tray again after every exit, exit 0 too: macOS quits it when a
person changes one of its privacy permissions in System Settings.

### IT enrolls the computer

IT puts the Kortix URL and an enrollment token on the computer. The package is the
same with or without them.

| | macOS | Linux |
|---|---|---|
| Install | `sudo installer -pkg KortixCapture-<tag>-universal.pkg -target /` | `sudo apt install ./kortix-capture_<tag>_amd64.deb` |
| Config, option 1 | `/Library/Application Support/Kortix/Capture/config.json` | `/etc/kortix/capture.json` |
| Config, option 2 (readable by every user) | MDM configuration profile, preference domain `ai.kortix.capture`, keys `Url` and `EnrollmentToken` (`/Library/Managed Preferences/ai.kortix.capture.plist`) | none |
| Machine service | LaunchDaemon `ai.kortix.capture.machine` (root) | `kortix-capture-machine.service` (root) |
| In each session | LaunchAgent `ai.kortix.capture.agent`, loaded by launchd at every GUI login | user unit `kortix-capture.service`, enabled globally; starts only when `/etc/kortix/capture.json` exists |
| Remove | `sudo "/Applications/Kortix Capture.app/Contents/Resources/uninstall.sh"` | `sudo apt purge kortix-capture` |

**A configuration profile is readable by every local user.** macOS stores the profile's
payload in `/Library/Managed Preferences`, and any account on the computer can read the
enrollment token from it. Use the root-only `config.json` (option 1, mode 0600) as the
default. Use a profile only when the token is a short-lived, single-use or low-privilege
token, and rotate it after the rollout. Put this warning in the header of any
`.mobileconfig` you build from this page.

The config file is `{"url": "https://api.kortix.com", "enrollment_token": "kortix_enr_..."}`,
mode 0600, owned by root, in a directory everyone can search (0755). Write it by hand,
with your configuration tool, or with `sudo kortix-capture machine configure --url
https://api.kortix.com` (the token on stdin, or `--token`). The service ignores a file
that another user owns or can write. Config arriving after the install takes effect
within about 30 s on macOS (the agent polls for it); on Linux the machine service
enrolls the person and starts their user unit as soon as the file exists.

The machine service (`kortix-capture machine run`, root, a tick every 10 s):

1. finds the people at the screen. macOS: the console user (the owner of
   `/dev/console`; the login window is root and enrolls nobody). Linux: the users
   of local logind sessions of class `user` and type `x11`, `wayland` or `mir` that
   are `active` or `online` (not remote, not ssh, not a greeter);
2. reads who the person is from the account, never from anything they type:
   the login name is `account_name`; `principal_name` is the email in the macOS
   account record (`dscl . -read /Users/<name> EMailAddress`) or, on Linux, the
   login name when it is a `name@domain` (SSSD with fully qualified names), else `null`;
3. asks the person's library whether it is enrolled with this Kortix (`sync
   status`, run as the person: macOS `launchctl asuser <uid> sudo -u <name>`, so the
   login Keychain opens; Linux `runuser -u <name> -- env -i …` with the file key
   store, since the person's Secret Service has no bus there);
4. if not, enrolls itself (same HTTP contract and answers as on Windows) and hands
   only the device token to that process (`sync adopt`, JSON on stdin);
5. starts the person's agent (`launchctl kickstart`, `systemctl --machine=<name>@.host
   --user start`).

It never starts a recorder itself. The agent (`kortix-capture agent`) is `service
run --managed`: it records only while the library's enrollment stands, keeps Kortix
sync on, and runs the tray with the organization's name and notice. The tray starts
a notification once per session (see below). State and log of the machine service:
`machine.json` and `logs/machine.log` in `/Library/Application Support/Kortix/Capture`
(macOS) or `/var/lib/kortix/capture` (Linux); `kortix-capture machine status` prints
the configuration (never the token), the service state and each person's state.

Limits, stated plainly:

- A profile's managed preferences are readable by every user (`/Library/Managed
  Preferences/*.plist` is 0644), so a profile cannot keep the token from the people
  on that Mac. Use `config.json` (0600) when the token must stay secret; or accept
  that the enrollment token is also visible to them (it can be limited and revoked in Kortix).
- A person with administrator rights can stop their own agent (`launchctl bootout`,
  `systemctl --user stop`) until the next login; launchd and systemd restart a killed
  agent. The recording is not tamper-proof against an administrator.
- **Wayland.** The Linux recorder captures X11 through `x11rb`. In a Wayland session
  the engine answers `wayland_unsupported` for every capture: nothing is recorded,
  and the tray says "Not recording: a Wayland session". The machine service still
  enrolls the person (a Wayland user who switches to an X11 session at the login
  screen records from then on). Wayland capture needs the portal and PipeWire, with a
  consent dialog per session; it is not built.
- macOS 14 or later (the Swift capture engine targets `macosx14.0`).

### macOS permissions (PPPC)

macOS asks each person once for Screen Recording, Accessibility, Input Monitoring
and the Microphone, for the app `Kortix Capture` (the agent starts `permissions
--request` at the first enrollment). IT can pre-approve what Apple lets a profile
approve, with a Privacy Preferences Policy Control payload
(`com.apple.TCC.configuration-profile-policy`) for `ai.kortix.capture`:

| Service (TCC key) | Pre-grant by profile |
|---|---|
| Accessibility (`Accessibility`) | `Authorization` = `Allow` |
| Input Monitoring (`ListenEvent`) | `Authorization` = `Allow` |
| Screen Recording (`ScreenCapture`) | only `AllowStandardUserToSetSystemService`: a standard user can approve it without administrator rights; a profile cannot approve it for them |
| Microphone (`Microphone`) | `Deny`, or leave unset (audio memory is off by default) |

Set `IdentifierType` to `bundleID`, `Identifier` to `ai.kortix.capture`, and
`CodeRequirement` to the output of `codesign -dr - "/Applications/Kortix Capture.app"`
without the `designated => ` prefix. A grant belongs to the app, not to the command
line tool: all recorders run as children of `Kortix Capture` and share it. Sample
payloads: `installer/macos/examples/`. (The Allow/Deny rules per service follow the
task's brief; verify them against Apple's current TCC payload documentation before
rollout.)

### The logon notice

At the start of each session the tray shows one desktop notification: the operator
policy's `notice` (see "Operator policy"), or "Kortix Capture records this computer's
screen and actions for <organization>. Your organization's recording policy applies."
It waits up to 45 s after the tray starts for the policy to arrive. A computer that
records only for its person (not signed in) shows none. The tray's hover text and menu
carry the same words.

- Windows: a toast through PowerShell's WinRT bridge.
- macOS: `osascript` `display notification`; it appears under the Script Editor's name.
  A native `UNUserNotificationCenter` notification from the app itself is not built.
- Linux: `org.freedesktop.Notifications.Notify` on the session bus (`gdbus`, else
  `notify-send`). A desktop without a notification service shows nothing.

## Operator policy

Whoever runs the bucket can write `<prefix>/policy.json` (every device) or
`<prefix>/<device_id>/policy.json` (one device; it replaces the prefix file).
The sync thread reads it at start and every 60 s into `<library>/policy.json`,
and every part that records obeys it within one poll
(`Settings::effective`). A policy only narrows what the person allowed:

| Field | Effect |
|---|---|
| `layers.screen`, `.actions`, `.audio` | `false` stops that layer, even when the person turned it on |
| `privacy.redact_pii` | `true` turns local PII masking on (and pauses action uploads, as masking always does) |
| `retention.local_hours` | Caps `sync.keep_local_hours` |
| `retention.remote_days` | Caps `sync.remote_retention_days` |
| `recording.paused`, `.paused_until_ms` | Pauses every layer, until the time or until lifted |
| `notice` | Shown in the tray menu ("Policy: …") and the settings window |

The person's own settings stay as they set them; the policy applies on top while
sync is on and is dropped when sync goes off. The tray always shows which layers
record ("Recording: Screen, Actions") and the notice; status.json reports the
policy in force.

## Action recording

The action recorder (keyboard, mouse and scroll events folded into `click`,
`drag`, `scroll`, `press`, `hotkey`, `typewrite`, with screenshots) records
60 s segments while the tray's "Start Recording" is on. Each finished segment
goes into the library (`memory::actions::ingest`): one JSON line per action in
`actions/<start_ms>-x<id>.actions.jsonl.zst`, every screenshot once in
`actions/assets/sha256-<hex>.<ext>`, a row in `action_segment`, and the spool
under the recordings directory is removed. App and window come from the screen
memory frame up to 5 s before the action; `target` is the accessibility element
under a click.

- Sync uploads action segments like chunks: screenshots first, the actions
  object, the manifest last; offload, remote retention, `storage forget`
  (which also removes screenshots no other segment shows) and restore cover
  them. While local PII masking is on, action uploads pause.
- `actions.local_cap_gb` (config, default 2) caps the local action store:
  uploaded segments leave this computer first; a segment that never uploaded
  waits up to 7 days while sync is on.
- After a crash, `kortix-backend` and the tray finalize abandoned segments
  (regenerating the processed file from the raw stream) and ingest them on the
  next start.
- The headless package runs `kortix-backend --service`: segments, the
  library's sync without a tray (`packaging/`).

## Diagnostics

"Send Diagnostics" in the tray and `kortix-backend send-diagnostics` build a
redacted bundle (client logs with secrets removed, the library's sync, recorder,
audio, actions and policy state, the action spool summary, device info) as
`diagnostics.json` in a `.tar.zst`. With sync on it goes to
`<prefix>/<device_id>/diagnostics/<YYYYMMDDTHHMMSSZ>.tar.zst` (encrypted with
`sync.encrypt`); otherwise, or when the bucket is unreachable, to
`<library>/diagnostics/` (0600). Nothing is sent automatically.

## Updates

This build has no self-updater. A new installer upgrades in place and keeps the
configuration (MSI major upgrade, `installer -pkg` over the installed pkg,
`dpkg -i`). Every Kortix release carries `capture-update.json` (version,
channel and per-OS installer URL, SHA-256 and size; Ed25519 signature in
`capture-update.json.sig` once the signing key exists). The release runbook
(`release-runbook.md`) lists the URLs the updater will poll.

## Privacy

- Everything stays on the machine unless cloud sync is on (see "Cloud
  sync"). The other network calls are the favicon fetch
  (`icons.duckduckgo.com`) and, with
  "Sign in with Kortix", the credential issuer. `airgap: true` disables all of them.
- Exclusion groups ship for password managers (on by default), messaging apps
  (includes notification banners and WeChat), and banking and finance.
  Turn a group on with `enabled_exclusion_groups`.
- The banking group is a data file (`src/memory/data/banking_domains.txt`, about
  900 domains from public knowledge across the US, Canada, UK, EU, India, Latin
  America, the Middle East, Africa and Asia-Pacific, plus
  `banking_bundle_ids.txt`). A domain entry matches that domain and every
  subdomain, case-insensitively (`chase.com` covers `secure.chase.com`;
  `notchase.com` stays visible). It is best-effort: add missing banks under
  `excluded_domains`.
- The login window, screen saver and lock screen never record, on every
  platform: macOS skips a locked session and always excludes
  `com.apple.loginwindow` and the screen saver; Windows always excludes
  `logonui.exe` and `lockapp.exe`.
- `kortix-capture now` reduces URLs to their origin and marks screen text as
  data, not instructions.
- `kortix-capture ask --agent kortix` sends the `now` bundle to a Kortix cloud
  session; the local-agent routes send only the prompt.

## Audio memory

Audio memory records the microphone and what the computer plays, around the
clock, on the same timeline as the screen. It is **off by default**: a library
that never turned it on has no `audio/` directory, no `audio.json`, no `audio`
rows, and no audio process runs.

Turn it on in the settings window (Audio, "Audio recording"), from the tray
("Audio Recording"), or with the CLI:

```bash
kortix-capture settings audio.enabled true     # starts within one recorder tick
kortix-capture settings audio.enabled false    # stops in under 0.3 s and closes the open segment
kortix-capture audio devices                   # input devices; * marks the one in use
kortix-capture settings audio.input_device "<id>"   # "" follows the system default
kortix-capture settings audio.transcribe true  # on-device transcription into search
kortix-capture audio list --tr "today"         # segments and what was said
kortix-capture permissions --request --microphone   # macOS Microphone prompt
kortix-capture permissions --request --only input_monitoring   # one named prompt (the action recorder's listener)
```

**Consent.** Audio memory records everything this computer hears and plays,
including other people on calls. Some places require everyone's consent before
a conversation is recorded. The settings window shows this next to the toggle.

| Key | Default | Meaning |
|---|---|---|
| `audio.enabled` | false | Record audio while screen recording is on and not paused |
| `audio.microphone` | true | Record the input device (your voice, the room) |
| `audio.system_audio` | true | Record what the computer plays (calls, videos, music) |
| `audio.input_device` | `""` | Input device id from `audio devices`; empty follows the system default |
| `audio.transcribe` | false | Transcribe on this device into search (macOS) |

`audio.enabled` with both sources off is refused, in the window and the CLI.

### Lifecycle

Audio follows the screen recorder: it stops while recording is off or paused
(tray "Pause", `kortix-capture pause`), while the screen is locked, below
`storage.min_free_gb`, and during a sync backlog. It keeps recording while there
is no keyboard or mouse input (a call you only listen to) and while an excluded
app is in front (on macOS that app's audio is left out; see below). Sleep stops
the sources with the process; on wake the next block starts a new segment, so a
gap never turns into silence.

Each source is its own engine process (`kortix-capture-engine audio --source
microphone|system`) that writes 16 kHz mono PCM to the recorder. A source that
exits restarts on its own: at once when the default device changed (headphones
plugged in, a new default microphone), every 30 s while a permission is
missing, else with backoff from 2 s to 60 s. The status of every source is in
`audio.json`, `kortix-capture status`, the settings window and the tray.

### Capture per OS

| | macOS | Windows | Linux |
|---|---|---|---|
| Microphone | AVCaptureSession (`audio.input_device` = device unique id) | WASAPI through cpal (device name) | PulseAudio/PipeWire `parec`, default source |
| System audio | ScreenCaptureKit audio, this process excluded; excluded apps' audio filtered out (apps that start later join the filter within 5 s) | WASAPI loopback of the default output (whole mix) | `parec` on `@DEFAULT_MONITOR@` (whole mix) |
| Default device change | exit 3, restart | exit 3, restart | exit 3, restart (`pactl` default source/sink) |
| Encoder | AudioToolbox AAC-LC, 32 kbps | Media Foundation AAC-LC, 96 kbps (the encoder's lowest rate; 44.1/48 kHz input only) | `ffmpeg` AAC-LC, 32 kbps |
| Transcription | On device: SpeechAnalyzer (macOS 26, no permission; the language model downloads once, never in airgap mode), SFSpeechRecognizer on-device (macOS 14-15, needs Speech Recognition) | Not available | Not available |
| Permission | Microphone (TCC). Never prompted until audio is turned on or `permissions --request --microphone` | Settings, Privacy, Microphone, "Let desktop apps access your microphone" | None |

macOS shows its orange microphone indicator in the menu bar while the
microphone source runs; the tray's audio row reads "Audio: ● Recording …".

### Storage

Segments are one wall-clock minute (shorter at a start, a stop or a gap) of
mono AAC-LC in M4A, `audio/<start_ms>.m4a`, with an `audio` row (`start_ms`,
`end_ms`, `sources`, `status`, transcript and sync columns). Measured on macOS
(AAC-LC 32 kbps, 16 kHz, mono): 12.75 MB per hour on the speech-and-tone test
audio (28.3 kbit/s including the container); continuous speech or room noise
stays under 14.7 MB per hour (32 kbit/s plus about 4 KB of container per
minute), about 350 MB per 24-hour day. Windows writes about 43 MB per hour
(96 kbps). Raw PCM staging is 1.9 MB per minute and lives only until the
segment is encoded (about 1 s).

- `storage usage` and the settings window count audio (`audio_bytes`) toward
  the library size and `storage.limit_gb`.
- The storage cap removes the oldest media first, video or audio. Audio cannot
  be shrunk, so "downscale" shrinks video and removes audio. Retention mode
  removes audio older than `storage.retention_days` whatever the action.
  Transcripts stay searchable after their audio is removed.
- `storage forget --tr <range>` deletes the audio segments, their transcripts
  and their cloud copies in the range, like chunks.
- "Keep on this Mac" (`sync.keep_local_hours`) applies to audio: after a
  verified upload the local file goes and playback downloads it into
  `cache/audio/` (inside `sync.cache_mb`).

### Timeline and search

The timeline draws a quiet line under the runs wherever audio exists. Play
(Space) moves the playhead in real time and plays the audio under it; scrubbing
while playing seeks the audio; Mute (M) silences it and is remembered. Remote
segments stream from the cloud on first play.

With `audio.transcribe` on, each new segment is transcribed on the device after
it is encoded. Spoken words land in `audio_transcript` and `audio_fts`, and
search shows them next to screen text as "Heard" results (marked
`source: "audio"` in `/api/search` and in `kortix-capture query fts --json`);
opening one plays from where the words were said. An app or website filter
leaves spoken words out (audio has no app). Transcription applies to segments
recorded after it was turned on.

### Privacy

- With `privacy.redact_pii` on, transcript lines pass through the same masking
  as screen text (patterns, plus the local model when `privacy.use_local_model`
  is on) before they are written. A required model that is unavailable fails
  the segment's transcript closed (no text). The audio itself is not masked.
- Excluded apps (password managers and every exclusion group) have their audio
  left out of system audio on macOS. Windows and Linux record the whole mix.
- Playing audio back in the timeline while system audio records can record it
  again.
- `airgap: true` keeps transcription offline: a missing language model fails
  the transcript instead of downloading.

### Sync

Audio segments are their own sync units on the same timeline: audio keeps
recording while the screen is idle, when no video chunk exists to carry it.
Under `<prefix>/<device_id>/<YYYY>/<MM>/<DD>/`, per segment:

| Object | Content |
|---|---|
| `<start_ms>-a<id>.m4a` | The segment (multipart above `sync.part_mb`, resumable, encrypted with `sync.encrypt`) |
| `<start_ms>-a<id>.manifest.json` | `kind: "audio"`, times, sources, codec, the SHA-256 and size of the audio, and the transcript lines. Written last |

The daily index gets a `put` line with `kind: "audio"`. A segment uploads after
its transcript is done, so the manifest carries it. `sync restore` brings back
the rows and transcripts; the audio streams on demand with its SHA-256 checked.
Tombstones, `sync.remote_retention_days` and `storage forget` cover audio.

With "Sign in with Kortix" the segment goes to the issuer's bucket the same way;
a reader (Kortix) indexes the transcript lines from the manifest.

### Verify without a microphone

`KORTIX_CAPTURE_AUDIO_TEST_WAV=<file.wav>` (test harnesses only) replaces every
source with the engine's file source: it plays the file once, in real time,
through the same pipe, mixer, encoder, store, transcription and sync, and never
opens the microphone or asks for a permission.

## Settings

`kortix-capture settings` prints every setting; `settings <key>` reads one and
`settings <key> <value>` writes it (nested keys use dots: `storage.reserve_mb`).
The recorder hot-reloads `settings.json`. The timeline settings API
(`GET`/`POST /api/settings`) exposes the same keys.

| Key | Default | Meaning |
|---|---|---|
| `interval_ms` | 2000 | Fixed capture tick |
| `capture_on_change` | true | Extra capture on app, window title or URL change (max 1 per second) |
| `resolution` (preset) | `1440p` | `720p` 1280x720, `1080p` 1920x1080, `1440p` 2560x1440, `4k` 3840x2160. Sets `max_width` and `max_height`; reads `custom` when they match no preset |
| `max_width`, `max_height` | 2560, 1440 | Still size box; a still is scaled to fit and never enlarged. Custom values keep working |
| `storage.archived_scale` | 0.75 | Scale for downscaled archived video (was 0.5). A library that saved the old default moves to 0.75 once |
| `storage.reserve_mb` | 500 | Disk reserve size, 0 = off |
| `storage.min_free_gb` | 5 | Recording stops below this much free disk |

The settings API takes `{"resolution": "1080p"}` in `POST /api/settings`; an
explicit `max_width`/`max_height` in the same request wins. `GET` returns
`resolution` and `resolution_presets`.

### Settings window

The timeline's Settings panel (`ui/memory/`, served by `src/memory/ui/api.rs`)
has a control for every key above and in "Cloud sync" and "Audio memory",
grouped as Recording, Audio, Capture, Privacy, Storage, Cloud sync, Shortcuts and Agents
(`agent_routing.agent`, `agent_routing.terminal`). `POST /api/settings` merges
objects at every depth and checks the result with `Settings::validate`, the
same check `kortix-capture settings <key> <value>` and `sync setup` run, so the
window and the CLI accept exactly the same values. A refused value answers 400
with the reason, and the window shows it.

Cloud sync in the window calls the functions behind the CLI (`cli::sync_*`,
`cli::storage_forget`):

| Route | CLI |
|---|---|
| `GET /api/sync` | `sync status --json` (with the Kortix sign-in and the policy in force), saved-credential presence, and which layers record now (`layers`); never the S3 secret, session token or device token |
| `POST /api/sync/setup` | `sync setup` (`{"provider": "s3", endpoint, bucket, region, prefix, path_style, access_key_id, secret_access_key?, session_token?}`); a blank secret keeps the saved one. `{"provider": "kortix", issuer?}` runs the sign-in like `/api/kortix/connect` |
| `POST /api/sync/test` | `sync test`; with S3 form fields it probes them unsaved |
| `POST /api/sync/on`, `/off` | `sync on`, `sync off` (Pause and Off are one state: `sync.enabled = false`) |
| `POST /api/sync/now` | `sync now`, as a background job |
| `POST /api/sync/devices` | `sync devices` |
| `POST /api/sync/restore` | `sync restore [--device] [--from]`, as a background job with progress |
| `POST /api/sync/encrypt` | `settings sync.encrypt true\|false`, and makes the key at once |
| `POST /api/sync/key/export`, `/key/import` | `sync key export`, `sync key import` |
| `POST /api/storage/forget` | `storage forget --tr <range> [--yes]` (the window previews first and asks twice) |
| `POST /api/kortix/connect` | `sync setup --provider kortix [--issuer]`: the device grant as a background job; the window shows the code and the approval link, then Kortix sync is on |
| `POST /api/kortix/disconnect` | `sync sign-out`: forgets the token and the registration, turns Kortix sync off |
| `GET /api/audio?from=&to=`, `GET /media/audio/<id>` | audio segments on the timeline and their bytes (byte ranges; remote-only ones download first) |
| `GET /api/audio/devices`, `POST /api/audio/permission` | `audio devices` with the Microphone permission state; the Microphone prompt, when the person clicks "Allow microphone" |

Jobs (`now`, `restore`, `connect`) report in `GET /api/sync` under `jobs`; the
window polls every 3 s while the panel is open. The Recording section shows
what records now and the operator's notice; Cloud sync offers "Sync to: Off,
Kortix, Your own S3 bucket".

### Jump to a day

The timeline's date chip opens "Jump to": an exact date and time, and one row
per recorded day in the last 365 days (newest first; Today, Yesterday, then the
date) with its recorded time. A click or Enter jumps to that day's last frame.
`GET /api/days` returns `{date, first_ms, last_ms, frames, recorded_ms}` from one
query over `frame` grouped by this machine's local day (DST included).
Remote-only days keep their frame rows, so they stay listed.

## Commands

| Command | Purpose |
|---|---|
| `list`, `usage`, `query`, `now`, `link`, `grab-screen`, `install-skill` | Read surface for people and agents |
| `record [--duration S]` | Run the recorder (the tray supervises it) |
| `status`, `permissions [--request [--microphone]]` | Recorder and audio state, macOS permissions (Microphone included) |
| `audio devices`, `audio list [--tr]` | Audio memory: input devices, recorded segments and transcripts |
| `pause [--for 1h\|forever]`, `resume`, `settings [key [value]]` | Control |
| `settings resolution [720p\|1080p\|1440p\|4k]` | Read or set the still size preset (see "Settings") |
| `storage usage\|preview\|enforce` | Storage policy |
| `storage forget --tr <range> [--yes]` | Delete a time range locally and in the cloud |
| `sync setup\|test\|status\|on\|off\|now\|devices\|restore\|key\|sign-out` | Cloud sync (see "Cloud sync" and "Sign in with Kortix") |
| `sync enroll [--issuer] [--principal] [--account-name]` (token on stdin) | Enroll with an organization's enrollment token (see "Organization rollout") |
| `machine run\|status\|configure` | The machine service the MSI, pkg or deb installs, and its state; `configure --url … [--token …]` writes the root-only config file (macOS, Linux) |
| `agent` (hidden) | macOS and Linux: what the global launchd agent / systemd user unit runs; `service run --managed` once a configuration exists |
| `ui [--search] [--at T]`, `open <kortix-capture://…>` | Timeline and search window |
| `ask "<prompt>" [--agent claude\|codex\|cursor\|kortix]` | Open an agent in a terminal with the prompt |

## Measurements (M4 Max, macOS 26.2)

| Metric | Value |
|---|---|
| Capture cadence, 10 min soak | 300 frames in 598 s (2.0 s), 0 warnings |
| CPU, 5 min of active use | 41.3 s (13.6% of one core, all processes) |
| Peak RSS (largest process) | 320 MB |
| Storage | 18.6 KB per frame in a mixed session; downscale shrinks a chunk 4.7x |
| Capture (SCK still + metadata), steady state | 150–450 ms |
| OCR per frame, 10 min soak | incremental 325 ms (57%), unchanged 26 ms (8%), full 755 ms (35%) |
| Incremental OCR quality | word recall 93.6–97.8% vs a full pass; the difference is OCR noise, not dropped text |
| Agent round trip | headless Claude Code with the skill answered a history question in 3 turns ($0.20), with links |

## Verification

```bash
cd backend
cargo test --lib memory
cargo build --release --bin kortix-capture --bin kortix-tray --features native-recorders,tray-ui
export KORTIX_CAPTURE_DIR=$(mktemp -d)
./target/release/kortix-capture record --duration 60
./target/release/kortix-capture status
./target/release/kortix-capture query fts "<a word you had on screen>"
```

## Windows and Linux engine (`src/capture_engine/`)

Build: `cargo build --release --features capture-engine --bin kortix-capture-engine`
(`native-recorders` enables it). macOS ignores this binary; `build.rs` builds the
Swift engine and `engine::locate()` prefers it there.

`bundle_id`: Windows = AppUserModelID for packaged apps, else lowercase exe name
(`chrome.exe`). Linux = lowercase `WM_CLASS` class. Exclusion lists match
case-insensitively; the built-in groups carry Windows and Linux ids.

| | Windows | Linux (X11) |
|---|---|---|
| Screen | GDI `BitBlt` of the monitor with the focused window (per-monitor DPI aware) | X11 `GetImage` of the RandR monitor with the focused window |
| Excluded apps | Frame skipped when one is focused. Other excluded windows are painted black from the z-ordered window list (rectangular approximation, no rounded corners or transparency) | Same |
| URL | UI Automation address bar of Chrome, Edge, Brave, Vivaldi, Opera, Firefox and others | None (needs AT-SPI) |
| AX tree | UI Automation control view | None |
| Private windows | Title markers (InPrivate, Incognito, Private Browsing) | Same |
| Idle / lock | `GetLastInputInfo`; lock = input desktop not openable | XScreenSaver idle; lock = screensaver active |
| OCR | `Windows.Media.Ocr`. Needs an OCR language pack. No confidence (reports 1.0). Words are grouped into line boxes split at column gaps | `tesseract` CLI (`apt install tesseract-ocr`) |
| Video | Media Foundation H.264 (NV12 in, MP4 out) | `ffmpeg` CLI, libx264 |
| Icons | `IShellItemImageFactory` (exe path or AppsFolder AUMID) | `.desktop` entry + hicolor PNG (SVG-only themes give `app_not_found`) |

Wayland: unsupported. `capture` answers `skipped: "wayland_unsupported"`. Portal
ScreenCast needs a per-session consent dialog and PipeWire. XWayland roots are
black, so the engine does not fall back to X11 there.

## One app: screen memory + action recorder (merge plan)

Kortix Capture merges two recorders that share no capture code:

- **Action recorder** (`src/recorders/`, `recording_service.rs`, `processor.rs`):
  keyboard, mouse and scroll events folded into actions (`click`, `hotkey`,
  `typewrite`, `scroll`, `drag`) with before/after screenshots of every
  display; crash recovery, a headless service. Its
  segments are library items since format schema 2 (see "Action recording").
- **Screen memory** (`src/memory/`, `src/capture_engine/`, `native/macos/`): a
  frame of the active display every 2 s with on-screen text, app, window, URL
  and AX tree; 1 fps video; search; timeline window.

### Measured side by side (macOS, two displays, 10 min, 2026-10-02)

| | Action recorder | Screen memory |
|---|---|---|
| Frames | 426 (each holds every display), median gap 1.0 s | 313 (active display), median gap 2.0 s |
| Disk | 248 MB (base64 JPEG in JSONL, ~1.4 GB/h) | 3.6 MB video + SQLite |
| CPU | 28.4% of one core | 21.0% of one core (incl. OCR) |
| Peak RSS | 1,022 MB | 848 MB |

Screen APIs of the action recorder (`screenshots` 0.8.10): macOS
`CGWindowListCreateImage` (legacy; macOS 15+ re-asks for screen recording
consent), Windows GDI `StretchBlt` (CPU scaling), Linux X11 `GetImage` and the
Wayland portal.

### Stages

1. **One tray (done).** The full tray hosts both. Actions record 60 s segments
   into the library under `actions.local_cap_gb` (default 2) and sync with it.
   Start never forces a sign-in. The recorder runs `--supervised`: it stops when
   the tray dies. Actions default off unless sync is on, until stage 2 lands.
2. **One screen source.** The engine keeps a continuous stream per display
   (macOS `SCStream`, Windows DXGI Desktop Duplication, Linux X11/XShm and the
   Wayland portal) in a short in-memory ring. Screen memory takes the active
   display every 2 s; the action recorder encodes only the frames around each
   input event. Action frames go to files/video instead of base64 JSONL.
   Exclusions (password managers, private windows) apply to both. Then actions
   default on.
3. **One uploader (done).** Screen chunks, audio and action segments go through
   the library's one sync engine (checksums, resumable multipart, encryption,
   offload, retention, restore) into the Kortix Capture format, schema 2. The
   old control plane and its Supabase uploads are gone from the app.
4. **Open-source hygiene.** Embedded credentials and hardcoded hosts are gone
   (done); rename the headless package, add a license.

Typed text (`typewrite`) is stored as typed. Before stage 2 defaults actions
on, password fields must be dropped (macOS secure input, Windows UIA
`IsPassword`).
