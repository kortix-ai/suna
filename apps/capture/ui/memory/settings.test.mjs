// Pure-function checks for the settings panel and the welcome flow. Run: node ui/memory/settings.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('/* ---- settings: pure ---- */'), src.indexOf('/* ---- end settings: pure ---- */'));
const names = 'deviceNoun,fmtBytes,forgetRange,pathPatch,deepMerge,syncPanel,guessPathStyle,s3Check,plainError,startNext,DESTINATIONS,statusView,pauseUntil,keepChoice,keepPatch,classifyExclusion,exclusionItems,audioStateText,policyText,PAUSE_CHOICES,KEEP_CHOICES';
const f = new Function(block + `;return {${names}}`)();
const { deviceNoun, fmtBytes, forgetRange, pathPatch, deepMerge, syncPanel, guessPathStyle, s3Check, plainError, startNext, DESTINATIONS, statusView, pauseUntil, keepChoice, keepPatch, classifyExclusion, exclusionItems, audioStateText, policyText } = f;

// The copy names the machine by platform.
assert.equal(deviceNoun('MacIntel'), 'Mac');
assert.equal(deviceNoun('Win32'), 'computer');
assert.equal(deviceNoun(undefined), 'computer');
assert.ok(!/this Mac|This Mac|Each Mac|another Mac/.test(src), 'copy must use ${PC}');

assert.equal(fmtBytes(0), '0 KB');
assert.equal(fmtBytes(2_500_000), '2.5 MB');
assert.equal(fmtBytes(3_210_000_000), '3.21 GB');

assert.equal(forgetRange('2026-10-01T09:00', '2026-10-01T10:00'), '2026-10-01T09:00|2026-10-01T10:00');
assert.equal(forgetRange('2026-10-01T10:00', '2026-10-01T09:00'), null);
assert.equal(forgetRange('', '2026-10-01T09:00'), null);

assert.deepEqual(pathPatch('audio.enabled', true), { audio: { enabled: true } });
assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, l: [1] }, { a: { b: 3 }, l: [2] }), { a: { b: 3, c: 2 }, l: [2] });

// Sync: three destinations, Off first.
assert.deepEqual(DESTINATIONS.map(([k]) => k), ['off', 'kortix', 's3']);
const offView = { destination: 'off' }, kortixView = { destination: 'kortix' }, s3View = { destination: 's3' };
// A managed computer shows the organization and no controls.
assert.deepEqual(syncPanel({ managed: true }, kortixView, 'off', { account_name: 'Example Org' }, null),
  { kind: 'managed', title: 'Managed by Example Org', sub: 'Your organization chooses where recordings go. You cannot change it here.' });
// Off: one sentence.
assert.deepEqual(syncPanel({}, offView, 'off', {}, null), { kind: 'off', sub: 'Recordings stay on this computer. Nothing is uploaded.' });
// Kortix: signed out asks to sign in; an expired sign-in says so; a running job shows its code.
assert.equal(syncPanel({}, offView, 'kortix', {}, null).kind, 'kortix-out');
assert.match(syncPanel({}, offView, 'kortix', { sign_in_required: true }, null).sub, /Sign in again/);
assert.deepEqual(syncPanel({}, offView, 'kortix', {}, { running: true, progress: { user_code: 'ABCD-1234' } }), { kind: 'kortix-wait', code: 'ABCD-1234' });
assert.deepEqual(syncPanel({}, offView, 'kortix', {}, { running: true }), { kind: 'kortix-wait', code: null });
// Signed in and syncing: names the account and the person. Signed in but Off: offers to turn sync on.
const k = { account_name: 'Example Org', member_email: 'person@example.com' };
assert.deepEqual(syncPanel({ signed_in: true }, kortixView, 'kortix', k, null), { kind: 'kortix-in', title: 'Kortix \u00b7 Example Org', sub: 'Signed in as person@example.com' });
assert.deepEqual(syncPanel({ signed_in: true }, offView, 'kortix', k, null), { kind: 'kortix-ready', title: 'Kortix \u00b7 Example Org', sub: 'Signed in as person@example.com. Sync is off.' });
// The S3 form shows for S3 whatever else is on.
assert.equal(syncPanel({ signed_in: true }, kortixView, 's3', k, null).kind, 's3');
assert.equal(syncPanel({}, s3View, 's3', {}, null).kind, 's3');

