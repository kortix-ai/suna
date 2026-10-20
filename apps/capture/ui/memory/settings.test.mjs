// Pure-function checks for the settings panel and the welcome flow. Run: node ui/memory/settings.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('/* ---- settings: pure ---- */'), src.indexOf('/* ---- end settings: pure ---- */'));
const names = 'onlyIncluded,deviceNoun,fmtBytes,forgetRange,pathPatch,deepMerge,syncPanel,guessPathStyle,s3Check,plainError,onboardingStep,inputsMissing,neverRows,suggestionList,policySource,groupMembers,keepHint,lastHour,DESTINATIONS,syncShown,statusView,pauseUntil,keepChoice,keepPatch,classifyExclusion,exclusionItems,audioStateText,policyText,PAUSE_CHOICES,KEEP_CHOICES';
const f = new Function(block + `;return {${names}}`)();
const { onlyIncluded, deviceNoun, fmtBytes, forgetRange, pathPatch, deepMerge, syncPanel, guessPathStyle, s3Check, plainError, onboardingStep, inputsMissing, neverRows, suggestionList, policySource, groupMembers, keepHint, lastHour, DESTINATIONS, syncShown, statusView, pauseUntil, keepChoice, keepPatch, classifyExclusion, exclusionItems, audioStateText, policyText } = f;

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

