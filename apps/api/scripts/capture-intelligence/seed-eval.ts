/**
 * Seed the Capture Intelligence eval: one account, six synthetic people, one
 * device each, N workdays of synthetic activity, through the real path:
 * device sign-in (RFC 8628) → the device's STS credentials → engine-format
 * objects in the store → sync → ingest jobs. Writes the ground truth (with each
 * person's user and device id) to `$CAPTURE_EVAL_OUT/truth.json`.
 *
 *   CAPTURE_EVAL_API=http://localhost:37208/v1 SUPABASE_URL=… SUPABASE_ANON_KEY=… \
 *   SUPABASE_SERVICE_ROLE_KEY=… CAPTURE_EVAL_OUT=output/capture-eval \
 *   bun apps/api/scripts/capture-intelligence/seed-eval.ts [--days 21] [--seed 7]
 *
 * Local stacks only: it creates users and an account. Synthetic data only.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { uploadCaptureObjects, type CaptureObject } from '../../../../tests/src/fixtures/capture';
import { generate, PEOPLE } from './synthetic';
import { deviceObjects } from './writer';

const { values: args } = parseArgs({ options: { days: { type: 'string', default: '21' }, seed: { type: 'string', default: '7' } } });
const API = process.env.CAPTURE_EVAL_API ?? 'http://localhost:8008/v1';
const OUT = process.env.CAPTURE_EVAL_OUT ?? 'output/capture-eval';
const SB = { url: process.env.SUPABASE_URL!, anon: process.env.SUPABASE_ANON_KEY!, service: process.env.SUPABASE_SERVICE_ROLE_KEY! };
if (!SB.url || !SB.anon || !SB.service) throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required');
if (!/localhost|127\.0\.0\.1/.test(API + SB.url)) throw new Error('seed-eval runs against a local stack only');
// The eval users' password: CAPTURE_EVAL_PASSWORD (to share a local login), else a fresh random one.
const PASSWORD = process.env.CAPTURE_EVAL_PASSWORD ?? `Eval-${randomBytes(6).toString('hex')}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function http(method: string, path: string, token?: string, body?: unknown, okStatuses = [200, 201]) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!okStatuses.includes(res.status)) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function user(email: string) {
  const admin = { apikey: SB.service, authorization: `Bearer ${SB.service}`, 'content-type': 'application/json' };
  await fetch(`${SB.url}/auth/v1/admin/users`, { method: 'POST', headers: admin, body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }) });
  const list: any = await (await fetch(`${SB.url}/auth/v1/admin/users?per_page=1000`, { headers: admin })).json();
  const id = list.users.find((u: any) => u.email === email)?.id;
  await fetch(`${SB.url}/auth/v1/admin/users/${id}`, { method: 'PUT', headers: admin, body: JSON.stringify({ password: PASSWORD }) });
  const t: any = await (await fetch(`${SB.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: SB.anon, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) })).json();
  if (!t.access_token) throw new Error(`sign-in ${email}: ${JSON.stringify(t).slice(0, 200)}`);
  return { id: t.user.id as string, email, token: t.access_token as string };
}

/** Upload in parallel lanes; data before manifests before index lines, as the engine orders them. */
async function upload(target: Parameters<typeof uploadCaptureObjects>[0], objects: CaptureObject[], lanes = 16) {
  const size = Math.ceil(objects.length / lanes);
  await Promise.all(Array.from({ length: lanes }, (_, i) => uploadCaptureObjects(target, objects.slice(i * size, (i + 1) * size))));
}

const started = Date.now();
const today = new Date();
const endDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
const { persons, truth } = generate({ seed: Number(args.seed), days: Number(args.days), endDay });

const owner = await user('capture-eval-admin@example.test');
const accountId: string = (await http('POST', '/accounts', owner.token, { name: `Capture Eval ${new Date().toISOString().slice(0, 16)}` })).json.account_id;
await http('PATCH', `/accounts/${accountId}/capture`, owner.token, { enabled: true });
await http('PUT', `/accounts/${accountId}/capture/policy`, owner.token, {
  policy: { layers: { screen: true, actions: true, audio: false }, retention: { local_hours: 24, remote_days: 90 }, notice: 'Capture eval: synthetic recordings only.' },
});

const people: Record<string, { userId: string; deviceId: string; email: string }> = {};
for (const p of persons) {
  const who = PEOPLE.find((x) => x.id === p.person)!;
  const member = await user(`capture-eval-${p.person}@example.test`);
  await http('POST', `/accounts/${accountId}/members`, owner.token, { email: member.email, role: 'member' });
  const machineKey = sha(`capture-eval/${accountId}/${p.person}`);
  const grant = (await http('POST', '/capture/device/authorize', undefined, {
    client_id: 'kortix-capture',
    device: { device_id: '', machine_key_sha256: machineKey, hostname: 'eval.local', computer_name: who.name, os: 'macos', os_version: '26.0', arch: 'aarch64', app_version: '0.1.0' },
  })).json;
  await http('POST', `/capture/device/grants/${grant.user_code}/approve`, member.token, { account_id: accountId });
  let token: any = null;
  for (let i = 0; i < 8 && !token; i++) {
    await Bun.sleep(Number(grant.interval ?? 5) * 1000 + 200);
    const res = await http('POST', '/capture/device/token', undefined, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.device_code, client_id: 'kortix-capture' }, [200, 400, 428]);
    if (res.status === 200) token = res.json;
  }
  if (!token) throw new Error(`device token for ${p.person} never arrived`);
  const c = (await http('POST', '/capture/credentials', token.device_token)).json;
  const target = { endpoint: c.endpoint, bucket: c.bucket, region: c.region, accessKeyId: c.access_key_id, secretAccessKey: c.secret_access_key, sessionToken: c.session_token };
  const objects = await deviceObjects({ prefix: token.prefix, deviceId: token.device_id, machineKey, name: who.name, activity: p.activity });
  await upload(target, objects.data);
  await upload(target, objects.manifests);
  await upload(target, objects.rest);
  const synced = (await http('POST', `/accounts/${accountId}/capture/devices/${token.device_id}/sync`, member.token)).json;
  people[p.person] = { userId: member.id, deviceId: token.device_id, email: member.email };
  console.log(`${p.person}: device ${token.device_id} items ${objects.items} enqueued ${synced.enqueued}`);
}

mkdirSync(OUT, { recursive: true });
await Bun.write(
  join(OUT, 'truth.json'),
  JSON.stringify({ api: API, accountId, owner: { id: owner.id, email: owner.email }, password: PASSWORD, seed: Number(args.seed), days: Number(args.days), endDay, seededAt: new Date().toISOString(), seedMs: Date.now() - started, people, truth }, null, 1),
);
console.log(`account ${accountId}; ${truth.length} runs; truth → ${join(OUT, 'truth.json')}; ${Math.round((Date.now() - started) / 1000)} s`);
