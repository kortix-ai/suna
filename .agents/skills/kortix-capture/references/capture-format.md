# Kortix Capture format, schema 2

The desktop app's only contract with any cloud. The app writes this layout to an
S3-compatible bucket; anything that can read S3 can index, process and show it.
Kortix is one reader. A customer's own tooling is another. Schema 1 (screen and
audio only) stays readable; schema 2 adds actions, status, policy and the
credential protocol.

Machine-readable contract: JSON Schemas (draft 2020-12) for every JSON object
and JSONL line below are in `apps/capture/schemas/`; a synthetic bucket that
passes them is in `apps/capture/fixtures/capture-format-v2/`
(`cargo test --test capture_format` checks both). Readers vendor them by commit.

## Bucket layout

`<prefix>` is chosen by whoever issues the credentials. Kortix uses
`orgs/<org_id>/projects/<project_id>`. A self-managed bucket uses any prefix
(default `kortix-capture`).

```
<prefix>/policy.json                                  written by the operator; read by every device
<prefix>/<device_id>/device.json                      written by the device on start and on change
<prefix>/<device_id>/status.json                      written by the device every 60 s
<prefix>/<device_id>/index/<YYYY-MM-DD>.jsonl         one line per finished or deleted item of that UTC day
<prefix>/<device_id>/assets/<name>                    content-addressed: icons, action screenshots
<prefix>/<device_id>/diagnostics/<YYYYMMDDTHHMMSSZ>.tar.zst   redacted diagnostics, on request only
<prefix>/<device_id>/<YYYY>/<MM>/<DD>/<start_ms>-<id>.{mp4,frames.jsonl.zst,manifest.json}      screen chunk
<prefix>/<device_id>/<YYYY>/<MM>/<DD>/<start_ms>-a<id>.{m4a,manifest.json}                      audio segment
<prefix>/<device_id>/<YYYY>/<MM>/<DD>/<start_ms>-x<id>.{actions.jsonl.zst,manifest.json}        action segment
```

- Day folders and index days are UTC.
- `<device_id>` is the device's stable id (below). It never contains `/`.
- The manifest is written LAST. A reader treats an item as complete only when its
  manifest exists and every object it lists has the listed size and SHA-256.
- Assets are named `sha256-<hex>.<ext>` (`<hex>` = SHA-256 of the plaintext) and
  are written before any manifest that references them. Identical screenshots
  are stored once per device. Schema 1 named icons `<hex>.<ext>`; readers accept both.
- Every PUT carries `x-amz-checksum-sha256`; the device reads every object back
  by HEAD for its size before it writes the manifest.
- Deletion (the person forgets a time range, or remote retention) removes the
  item's objects and the screenshots no remaining action segment references, and
  appends a `delete` line to the index. Icons and index files stay.

## Index lines

`index/<day>.jsonl` holds one JSON object per line, appended in order:

```json
{"op": "put", "kind": "chunk|audio|actions", "base": "<device_id>/<YYYY>/<MM>/<DD>/<start_ms>-<id>",
 "start_ms": 0, "end_ms": 0, "manifest": true, "at_ms": 0}
{"op": "delete", "kind": "chunk|audio|actions", "base": "…", "reason": "forget|retention|forgotten", "at_ms": 0}
```

`kind` is absent on schema 1 lines (they mean `chunk`). Kind-specific counts ride
along (`frames`, `transcript_lines`, `events`, and `video_id`, `audio_id`,
`segment_id`). A reader folds the lines: the latest `put` of a `base` is live
until a `delete` of it. A line with `"manifest": false` names a chunk uploaded
before manifests existed (its sidecar is complete on its own).

## Manifests

Every manifest is JSON (encrypted like the other objects when encryption is on):

```json
{
  "schema": 2,
  "kind": "chunk | audio | actions",
  "device_id": "…",
  "start_ms": 0, "end_ms": 0,
  "app_version": "…",
  "created_at_ms": 0,
  "encryption": null | {"alg": "AES-256-GCM/STREAM-BE32/1MiB", "key_id": "…"},
  "privacy": {"redact_pii": false, "mode": "off | patterns | model"},
  "objects": {"<role>": {"key": "…", "size": 0, "sha256": "…", "plain_size": 0, "plain_sha256": "…"}}
}
```

- `objects.<role>.key` is relative to `<prefix>`. `size` and `sha256` describe
  the stored bytes (ciphertext when encrypted); `plain_size` and `plain_sha256`
  the plaintext.
- `privacy.redact_pii`: local PII masking applied to this item at capture time;
  `mode` says how (`patterns`, or `model` = patterns plus the local model).
