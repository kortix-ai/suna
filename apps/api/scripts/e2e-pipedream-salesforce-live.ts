#!/usr/bin/env bun
/**
 * LIVE end-to-end test of Pipedream named actions against REAL Pipedream + a
 * REAL connected Salesforce account — through the exact `runPipedreamAction`
 * path the gateway uses.
 *
 * What this pins: the credential must be bound under the component's REAL
 * app-prop name resolved from the component definition (`salesforce`), not the
 * app slug (`salesforce_rest_api`). Binding under the slug configures a
 * nonexistent prop, so the component runs with an EMPTY $auth and crashes in
 * its own code (`_subdomain()` TypeError) — the prod-wide named-action 502
 * incident of 2026-06-11. Salesforce is the regression app because its prop
 * name differs from its slug (gmail's matches, which is why gmail worked).
 *
 * Non-interactive: it expects the account to ALREADY be connected (it resolves
 * the account id from the external user id). Read-only by default; the
 * create→update→delete record cycle only runs with SF_WRITE=1 and cleans up
 * after itself.
 *
 * Run from apps/api/ (against the env that owns the connected account):
 *   KORTIX_URL=https://api.kortix.com dotenvx run -f .env.prod -- \
 *     SF_PROJECT_ID=<projectId> bun run scripts/e2e-pipedream-salesforce-live.ts
 *
 * Env:
 *   SF_PROJECT_ID   project whose salesforce connector to use (required)
 *   SF_SLUG         connector slug (default salesforce_rest_api)
 *   SF_WRITE=1      also run the create→update→delete Contact cycle
 */
import { externalUserId, pipedreamConfigured, pipedreamListAccounts, runPipedreamAction } from '../src/executor/pipedream';

const PROJECT_ID = (process.env.SF_PROJECT_ID ?? '').trim();
const SLUG = (process.env.SF_SLUG ?? 'salesforce_rest_api').trim();
const APP = 'salesforce_rest_api';
const WRITE = process.env.SF_WRITE === '1';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, detail !== undefined ? JSON.stringify(detail)?.slice(0, 500) : ''); }
}

async function run(actionKey: string, args: Record<string, unknown>, accountId: string) {
  return runPipedreamAction(PROJECT_ID, SLUG, APP, actionKey, args, accountId, null);
}

const text = (v: unknown) => JSON.stringify(v) ?? '';

async function main() {
  if (!pipedreamConfigured()) {
    console.error('Pipedream is not configured — run under dotenvx with PIPEDREAM_* set.');
    process.exit(2);
  }
  if (!PROJECT_ID) {
    console.error('SF_PROJECT_ID is required (the project with the connected salesforce connector).');
    process.exit(2);
  }

  const extUserId = externalUserId(PROJECT_ID, SLUG);
  console.log(`\n▶ Salesforce named-action live e2e — external_user_id="${extUserId}" write=${WRITE}\n`);

  const accounts = await pipedreamListAccounts(extUserId);
  const account = accounts.find((a) => a.app === APP);
  check('connected salesforce account resolved', !!account, accounts);
  if (!account) return report();
  console.log(`  → account: ${account.id} (${account.appName})\n`);

  // get_user_info — the call that started the incident. With the prop-name fix
  // the component returns the full identity (it crashed with empty $auth before).
  const user = await run('salesforce_rest_api-get-user-info', {}, account.id);
  const u = (user.data ?? {}) as Record<string, unknown>;
  check('get-user-info ok', user.ok === true, user);
  check('get-user-info has userId + orgId + instanceUrl', !!u.userId && !!u.orgId && !!u.instanceUrl, u);

  // get_current_user (older component, same $auth dependency).
  const cur = await run('salesforce_rest_api-get-current-user', {}, account.id);
  check('get-current-user ok', cur.ok === true, cur);

  // soql_query.
  const soql = await run('salesforce_rest_api-soql-query', { query: 'SELECT Id, Name FROM Account LIMIT 3' }, account.id);
  const soqlData = (soql.data ?? {}) as { records?: Array<{ Id?: string }> };
  check('soql-query ok with records[]', soql.ok === true && Array.isArray(soqlData.records), soql);

  // Malformed SOQL → the REAL salesforce error must surface (ok:false + cause), not a bare status.
  const bad = await run('salesforce_rest_api-soql-query', { query: 'SELECT FROM nothing' }, account.id);
  check('malformed soql → ok:false with the salesforce error text', bad.ok === false && /MALFORMED|unexpected|error/i.test(text(bad.data)), bad);

  // list_objects.
  const objs = await run('salesforce_rest_api-list-objects', { filter: 'account' }, account.id);
  check('list-objects(filter=account) includes Account', objs.ok === true && text(objs.data).includes('"Account"'), objs);

  // describe_object.
  const desc = await run('salesforce_rest_api-describe-object', { objectType: 'Opportunity', fieldsFilter: 'stage' }, account.id);
  check('describe-object(Opportunity, stage) returns StageName metadata', desc.ok === true && text(desc.data).includes('StageName'), desc);

  // text_search.
  const search = await run('salesforce_rest_api-text-search', { searchTerm: 'Acme' }, account.id);
  check('text-search ok', search.ok === true, search);

  // get_record_by_id + get_related_records, driven from a real account row.
  const firstId = soqlData.records?.[0]?.Id;
  if (firstId) {
    const byId = await run('salesforce_rest_api-get-record-by-id', { sobjectType: 'Account', recordId: firstId, fieldsToObtain: ['Id', 'Name'] }, account.id);
    check('get-record-by-id ok', byId.ok === true && text(byId.data).includes(firstId), byId);
    const related = await run('salesforce_rest_api-get-related-records', { objectType: 'Account', recordId: firstId, relationshipName: 'Contacts' }, account.id);
    check('get-related-records(Account→Contacts) ok', related.ok === true, related);
  }

  if (WRITE) {
    console.log('\n  Write cycle (create → update → delete a marked test Contact) …');
    const created = await run('salesforce_rest_api-create-crm-record', {
      objectType: 'Contact',
      properties: { LastName: 'Kortix E2E Test (safe to delete)', Email: 'e2e-test@kortix.ai' },
    }, account.id);
    const cd = (created.data ?? {}) as Record<string, unknown>;
    const newId = (cd.id ?? cd.Id ?? (cd.record as Record<string, unknown> | undefined)?.id) as string | undefined;
    check('create-crm-record ok with new record id', created.ok === true && !!newId, created);
    if (newId) {
      const updated = await run('salesforce_rest_api-update-crm-record', {
        objectType: 'Contact', recordId: newId, properties: { Email: 'e2e-test-updated@kortix.ai' },
      }, account.id);
      check('update-crm-record ok', updated.ok === true, updated);
      const deleted = await run('salesforce_rest_api-delete-crm-record', { objectType: 'Contact', recordId: newId }, account.id);
      check('delete-crm-record ok (cleanup)', deleted.ok === true, deleted);
    }
  } else {
    console.log('\n  (skipping write cycle — set SF_WRITE=1 to run create→update→delete)');
  }

  report();
}

function report() {
  console.log(`\n${failed === 0 ? '✅ PASS' : '❌ FAIL'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n💥', e); process.exit(1); });
