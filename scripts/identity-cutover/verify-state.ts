/** Compare the committed cutover with its row-count ledger. Read-only. */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

type Pair = { old_id: string; new_id: string; email: string };
type Result = { email: string; before: Record<string, number> };
const pairsPath = process.argv.find(x => x.startsWith('--pairs='))?.slice(8);
const ledgerPath = process.argv.find(x => x.startsWith('--ledger='))?.slice(9);
if (!pairsPath || !ledgerPath || !process.env.DATABASE_URL) throw Error('Pass --pairs and --ledger with DATABASE_URL');
const pairs: Pair[] = JSON.parse(readFileSync(pairsPath, 'utf8'));
const ledger: { mode: string; pairs: Result[] } = JSON.parse(readFileSync(ledgerPath, 'utf8'));
if (ledger.mode !== 'applied' || pairs.length !== ledger.pairs.length) throw Error('Invalid apply ledger');

const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'identity-cutover-verify' });
await client.connect();
async function count(sql: string, id: string): Promise<number> {
  return Number((await client.query(sql, [id])).rows[0]?.count ?? 0);
}
try {
  for (const pair of pairs) {
    const expected = ledger.pairs.find(x => x.email === pair.email);
    if (!expected) throw Error(`Missing ledger entry: ${pair.email}`);
    const queries = {
      sessions: 'SELECT count(*) FROM kortix.project_sessions WHERE created_by=$1::uuid',
      session_grants: "SELECT count(*) FROM kortix.project_session_grants WHERE principal_type='member' AND principal_id=$1::uuid",
      session_tokens: 'SELECT count(*) FROM kortix.account_tokens WHERE user_id=$1::uuid AND session_id IS NOT NULL',
      memberships: 'SELECT count(*) FROM kortix.account_memberships WHERE user_id=$1::uuid',
      scim_records: 'SELECT count(*) FROM kortix.account_scim_users WHERE user_id=$1::uuid',
      roles: "SELECT count(*) FROM kortix.role_assignments WHERE principal_type='user' AND principal_id=$1::uuid",
      groups: 'SELECT count(*) FROM kortix.group_members WHERE user_id=$1::uuid',
    };
    const result: Record<string, { old: number; sso: number }> = {};
    for (const [name, sql] of Object.entries(queries)) {
      const old = await count(sql, pair.old_id);
      const sso = await count(sql, pair.new_id);
      if (old !== 0) throw Error(`${pair.email}: ${old} old ${name} rows remain`);
      const transferred = pair.email === 'uvanajarenukaprasad@libremax.com' && name === 'groups'
        ? 0 : (expected.before[name] ?? 0);
      if (sso < transferred) throw Error(`${pair.email}: ${name} SSO count ${sso} below transferred ${transferred}`);
      result[name] = { old, sso };
    }
    if (pair.email === 'uvanajarenukaprasad@libremax.com' && (result.memberships.sso !== 0 || result.groups.sso !== 0 || result.roles.sso !== 0)) {
      throw Error('Deprovisioned user regained access');
    }
    console.log(JSON.stringify({ email: pair.email, result }));
  }
} finally {
  await client.end();
}