- `chunk`: `objects.video` (MP4, 1 fps, frame *i* at *t* = *i* s),
  `objects.frames` (zstd JSONL, one line per frame, below). Extra fields:
  `video_id`, `frame_count`, `width`, `height`, `video_name`, and `display`
  (`id`, `name`, `x`, `y`, `w`, `h`, `scale`, `main`): the one display the chunk
  recorded. See [Displays and coverage](#displays-and-coverage). A chunk
  without `display` was written before multi-display: one unnamed display.
- `audio`: `objects.audio` (AAC-LC in M4A, mono). Extra: `audio_id`,
  `duration_ms`, `sources` (`microphone`, `system`, `file`), `content_type`,
  `codec`, `sample_rate`, `channels`, `audio_name`, `pii_redacted`, and
  `transcript` (`[{"start_ms", "end_ms", "text"}]`, empty when not transcribed).
- `actions`: `objects.actions` (zstd JSONL, one line per processed action
  event, below). Extra: `segment_id`, `event_count`, `screenshots` (asset names).
- Unknown fields are ignored. A reader rejects `schema` greater than it knows.

### Frame lines (`.frames.jsonl.zst`)

`frame_index`, `ts_ms`, `width`, `height`, `title`, `url`, `domain`,
`app` (`bundle_id`, `name`, `version`, `is_user_app`, `icon` = asset name or
null), `domain_icon`, `display` (`x`, `y`, `w`, `h`, and since multi-display
`id`, `name`, `main`, `focused` = this display held the focused window), `capture_reason`
(`initial`, `fixed_interval`, `app_switch`, `url_change`, `window_change`, `keepalive`),
`dhash`, `image_hash`, `segment` (frames that share it are one visit),
`inactive`, `pii_redacted`, `ocr` (`foreground`, `background`, `lines`:
`[{"text", "x", "y", "w", "h", "off", "len"}]`, offsets into
`foreground || background`), `windows` (`[{"app", "app_name", "title", "x",
"y", "w", "h", "z", "layer", "focused", "url"}]`), and when recorded `ax_tree`,
`ax_partial`, `ax_nodes`. With `pii_redacted`, app names read `[redacted]`.

### Action lines (`.actions.jsonl.zst`)

```json
{"ts_ms": 0, "start_ms": 0, "kind": "click|drag|scroll|press|hotkey|typewrite|sleep|screenshot",
 "command": "click(x=0.5000, y=0.5000, clicks=1, button='left')", "args": {…},
 "app": null | {"bundle_id": "…", "name": "…"}, "window": null | "…",
 "target": null | {"role": "…", "name": "…", "bbox": [x0, y0, x1, y1]},
 "screenshot": null | "sha256-<hex>.jpg",
 "displays": [{"display_id": 1, …, "screenshot": "sha256-<hex>.jpg"}]}
```

- `ts_ms` is when the action ended, `start_ms` when it began (epoch ms).
- `args` are the action's parameters (`x`, `y` as a fraction of the display,
  `button`, `clicks`, `keys`, `text`, …); images never appear in it.
- `app` and `window` come from the screen layer's frame up to 5 s before the
  event, else the window title from the action recorder's accessibility
  snapshot; `target` is the accessibility element under a click or drag. Each is
  null when the device did not capture it.
- `screenshot` lines carry the frame the person saw; `displays` holds one
  screenshot per display when several were captured.
- While local PII masking is on, typed characters read `[redacted]` and
  screenshots are black, and action segments do not upload.

## Displays and coverage

- **Every display, every tick.** The recorder captures every connected display
  each tick (2 s by default), the display holding the focused window first; its
  OCR runs first too. Each display writes its own chunks: a chunk, its video and
  its frame lines belong to one display, named in the manifest's `display`.
- **Change detection.** A display whose picture did not change since its last
  frame (equal hash of a 256-pixel-wide grayscale copy) writes no frame and
  costs no JPEG encode or OCR.
- **Coverage.** A display unchanged for 30 s writes a keep-alive frame
  (`capture_reason: "keepalive"`). Frame timestamps alone therefore cover what
  was on screen: a reader treats a display as recorded from a frame until the
  display's next frame, for at most 30 s plus one tick. A longer gap is a real
  gap (locked, asleep, screensaver, paused, excluded, or not recording).
- **Idleness.** No keyboard or mouse input never stops capture: reading or
  watching records too. Frames taken `inactivity_seconds` (5 s) after the last
  input are marked `inactive`. Only the lock screen, sleep, the screensaver,
  the person's pause and the organization's pause stop capture.
- **Exclusions are per window.** Excluded apps, private browser windows and
  excluded websites are hidden window by window on every display (on Windows
  and Linux painted black); their titles and URLs never reach a frame line. A
  display such a window covers in full writes no frame. On Windows and Linux a
  browser window's URL is known only while it is focused.
