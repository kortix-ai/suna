import { getDaytona } from '../shared/daytona';

const externalId = Bun.argv[2];
if (!externalId) { console.error('usage: dump-opencode-schema.ts <external_id>'); process.exit(2); }

const cmd = String.raw`
D=/opt/kortix/home/.local/share/opencode/opencode.db
ls -la "$D" 2>&1 | head -1
echo "=== SCHEMA ==="
python3 - "$D" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
for (sql,) in c.execute("select sql from sqlite_master where sql is not null order by case type when 'table' then 0 else 1 end, name"):
    print(sql + ";\n")
print("=== TABLE ROW COUNTS ===")
for (n,) in c.execute("select name from sqlite_master where type='table' order by name"):
    try: print(f"{n}: {c.execute('select count(*) from ' + n).fetchone()[0]}")
    except Exception as e: print(f"{n}: ERR {e}")
PY
`;

const sb = await getDaytona().get(externalId);
const res = await sb.process.executeCommand(cmd, undefined, undefined, 60);
console.log((res as { result?: string }).result ?? JSON.stringify(res));
process.exit(0);
