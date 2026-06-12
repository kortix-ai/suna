#!/usr/bin/env bun
/**
 * LIVE end-to-end test of the Pipedream connector path against REAL Pipedream —
 * the exact path that was returning `ok:true, data:{}` ("can't find any").
 *
 * It is interactive: it mints a real Connect link, you authorize the app in your
 * browser, press Enter, and it then drives the real wire path and asserts you get
 * actual data back. No API server and no DB row needed — it calls the provider
 * functions directly (the same ones the gateway uses).
 *
 * Flow:
 *   pipedreamConnectUrl()  → print the Connect link, wait for you to authorize
 *   pipedreamListAccounts()→ resolve the connected account id
 *   pipedreamCatalog()+normalize → assert the account-selector prop is STRIPPED
 *   runPipedreamAction()   → assert a real read returns non-empty data
 *   runPipedreamAction()   → again WITH a stray arg named like the app slug,
 *                            asserting it CANNOT clobber the credential binding
 *
 * Run from apps/api/:
 *   dotenvx run -- bun run scripts/e2e-pipedream-live.ts
 *   PD_APP=google_drive dotenvx run -- bun run scripts/e2e-pipedream-live.ts
 *   PD_APP=gmail PD_ACTION=gmail-find-email PD_ARGS='{"maxResults":3,"withTextPayload":true}' dotenvx run -- bun run scripts/e2e-pipedream-live.ts
 */
import {
  pipedreamConfigured,
  externalUserId,
  pipedreamConnectUrl,
  pipedreamListAccounts,
  pipedreamCatalog,
  runPipedreamAction,
} from '../src/executor/pipedream';
import { normalize } from '../src/executor/normalize';

const APP = (process.env.PD_APP ?? 'gmail').trim();
const SLUG = APP;
// A stable external-user key so re-runs reuse an existing authorization.
const PROJECT_KEY = process.env.PD_PROJECT_KEY ?? 'e2e-pipedream-live';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

/** Per-app default read action + args. Override with PD_ACTION / PD_ARGS. */
function defaultRead(app: string): { actionKey: string; args: Record<string, unknown> } | null {
  if (app === 'gmail') return { actionKey: 'gmail-find-email', args: { withTextPayload: true, maxResults: 3 } };
  if (app === 'google_drive') return { actionKey: 'google_drive-find-file', args: {} };
  return null;
}

async function main() {
  if (!pipedreamConfigured()) {
    console.error('Pipedream is not configured — set PIPEDREAM_CLIENT_ID / _SECRET / _PROJECT_ID (dotenvx .env).');
    process.exit(2);
  }

  const extUserId = externalUserId(PROJECT_KEY, SLUG);
  console.log(`\n▶ Live Pipedream e2e — app="${APP}", external_user_id="${extUserId}"\n`);

  // 1. Mint a real Connect link and have the human authorize.
  let accounts = await pipedreamListAccounts(extUserId).catch(() => []);
  if (!accounts.some((a) => a.app === APP)) {
    const { connectUrl, token } = await pipedreamConnectUrl(PROJECT_KEY, SLUG, APP, null);
    console.log('  No connected account yet. Authorize here, then come back:\n');
    console.log(`    ${connectUrl ?? '(no hosted link returned — token: ' + token + ')'}\n`);
    prompt('  Press Enter once you have finished authorizing in the browser…');
    accounts = await pipedreamListAccounts(extUserId);
  }
  const account = accounts.find((a) => a.app === APP);
  check(`connected account resolved for "${APP}"`, !!account, accounts);
  if (!account) { report(); return; }
  console.log(`  → account id: ${account.id} (${account.appName})\n`);

  // 2. Catalog: the account-selector prop must be stripped from every schema.
  const raw = await pipedreamCatalog(APP);
  const normalized = normalize({ provider: 'pipedream', app: APP, actions: raw });
  const leaks = normalized.filter((a) => {
    const props = (a.inputSchema as { properties?: Record<string, unknown> } | null)?.properties ?? {};
    return Object.prototype.hasOwnProperty.call(props, APP); // a prop named after the app slug = the leaked selector
  });
  check(`account-selector prop "${APP}" stripped from all ${normalized.length} tool schemas`, leaks.length === 0,
    leaks.map((a) => a.path));

  // 3. Real read → must return non-empty data (the original bug returned {}).
  const pick = process.env.PD_ACTION
    ? { actionKey: process.env.PD_ACTION, args: JSON.parse(process.env.PD_ARGS ?? '{}') }
    : defaultRead(APP);
  if (!pick) {
    console.log(`\n  ⚠ No default read action for "${APP}". Re-run with PD_ACTION + PD_ARGS. Catalog keys:`);
    for (const a of raw.slice(0, 40)) console.log(`     - ${a.key}`);
    report();
    return;
  }

  console.log(`\n  Calling ${pick.actionKey} with args ${JSON.stringify(pick.args)} …`);
  const res = await runPipedreamAction(PROJECT_KEY, SLUG, APP, pick.actionKey, pick.args, account.id, null);
  check('read call returned ok:true', res.ok === true, res);
  const nonEmpty = res.ok && res.data != null && !(typeof res.data === 'object' && Object.keys(res.data as object).length === 0);
  check('read call returned NON-EMPTY data (the bug returned {})', !!nonEmpty,
    typeof res.data === 'string' ? res.data.slice(0, 300) : res.data);

  // 4. Same call WITH a stray arg named like the slug — must still work (clobber-guard).
  console.log(`\n  Re-calling with a stray "${APP}": "me" arg (the exact thing that broke it before) …`);
  const res2 = await runPipedreamAction(
    PROJECT_KEY, SLUG, APP, pick.actionKey, { ...pick.args, [APP]: 'me' }, account.id, null,
  );
  check('stray slug-named arg does NOT break the credential binding', res2.ok === true, res2);

  report();
}

function report() {
  console.log(`\n${failed === 0 ? '✅ PASS' : '❌ FAIL'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n💥', e); process.exit(1); });