- **Text.** The display holding the focused window has its text read on every
  frame. Another display's text is read at most every 10 s, and a display whose
  last read found 60% or more of it changed (scrolling, a playing video) at most
  every 4 s. Frames in between carry the last text read. Every frame is written
  either way. Only an app switch or a new URL pulls a capture before the tick; a
  title alone (a spinner, a playing video) waits for it (`window_change` appears
  in older items only).
- **Kortix itself is never recorded.** Every `com.kortix.*` and `ai.kortix.*`
  app, and the app the service runs in (its bundle id and executable name), is
  hidden like an excluded app: screen, actions and system audio.
- **Item length.** A chunk covers at most 30 s of a display's recording, so a
  frame reaches the bucket within about 30 s, plus OCR, encode and the 5 s sync tick.

## device.json

```json
{"schema": 2, "device_id": "…", "machine_key_sha256": "…", "hostname": "…",
 "computer_name": "…", "os": "macos|windows|linux", "os_version": "…",
 "arch": "…", "app_version": "…", "member": {"email": "…"} | null,
 "encryption": null | {"alg": "…", "key_id": "…"},
 "first_chunk_ms": 0 | null, "last_chunk_ms": 0 | null, "updated_at_ms": 0,
 "displays": [{"id": 1, "name": "…", "x": 0, "y": 0, "w": 0, "h": 0, "scale": 2, "main": true}]}
```

`displays` lists every connected display at the last capture, the focused one first.

`device_id` is 32 hex characters of SHA-256(`kortix-capture/device/v2\n`,
machine key, `\n`, prefix): one machine keeps one id under one prefix, and a
different prefix gives a different id. With credentials from an issuer the device
uses the `device_id` the issuer returns (it scopes the credentials). The machine
key is a one-way hash of the OS machine id (macOS `IOPlatformUUID`, Windows
`MachineGuid`, Linux `/etc/machine-id`; a random key kept in the library on a
machine without one); `machine_key_sha256` is that key hashed once more, so
neither the OS id nor the key leaves the machine. With encryption or local PII
masking on, `hostname` and `computer_name` are null. `member` names the person
the issuer signed in, else null. device.json is plaintext JSON even when
encryption is on, and is rewritten when it changes and at least hourly.

## status.json

The live status: `recording` (`recording|paused|permission_missing|not_recording`),
`reason`, `missingPermissions`, `pausedUntilMs`, `audio` (`enabled`, `state`),
`sync` (`state`: `ok|queued|error|off`, `pending`, `errorClass`, `lastUploadMs`),
`lastFrameMs`, `displays` (`[{"id", "name", "main", "focused", "lastFrameMs"}]`,
every connected display, the focused one first), `appVersion`, `actionsRecording`,
`capture` (`intervalMs`, `maxHeight`: the rate and size in force),
`policy` (null, or the policy in force: `source`, `updatedAtMs`, `fetchedAtMs`),
`host` (`awakeSinceMs`: when the computer last woke from sleep, or the app started),
plus `reportedAtMs`. status.json goes out every 15 s. A reader
shows a device as offline when `reportedAtMs` is older than 120 s. After the
policy in force changes, the device writes status.json about 15 s later (once its
recorders followed the change), so a policy change shows within ~80 s. status.json is
plaintext JSON even when encryption is on; it holds no recorded content.

## policy.json

Written only by the operator, plaintext JSON. The device reads
`<prefix>/policy.json`, the account policy, at start and every 60 s, and
applies it within one poll. It never reads a policy from its own folder: the
device can write there, and a file it wrote must not lift the account's
exclusions or pause. A device never widens what the policy allows.

```json
{"schema": 2, "layers": {"screen": true, "actions": true, "audio": false},
 "privacy": {"redact_pii": false}, "retention": {"local_hours": 0, "remote_days": 0},
 "recording": {"paused": false, "paused_until_ms": null, "interval_ms": 1000, "max_height": 1440},
 "notice": "Text the device shows the person being recorded", "updated_at_ms": 0}
```

- `layers`: `false` turns that layer off even when the person turned it on; an
  absent layer is allowed. A layer the policy allows still needs the person's
  own switch. Turning a layer off stops its capture; items captured before still
  upload.
- `privacy.redact_pii: true` turns local PII masking on.
- `retention`: 0 means no limit. `local_hours` caps how long local media stays
  after its verified upload (`sync.keep_local_hours`); `remote_days` caps how long
  items stay in the bucket (`sync.remote_retention_days`).
- `recording.paused` pauses every layer, until `paused_until_ms` or, when null,
  until the operator lifts it.
- `recording.interval_ms` (500..10000, clamped) and `recording.max_height`
  (720, 1080, 1440 or 2160; the width follows: 1280, 1920, 2560, 3840) set the
  screen capture rate and size on every device, higher or lower than the
  device's own value. Absent or null keeps the device's own setting.
  `status.json` `capture` reports the values in force.