// Path-style suits self-hosted S3, not the hosted services.
assert.equal(guessPathStyle('http://127.0.0.1:9000'), true);
assert.equal(guessPathStyle('https://minio.internal.example'), true);
assert.equal(guessPathStyle('https://s3.us-east-1.amazonaws.com'), false);
assert.equal(guessPathStyle('https://abc123.r2.cloudflarestorage.com'), false);
assert.equal(guessPathStyle('nonsense'), false);

// The S3 form names its first missing field in one sentence.
const full = { endpoint: 'https://s3.example.com', bucket: 'b', access_key_id: 'AK', secret_access_key: 'sk' };
assert.equal(s3Check(full, false), null);
assert.match(s3Check({ ...full, endpoint: '' }, false), /endpoint/);
assert.match(s3Check({ ...full, endpoint: 's3.example.com' }, false), /https:\/\//);
assert.match(s3Check({ ...full, bucket: ' ' }, false), /bucket/);
assert.match(s3Check({ ...full, access_key_id: '' }, false), /access key ID/);
assert.match(s3Check({ ...full, secret_access_key: '' }, false), /secret/);
assert.equal(s3Check({ ...full, access_key_id: '', secret_access_key: '' }, true), null, 'saved keys need no retyping');

// An error a person reads: one sentence, never markup, a status line or a stack.
assert.equal(plainError('The bucket refused these keys.'), 'The bucket refused these keys.');
assert.equal(plainError('First sentence. Second sentence.'), 'First sentence.');
assert.equal(plainError('<html><body>Bad gateway</body></html>'), 'Something went wrong. Try again.');
assert.equal(plainError('PUT k: HTTP 403 AccessDenied'), 'Something went wrong. Try again.');
assert.equal(plainError('SyntaxError: Unexpected token < in JSON at position 0'), 'Something went wrong. Try again.');
assert.equal(plainError('TypeError: Load failed'), 'Something went wrong. Try again.');
assert.equal(plainError(''), 'Something went wrong. Try again.');
assert.equal(plainError(undefined), 'Something went wrong. Try again.');
assert.ok(plainError('x'.repeat(400)).length <= 140);

// After "Start recording": macOS asks for the permission, the others are done.
assert.equal(startNext(true, 'permission_missing'), 'permission');
assert.equal(startNext(true, 'not_recording'), 'permission');
assert.equal(startNext(true, 'recording'), 'done');
assert.equal(startNext(false, 'not_recording'), 'done');

// The window never tells a person to stop recording to change the destination.
assert.ok(!/Stop recording before/i.test(src), 'switching accounts must not require stopping');

// Status line.
const hm = () => '3:20 PM';
assert.deepEqual(statusView('recording', null, hm), { text: 'Recording', tone: 'live' });
assert.equal(statusView('paused', 1, hm).text, 'Paused until 3:20 PM');
assert.equal(statusView('permission_missing', null, hm).text, 'Needs permission');
assert.equal(statusView('not_recording', null, hm).text, 'Not recording');

// Pause choices.
const now = new Date(2026, 9, 14, 23, 50).getTime();
assert.equal(pauseUntil('15m', now), now + 900000);
assert.equal(pauseUntil('1h', now), now + 3600000);
assert.equal(pauseUntil('tomorrow', now), new Date(2026, 9, 15, 6, 0).getTime());

// Keep on this computer: one choice over the storage settings, and back.
assert.equal(keepChoice({ management_mode: 'storage_cap', cap_action: 'delete' }), 'space');
assert.equal(keepChoice({ management_mode: 'retention', retention_days: 7, retention_action: 'delete' }), '7');
assert.equal(keepChoice({ management_mode: 'retention', retention_days: 90, retention_action: 'delete' }), 'custom');
assert.equal(keepChoice({ management_mode: 'retention', retention_days: 7, retention_action: 'downscale' }), 'custom');
assert.equal(keepChoice({ management_mode: 'keep_all' }), 'custom');
assert.deepEqual(keepPatch('30'), { storage: { management_mode: 'retention', retention_days: 30, retention_action: 'delete' } });
assert.deepEqual(keepPatch('space'), { storage: { management_mode: 'storage_cap', cap_action: 'delete' } });
assert.equal(keepPatch('custom'), null);
for (const [k] of f.KEEP_CHOICES) assert.equal(keepChoice(keepPatch(k).storage), k);

// One add field: websites vs apps.
assert.deepEqual(classifyExclusion('example.com'), { kind: 'site', value: 'example.com' });
assert.deepEqual(classifyExclusion('https://www.Example.com/a?b=1'), { kind: 'site', value: 'example.com' });
assert.deepEqual(classifyExclusion('docs.google.com'), { kind: 'site', value: 'docs.google.com' });
assert.deepEqual(classifyExclusion('com.apple.Safari'), { kind: 'app', value: 'com.apple.Safari' });
assert.deepEqual(classifyExclusion('org.mozilla.firefox'), { kind: 'app', value: 'org.mozilla.firefox' });
assert.deepEqual(classifyExclusion('chrome.exe'), { kind: 'app', value: 'chrome.exe' });
assert.deepEqual(classifyExclusion('Slack'), { kind: 'app', value: 'Slack' });
assert.equal(classifyExclusion('two words.com'), null);
assert.equal(classifyExclusion('  '), null);

// The list: own apps, own sites, then the organization's (locked), no duplicates.
const items = exclusionItems({ excluded_bundle_ids: ['a.b.C'], excluded_domains: ['x.com'] }, { excluded_domains: ['x.com', 'y.com'], excluded_bundle_ids: ['z.exe'] });
assert.deepEqual(items.map((i) => [i.v, i.locked]), [['a.b.C', false], ['x.com', false], ['z.exe', true], ['y.com', true]]);

// Notice and audio row.
assert.equal(policyText(null), null);
assert.equal(policyText({ policy: { notice: ' Recorded for support ' } }), 'Recorded for support');
assert.equal(policyText({ policy: {} }), 'Your organization manages recording on this computer.');
assert.equal(audioStateText(false, { state: 'recording' }), 'Off');
assert.equal(audioStateText(true, { state: 'recording', sources: { microphone: { state: 'recording' }, system: { state: 'silent' } } }), 'Recording microphone + system audio');
assert.equal(audioStateText(true, { state: 'permission_missing', sources: {} }), 'Needs permission to record');

// The window shows five sections (plus a folded Advanced) and nothing from the old settings.
const ui = src.slice(src.indexOf('function renderSettings()'), src.indexOf('/* ---- audio: one switch'));
assert.deepEqual([...ui.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Recording', 'Sync', 'Privacy', 'Storage', 'About']);
assert.ok(ui.includes('<summary>Advanced</summary>'));
for (const gone of ['staging_quality', 'video_quality', 'chunk_max_frames', 'ocr_languages', 'ax_enabled', 'record_unknown_bundle_ids', 'airgap', 'min_free_gb', 'reserve_mb', 'pause_on_inactivity', 'inactivity_seconds', 'management_mode', 'shortcuts', 'agent_routing', 'sync-provider']) {
  assert.ok(!ui.includes(gone), `${gone} is not in the settings window`);
}
assert.ok(!/control plane|control_plane|dashboard_url|enrolled_url/.test(src), 'no old control plane copy');
console.log('settings ok');
