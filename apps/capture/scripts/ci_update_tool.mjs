// CI helper for the Kortix Capture updater: keys, manifest, signature.
//
//   node ci_update_tool.mjs keygen <dir>
//       Writes <dir>/update-key.pem (Ed25519, PKCS#8) and prints the public key
//       (32 raw bytes, base64): the value of KORTIX_CAPTURE_UPDATE_PUBLIC_KEY.
//   node ci_update_tool.mjs pubkey <pem>
//       Prints the public key of a private key file.
//   node ci_update_tool.mjs manifest --out FILE --version V --channel stable|dev [--paused]
//       --asset windows=PATH --asset macos=PATH --asset linux=PATH
//       (--repo R --release-tag T | --url-base URL)
//       [--previous-manifest FILE | --previous-from-releases R --key PEM --channel stable]
//   node ci_update_tool.mjs sign --key PEM FILE [--out SIGFILE]
//       Writes FILE.sig: base64 Ed25519 signature over the exact bytes of FILE.
//
// capture-build.yml (collect) and ci_update_test.py both call this, so the
// manifest the updater test serves is built exactly like the release one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [cmd, ...rest] = process.argv.slice(2);

function opts(args) {
  const o = { _: [], asset: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (k === 'paused') { o.paused = true; continue; }
    const v = args[++i];
    if (k === 'asset') { const [os, p] = v.split(/=(.*)/s); o.asset[os] = p; } else o[k] = v;
  }
  return o;
}

const rawPublic = (privateKey) =>
  crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

function sign(keyFile, file, out) {
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
  fs.writeFileSync(out ?? `${file}.sig`, crypto.sign(null, fs.readFileSync(file), key).toString('base64') + '\n');
}

function verify(pubB64, body, sigB64) {
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubB64, 'base64')]);
  return crypto.verify(null, body, crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }), Buffer.from(sigB64.trim(), 'base64'));
}

// The newest published release older than this version that carries a signed
// capture-update.json: its assets become `previous` (rollback target for devices that kept none).
function previousFromReleases(repo, keyFile, version) {
  const pub = rawPublic(crypto.createPrivateKey(fs.readFileSync(keyFile)));
  const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 26 });
  const releases = JSON.parse(gh('api', `repos/${repo}/releases?per_page=30`));
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    const m = r.assets.find((a) => a.name === 'capture-update.json');
    const s = r.assets.find((a) => a.name === 'capture-update.json.sig');
    if (!m || !s) continue;
    const dl = (a) => execFileSync('curl', ['-fsSL', a.browser_download_url], { maxBuffer: 1 << 24 });
    try {
      const body = dl(m);
      if (!verify(pub, body, dl(s).toString())) { console.error(`previous ${r.tag_name}: signature does not verify; skipped`); continue; }
      const prev = JSON.parse(body.toString());
      if (prev.version === version) continue;
      return { version: prev.version, assets: prev.assets };
    } catch (e) {
      console.error(`previous ${r.tag_name}: ${e.message}; skipped`);
    }
  }
  return null;
}

if (cmd === 'keygen') {
  const dir = rest[0];
  fs.mkdirSync(dir, { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const file = path.join(dir, 'update-key.pem');
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(rawPublic(privateKey));
} else if (cmd === 'pubkey') {
  console.log(rawPublic(crypto.createPrivateKey(fs.readFileSync(rest[0]))));
} else if (cmd === 'sign') {
  const o = opts(rest);
  sign(o.key, o._[0], o.out);
} else if (cmd === 'manifest') {
  const o = opts(rest);
  const base = o['url-base'] ?? `https://github.com/${o.repo}/releases/download/${encodeURIComponent(o['release-tag'])}`;
  const asset = (file) => {
    const bytes = fs.readFileSync(file);
    const name = path.basename(file);
    return {
      name,
      url: `${base}/${encodeURIComponent(name)}`,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  };
  const manifest = {
    version: o.version.replace(/^v/, ''),
    channel: o.channel,
    released_at: new Date().toISOString(),
    ...(o.paused ? { paused: true } : {}),
    assets: Object.fromEntries(Object.entries(o.asset).map(([os, f]) => [os, asset(f)])),
  };
  if (o['previous-manifest']) {
    const p = JSON.parse(fs.readFileSync(o['previous-manifest'], 'utf8'));
    manifest.previous = { version: p.version, assets: p.assets };
  } else if (o['previous-from-releases'] && o.channel === 'stable') {
    const p = previousFromReleases(o['previous-from-releases'], o.key, manifest.version);
    if (p) manifest.previous = p;
    else console.error('no earlier signed release found: the manifest has no `previous`');
  }
  fs.writeFileSync(o.out, JSON.stringify(manifest, null, 2) + '\n');
} else {
  console.error('usage: ci_update_tool.mjs keygen|pubkey|sign|manifest …');
  process.exit(2);
}