- `notice` is shown in the tray menu and the settings window. The person on the
  device always sees that recording is on and which layers run.
- The policy applies while the device syncs to the bucket. Without a reachable
  bucket the last policy read stays in force; when both files are absent there is
  no policy. A policy with a `schema` newer than the device knows is ignored and
  the last policy stays in force.

## Credentials

The device needs S3 credentials for `<prefix>/<device_id>/` (read, write,
delete, multipart, and list under that prefix, so a missing object answers 404
rather than 403) and `<prefix>/policy.json` (read). A store that refuses a
policy read keeps the device's last policy in force. Two providers:

1. **Static**: endpoint, bucket, region, prefix, access key, secret (and optional
   session token), set by the user. Any S3-compatible store.
2. **Credential endpoint**: `POST <issuer>/v1/capture/credentials` with
   `Authorization: Bearer <device_token>` and body
   `{"device_id": "…", "app_version": "…"}` returns
   `{"endpoint","bucket","region","prefix","device_id","access_key_id","secret_access_key","session_token","expires_at_ms"}`
   and optionally `"path_style": true` (path-style URLs, most self-hosted S3).
   The device refreshes 5 minutes before `expires_at_ms`, and after the store
   refuses the credentials (403). The credentials are scoped by the issuer to the
   device's prefix. A 401/403 from the issuer stops sync, makes no further
   requests, and asks the user to sign in again.

The device token comes from an OAuth 2.0 device authorization grant (RFC 8628)
against `<issuer>`. Every request and response body is JSON.

1. `POST <issuer>/v1/capture/device/authorize` with
   `{"client_id": "kortix-capture", "device": {"device_id", "machine_key_sha256",
   "hostname", "computer_name", "os", "os_version", "arch", "app_version"}}` →
   `{device_code, user_code, verification_uri, verification_uri_complete, interval, expires_in}`.
   `device.device_id` is the id derived for an empty prefix; the issuer may
   return it unchanged in step 3.
2. The device opens `verification_uri_complete` in the browser and shows
   `user_code`; the person approves.
3. The device polls `POST <issuer>/v1/capture/device/token` with
   `{"grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": "…", "client_id": "kortix-capture"}`
   every `interval` seconds (default 5). Until approval the issuer answers HTTP
   400 `{"error": "authorization_pending"}`, or `{"error": "slow_down"}` (the
   device adds 5 s to its interval). `access_denied` and `expired_token` end the
   sign-in. On approval: `{"device_token", "prefix", "device_id", "member": {"email"} | null}`.

Instead of the grant, a computer an organization rolled out enrolls with the
organization's enrollment token (no person approves):

`POST <issuer>/v1/capture/device/enroll` with
`{"enrollment_token": "…", "machine_key_sha256": "…", "user": {"principal_name": "…" | null, "account_name": "…"},
"device": {"hostname", "computer_name", "os", "os_version", "arch", "app_version"}}`.
`user` is the person signed in to the computer (on Windows read from the
session token by the machine service). Answers:

- 200 `{"status": "enrolled", "device_token", "token_type": "Bearer", "prefix", "device_id", "account": {"name"}, "member": {"email"}}`:
  the same token as a sign-in;
- 200 with `"member": null` when no Kortix member matches the person yet: the
  device records into the account unlinked until an admin links it to a user;
- 202 `{"status": "pending", "reason": "approval_required", "enrollment_id", "retry_after_s"}`
  (the token needs a per-computer approval, or an admin revoked this device):
  nothing records; the device asks again after `retry_after_s` (at least 10 s);
- 401 `{"code": "enrollment_token_invalid"}`, 403 `{"code": "capture_disabled" | "enrollment_limit_reached"}`,
  400 `invalid_request`: again after 1 h; 403 `{"code": "enrollment_denied" | "enrollment_domain_not_allowed"}`: after 6 h;
- 429 and 5xx: again after 1 min.

Asking again is idempotent and is the poll; an enrolled device that asks again
gets a new token (the old one stops working) and the same `device_id`.

The device keeps the token in the OS secret store (macOS Keychain, Windows
Credential Manager, Linux Secret Service; a mode-0600 file where none is
available) and never writes it to settings or logs. Kortix is one issuer; the
protocol is generic.

## Encryption

With client-side encryption on (`sync.encrypt`, self-managed buckets only), every
object except `device.json`, `status.json` and the operator's `policy.json` is
stored as `KCE1` ciphertext: AES-256-GCM in 1 MiB segments (STREAM, big-endian
32-bit counter), the header `KCE1` | key id (8 bytes) | nonce prefix (7 bytes).
The key never leaves the device unless the person exports it.

## Readers

A reader learns about new items from S3 event notifications on `*.manifest.json`
when the store supports them, else by reading `index/<day>.jsonl` files. Readers
must be idempotent per manifest key.