// Sync: three destinations, Kortix first (the default), Off last.
assert.deepEqual(DESTINATIONS.map(([k]) => k), ['kortix', 's3', 'off']);
// The Sync section shows the destination that is on; Off offers the Kortix sign-in.
assert.equal(syncShown({ destination: 'off' }), 'kortix');
assert.equal(syncShown(undefined), 'kortix');
assert.equal(syncShown({ destination: 's3' }), 's3');
assert.equal(syncPanel({}, { destination: 'off' }, syncShown({ destination: 'off' }), {}, null).kind, 'kortix-out');
// Turning sync off or signing out asks first: no one-click path to Off.
assert.ok(!/act\('\/api\/sync\/off'\)[^;]*\n?[^;]*dataset\.dest/.test(src));
// A pick only marks the change; nothing is posted from the destination buttons.
const pick = src.slice(src.indexOf('if (b.dataset.dest) {'), src.indexOf('if (b.dataset.confirm && !armed(b)) return;'));
assert.ok(pick.length > 0 && !/act\(|api\(/.test(pick), 'choosing a destination never saves');
assert.match(src, /pending && chosen === 'off'[\s\S]{0,400}id="sync-stop">Stop syncing/);
assert.match(src, /pending && chosen === 's3'[\s\S]{0,600}Save and switch/);
assert.match(src, /case 'kortix-signout': draft\.confirmOff = 'signout'/);
const offView = { destination: 'off' }, kortixView = { destination: 'kortix' }, s3View = { destination: 's3' };
// A managed computer shows the organization and no controls.
assert.deepEqual(syncPanel({ managed: true }, kortixView, 'off', { account_name: 'Example Org' }, null),
  { kind: 'managed', title: 'Managed by Example Org', sub: 'Set by Example Org.' });
// Off: one sentence.
assert.deepEqual(syncPanel({}, offView, 'off', {}, null), { kind: 'off', sub: 'Recordings stay on this computer.' });
// Kortix: signed out asks to sign in; an expired sign-in says so; a running job shows its code.
assert.equal(syncPanel({}, offView, 'kortix', {}, null).kind, 'kortix-out');
assert.equal(syncPanel({}, offView, 'kortix', { sign_in_required: true }, null).sub, '', 'the status line already says it');
assert.equal(syncPanel({}, offView, 'kortix', {}, null).sub, 'Not connected.');
assert.deepEqual(syncPanel({}, offView, 'kortix', {}, { running: true, progress: { user_code: 'ABCD-1234' } }), { kind: 'kortix-wait', code: 'ABCD-1234' });
assert.deepEqual(syncPanel({}, offView, 'kortix', {}, { running: true }), { kind: 'kortix-wait', code: null });
// Signed in and syncing: names the account and the person. Signed in but Off: offers to turn sync on.
const k = { account_name: 'Example Org', member_email: 'person@example.com' };
assert.deepEqual(syncPanel({ signed_in: true }, kortixView, 'kortix', k, null), { kind: 'kortix-in', title: 'Kortix \u00b7 Example Org', sub: 'Signed in as person@example.com' });
// Signed in means syncing: there is no "turn on" state, whatever the status line says.
assert.deepEqual(syncPanel({ signed_in: true }, offView, 'kortix', k, null), { kind: 'kortix-in', title: 'Kortix \u00b7 Example Org', sub: 'Signed in as person@example.com' });
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

// Never record: one list. The organization's entries come first, locked, named by the account;
// the person's own groups, private browsing and entries follow, the entries removable.
const groups = [{ id: 'password_managers', name: 'Password managers' }, { id: 'messaging', name: 'Messaging apps' }, { id: 'banking', name: 'Banking and finance' }];
const own = { excluded_bundle_ids: ['com.example.Mine'], excluded_domains: ['mine.example'], enabled_exclusion_groups: ['messaging'], exclude_private_browsing: false };
const plain = neverRows(own, groups, null, null);
assert.deepEqual(plain.map((r) => [r.kind, r.id, r.locked, r.on ?? null]), [
  ['group', 'password_managers', false, false], ['group', 'messaging', false, true], ['group', 'banking', false, false],
  ['private', 'private', false, false], ['app', 'com.example.Mine', false, null], ['site', 'mine.example', false, null]]);
assert.equal(plain.find((r) => r.id === 'banking').sub, 'Bank and finance apps and websites');
assert.ok(plain.every((r) => !/\d+ (apps|sites)/.test(r.sub)), 'no counts');
assert.deepEqual(plain.filter((r) => r.key).map((r) => r.key), ['excluded_bundle_ids', 'excluded_domains']);
const pp = { exclusion_groups: ['banking'], exclude_private_browsing: true, excluded_bundle_ids: ['com.example.Required'], excluded_domains: ['mine.example'] };
const withOrg = neverRows(own, groups, pp, 'Example Org');
assert.deepEqual(withOrg.map((r) => [r.kind, r.id, r.locked]), [
  ['group', 'banking', true], ['private', 'private', true], ['app', 'com.example.Required', true], ['site', 'mine.example', true],
  ['group', 'password_managers', false], ['group', 'messaging', false], ['app', 'com.example.Mine', false]]);
assert.ok(withOrg.filter((r) => r.locked).every((r) => r.sub === 'Required by Example Org'));
assert.equal(neverRows(own, groups, pp, null)[0].sub, 'Required by policy');
assert.ok(!JSON.stringify(withOrg).includes('your organization'));

// Privacy controls are hidden by default. A Kortix policy decides while synced; else the local switch.

// The keep row states its rule; the forget range starts as the last hour.
assert.match(keepHint('7', true, 50), /only once uploaded/);
assert.match(keepHint('space', true, 50), /50 GB/);
assert.match(keepHint('space', false, 50), /^Nothing is uploaded/);
assert.equal(keepHint('custom', true, 50), '');
const hr = lastHour(new Date(2026, 9, 14, 15, 30).getTime());
assert.deepEqual(hr, { from: '2026-10-14T14:30', to: '2026-10-14T15:30' });
assert.notEqual(hr.from, hr.to);
assert.ok(forgetRange(hr.from, hr.to), 'the default range is a valid range');

// Onboarding: permission (macOS, only when missing) -> connect -> waiting -> done.
assert.equal(onboardingStep({ state: 'recording' }, null, { destination: 'off' }, { mac: true }), 'connect');
assert.equal(onboardingStep({ state: 'permission_missing' }, null, { destination: 'off' }, { mac: true }), 'permission');
assert.equal(onboardingStep({ state: 'permission_missing' }, null, { destination: 'off' }, { mac: false }), 'connect', 'only macOS asks');
assert.equal(onboardingStep({ state: 'permission_missing' }, null, { destination: 'off' }, { mac: true, permissionSkipped: true }), 'connect');
assert.equal(onboardingStep({ state: 'permission_missing' }, { running: true, progress: { user_code: 'A' } }, { destination: 'off' }, { mac: true }), 'waiting');
assert.equal(onboardingStep({ state: 'recording' }, { running: false, ok: true }, { destination: 'kortix' }, { signedIn: true }), 'done');
assert.equal(onboardingStep({ state: 'recording' }, { running: false, ok: false, error: 'x' }, { destination: 'off' }, {}), 'connect');

// macOS keyboard and mouse recording needs Accessibility and Input Monitoring.
const hb = (granted, running = true) => ({ platform: 'macos', service: { heartbeat: { running, granted } } });
assert.deepEqual(inputsMissing(hb(['screen'])), ['accessibility', 'input_monitoring']);
assert.deepEqual(inputsMissing(hb(['screen', 'accessibility'])), ['input_monitoring']);
assert.equal(inputsMissing(hb(['screen', 'accessibility', 'input_monitoring'])), null);
assert.equal(inputsMissing(hb(null)), null, 'unknown is not missing');
assert.equal(inputsMissing(hb(['screen'], false)), null, 'no service, no claim');
assert.equal(inputsMissing({ platform: 'windows', service: { heartbeat: { running: true, granted: [] } } }), null);
assert.equal(onboardingStep({ ...hb(['screen']), state: 'recording' }, null, { destination: 'off' }, { mac: true }), 'permission', 'inputs missing also asks');
assert.equal(onboardingStep({ ...hb(['screen', 'accessibility', 'input_monitoring']), state: 'recording' }, null, { destination: 'off' }, { mac: true }), 'connect');

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
assert.equal(policyText({ policy: {} }), 'Managed by policy.');
assert.equal(audioStateText(false, { state: 'recording' }), 'Off');
assert.equal(audioStateText(true, { state: 'recording', sources: { microphone: { state: 'recording' }, system: { state: 'silent' } } }), 'Recording microphone + system audio');
assert.equal(audioStateText(true, { state: 'permission_missing', sources: {} }), 'Needs permission to record');

// The window shows five sections (Apps and websites always; plus a folded Advanced) and nothing from the old settings.
const ui = src.slice(src.indexOf('function renderSettings()'), src.indexOf('/* ---- audio: one switch'));
assert.deepEqual([...ui.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Recording', 'Sync', 'Apps and websites', 'Storage', 'About']);
assert.ok(ui.includes('<summary>Advanced</summary>'));
for (const gone of ['staging_quality', 'video_quality', 'chunk_max_frames', 'ocr_languages', 'ax_enabled', 'record_unknown_bundle_ids', 'airgap', 'min_free_gb', 'reserve_mb', 'pause_on_inactivity', 'inactivity_seconds', 'management_mode', 'shortcuts', 'agent_routing', 'sync-provider']) {
  assert.ok(!ui.includes(gone), `${gone} is not in the settings window`);
}
// No marketing, no hero: labels and status only.
for (const phrase of ['know your work', 'Kortix agents', 'so you can search', 'Start recording', 'Connect to Kortix instead']) assert.ok(!src.includes(phrase), phrase);
assert.ok(!/welcome/i.test(src), 'no welcome screen');
assert.ok(!src.includes('Turn on sync'), 'signed in means syncing');
assert.ok(!/control plane|control_plane|dashboard_url|enrolled_url/.test(src), 'no old control plane copy');
console.log('settings ok');

// Record only included: off by default; the person's own switch and lists; the organization's locked.
assert.deepEqual(onlyIncluded({}, null, null), { on: false, locked: false, sub: '', rows: [], own: true });
const mineOnly = onlyIncluded({ record_only_included: true, included_bundle_ids: ['com.mine.editor'], included_domains: ['github.com'] }, null, null);
assert.equal(mineOnly.on, true);
assert.equal(mineOnly.locked, false);
assert.deepEqual(mineOnly.rows.map((r) => [r.kind, r.id, r.locked, r.key]), [['app', 'com.mine.editor', false, 'included_bundle_ids'], ['site', 'github.com', false, 'included_domains']]);
const orgOnly = onlyIncluded({ included_bundle_ids: ['com.tinyspeck.slackmacgap', 'com.mine.editor'] }, { record_only_included: true, included_bundle_ids: ['com.tinyspeck.slackmacgap'], included_domains: ['linear.app'] }, 'Example Org');
assert.equal(orgOnly.on, true, 'the organization turns it on');
assert.equal(orgOnly.locked, true, 'the person cannot turn it off');
assert.equal(orgOnly.sub, 'Required by Example Org');
assert.deepEqual(orgOnly.rows.map((r) => [r.id, r.locked]), [['com.tinyspeck.slackmacgap', true], ['linear.app', true], ['com.mine.editor', false]], 'an entry both hold shows once, locked');

// Suggestions where a person includes or excludes: installed and recorded apps (once each, by bundle id), then websites.
assert.deepEqual(
  suggestionList([{ bundle: 'com.tinyspeck.slackmacgap', name: 'Slack' }], [{ bundle: 'COM.tinyspeck.slackmacgap', name: 'Slack' }, { bundle: 'code.exe', name: null }], [{ name: 'github.com' }]),
  [{ value: 'com.tinyspeck.slackmacgap', label: 'Slack' }, { value: 'code.exe', label: 'code.exe' }, { value: 'github.com', label: 'Website' }],
);
assert.deepEqual(suggestionList(undefined, undefined, undefined), []);

// The organization can keep inclusions to its own list.
const orgOwnOnly = onlyIncluded({ included_bundle_ids: ['com.mine.editor'] }, { record_only_included: true, member_inclusions: false, included_bundle_ids: ['com.tinyspeck.slackmacgap'] }, 'Example Org');
assert.equal(orgOwnOnly.own, false);
assert.deepEqual(orgOwnOnly.rows.map((r) => r.id), ['com.tinyspeck.slackmacgap'], "the person's own inclusions are not shown: they do not apply");
// Where the rules come from.
assert.equal(policySource(null, '', { locked: false, own: true }), 'Set on this computer. Nothing here is uploaded.');
assert.equal(policySource({}, 'Example Org', { locked: true, own: true }), 'Synced from Example Org, which uses an inclusion policy. Its entries are locked. You can add your own; you cannot remove theirs.');
assert.match(policySource({}, 'Example Org', { locked: false, own: false }), /only Example Org adds what is recorded/);

// A managed computer before its policy arrives says so.
assert.equal(policySource(null, 'Example Org', { locked: false, own: true }, true), 'Managed by Example Org. Its rules arrive with its policy.');
// Category members by name where this computer knows them.
assert.deepEqual(groupMembers({ bundle_ids: ['com.1password.1password', '1password.exe', 'x.y'], domains: ['1password.com'] }, [{ value: 'com.1password.1password', label: '1Password' }, { value: '1password.exe', label: '1Password' }]), ['1Password', 'x.y', '1password.com']);
