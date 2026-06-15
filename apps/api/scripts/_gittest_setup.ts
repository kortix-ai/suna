import { createAccountToken } from '../src/repositories/account-tokens';
const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const tok = (await createAccountToken({ accountId: ACC, userId: ACC, name: 'gittest' })).secretKey;
const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const prov: any = await (await fetch('http://localhost:8008/v1/projects/provision', { method: 'POST', headers: H, body: JSON.stringify({ name: `gittest-${Date.now()}`, seed_starter: true }) })).json();
console.log('PID=' + prov.project_id);
console.log('TOK=' + tok);
process.exit(0);
