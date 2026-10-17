import { execFile, spawn } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
const exec = promisify(execFile);
// Manual development check only. Uses the real UI/API in a scratch library,
// mocks model downloads, opens a headless browser and never starts recording.
const { values } = parseArgs({ options: { server: { type: 'string' }, out: { type: 'string' } } });
const recorderRoot = fileURLToPath(new URL('../', import.meta.url));
const serverBinary = path.resolve(values.server || path.join(recorderRoot, 'target/debug/examples/memory_ui_server'));
const output = path.resolve(values.out || path.join(recorderRoot, 'artifacts/privacy-settings-ui'));
const screenshots = path.join(output, 'screens');
await mkdir(screenshots, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'kortix-privacy-settings-'));
const library = path.join(scratch, 'library');
await mkdir(library);
const reserve = createServer();
await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const port = reserve.address().port;
await new Promise(r => reserve.close(r));
const baseUrl = `http://127.0.0.1:${port}`;
const session = `kortix-privacy-settings-${process.pid}`;
const backend = spawn(serverBinary, [library, String(port)], {
  env: { ...process.env, KORTIX_CAPTURE_DIR: library, KORTIX_CAPTURE_KEY_STORE: 'file' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let startupError;
backend.on('error', e => { startupError = e; });
backend.stderr.on('data', () => {});
async function startServer() {
  for (let i = 0; i < 100; i++) {
    if (startupError || backend.exitCode != null) throw Error('UI server failed. First run: cargo build --example memory_ui_server');
    try { if ((await fetch(baseUrl + '/api/settings')).ok) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error('UI server did not start');
}
const evidence = [];
async function browser(...args) {
  const r = await exec('agent-browser', ['--session', session, ...args], { maxBuffer: 2e6 });
  return r.stdout.trim();
}
async function evaluate(code) { return browser('eval', '-b', Buffer.from(code).toString('base64')); }
async function wait(code) { return browser('wait', '--fn', code); }
async function record(name, code) {
  await evaluate(`(() => { if (!(${code})) throw Error('assertion failed'); return true; })()`).catch((error) => {
    throw new Error(`${name}: ${error.message}`);
  });
  evidence.push(name);
  console.log('PASS', name);
}
async function model(state, abort = false) {
  await browser('network', 'unroute', '**/api/privacy-model');
  await browser('network', 'route', '**/api/privacy-model', ...(abort ? ['--abort'] : ['--body', JSON.stringify(state)]));
}
async function reopenSection() {
  await browser('click', '#experimental-privacy summary');
  await browser('click', '#experimental-privacy summary');
}
const missing = { installed: false, downloading: false };
const downloading = { installed: false, downloading: true, phase: 'downloading', downloaded_bytes: 100000000 };
const ready = { installed: true, downloading: false, phase: 'idle', downloaded_bytes: 945000000 };
try {
  await startServer();
  await browser('open', baseUrl + '/#%7B%22view%22%3A%22settings%22%7D');
  await browser('set', 'viewport', '1100', '900');
  await wait("document.querySelector('#experimental-privacy') && !document.querySelector('#settings').hidden");
  await record('Collapsed, off, last in Settings, no automatic model requests', "!document.querySelector('#experimental-privacy').open && !document.querySelector('#privacy-enabled').checked && document.querySelector('.settings').lastElementChild.id === 'experimental-privacy' && !performance.getEntriesByType('resource').some(r=>r.name.endsWith('/api/privacy-model') || r.name.endsWith('/api/privacy-model/install'))");
  await browser('scrollintoview', '#experimental-privacy');
  await browser('screenshot', screenshots + '/collapsed.png');
  await model(missing);
  await browser('click', '#experimental-privacy summary');
  await wait("!document.querySelector('#privacy-model-install').disabled");
  await record('Missing model blocks activation', "document.querySelector('#privacy-enabled').disabled && !document.querySelector('#privacy-enabled').checked");
  await browser('scrollintoview', '#privacy-model-card');
  await browser('screenshot', screenshots + '/expanded.png');
  await model(downloading);
  await browser('network', 'route', '**/api/privacy-model/install', '--body', JSON.stringify(downloading));
  await browser('click', '#privacy-model-install');
  await wait("document.querySelector('#privacy-model-state').textContent.includes('100.0 MB')");
  await record('Download keeps masking off and prevents duplicate clicks', "!document.querySelector('#privacy-enabled').checked && document.querySelector('#privacy-enabled').disabled && document.querySelector('#privacy-model-install').disabled && !document.querySelector('#privacy-model-progress').hidden");
  await browser('screenshot', screenshots + '/downloading.png');
  await browser('click', '#set-back');
  await browser('click', '#btn-settings');
  await wait("!document.querySelector('#settings').hidden && !document.querySelector('#experimental-privacy').open");
  await record('Reopening Settings collapses experimental controls', "!document.querySelector('#experimental-privacy').open");
  await browser('click', '#experimental-privacy summary');
  await wait("document.querySelector('#privacy-model-state').textContent.includes('100.0 MB')");
  await record('Reopening section resumes download tracking', "document.querySelector('#privacy-model-install').disabled");
  await model({ ...downloading, phase: 'verifying', downloaded_bytes: 945000000 });
  await reopenSection();
  await wait("document.querySelector('#privacy-model-state').textContent.includes('Verifying and loading')");
  await record('Verification finishes before activation becomes available', "document.querySelector('#privacy-enabled').disabled");
  await model(ready);
  await reopenSection();
  await wait("document.querySelector('#privacy-model-state').textContent.includes('Model installed') && !document.querySelector('#privacy-enabled').disabled");
  await record('Installation completion does not opt in', "!document.querySelector('#privacy-enabled').checked && document.querySelector('#privacy-summary-state').textContent === 'Off'");
  await browser('click', '#privacy-enabled');
  await evaluate("(async()=>{await new Promise(r=>setTimeout(r,450)); const s=await(await fetch('/api/settings')).json(); if(!s.settings.privacy.redact_pii)throw Error('explicit opt-in not saved'); return true})()");
  evidence.push('Explicit opt-in saves to the real scratch backend');
  await model({ installed: false, downloading: false, error: 'Synthetic checksum failure' });
  await reopenSection();
  await wait("document.querySelector('#privacy-model-state').textContent.includes('Installation failed')");
  await record('Failed model never traps an enabled user', "document.querySelector('#privacy-enabled').checked && !document.querySelector('#privacy-enabled').disabled");
  await browser('click', '#privacy-enabled');
  await evaluate("(async()=>{await new Promise(r=>setTimeout(r,450)); const s=await(await fetch('/api/settings')).json(); if(s.settings.privacy.redact_pii)throw Error('disable not saved'); return true})()");
  await record('Installation failure offers retry', "document.querySelector('#privacy-model-install').textContent === 'Retry download' && !document.querySelector('#privacy-model-install').disabled");
  await model(ready);
  await browser('click', '#privacy-model-install');
  await wait("!document.querySelector('#privacy-enabled').disabled");
  await record('Successful retry keeps masking off', "!document.querySelector('#privacy-enabled').checked");
  await model(null, true);
  await reopenSection();
  await wait("!document.querySelector('#privacy-model-refresh').hidden");
  await record('Status failure offers recovery and blocks unsafe activation', "document.querySelector('#privacy-enabled').disabled && document.querySelector('#privacy-model-install').disabled");
  await model(ready);
  await browser('click', '#privacy-model-refresh');
  await wait("!document.querySelector('#privacy-enabled').disabled");
  await record('Status recovery leaves masking off', "!document.querySelector('#privacy-enabled').checked");
  await browser('select', '#privacy-method', 'patterns');
  await wait("document.querySelector('#privacy-method-help').textContent.includes('Does not detect names or addresses')");
  await record('Patterns-only limitations are explicit', "!document.querySelector('#privacy-enabled').checked");
  await browser('click', '#privacy-enabled');
  await wait("document.querySelector('#privacy-enable-help').textContent.includes('Enabled with patterns only')");
  await browser('click', '#privacy-enabled');
  await browser('set', 'viewport', '500', '900');
  await browser('scrollintoview', '#privacy-model-card');
  await browser('screenshot', screenshots + '/narrow.png');
  await record('Experimental section fits a narrow window', "document.querySelector('#experimental-privacy').getBoundingClientRect().right <= innerWidth && document.querySelector('#privacy-model-install').getBoundingClientRect().right <= innerWidth");
  const audit = JSON.parse(await browser('a11y', '--selector', '#experimental-privacy', '--json'));
  if (audit.data.counts.violations || audit.data.counts.incomplete) throw Error('Accessibility issues: '+JSON.stringify(audit.data.counts));
  evidence.push('Accessibility: zero violations and zero incomplete checks');
  if ((await readdir(library)).includes('privacy-model')) throw Error('Unexpected actual model download');
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ evidence, accessibility: audit.data.counts, model_downloads: 'Simulated; no actual model downloads', backend: 'Real memory_ui_server, scratch library' }, null, 2));
  console.log('PASS privacy settings browser checks');
} finally {
  // Every setting changed here belongs only to the scratch library.
  await browser('close').catch(() => {});
  if (backend.pid && backend.exitCode == null && backend.signalCode == null) {
    const exited = new Promise(r => backend.once('exit', r));
    backend.kill();
    await exited;
  }
  await rm(scratch, { recursive: true, force: true });
}
