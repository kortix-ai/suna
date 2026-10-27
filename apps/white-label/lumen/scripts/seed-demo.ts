// Seed the synthetic demo dataset into a firm: two matters, ten documents, through
// the same ingest path the Vault uses (no back door). Idempotent by matter name and filename.
//   bun scripts/seed-demo.ts [--firm <firmId>]      (default: the first ready firm)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminClient } from './convex-admin';

const DIST = join(import.meta.dir, '..', 'demo-data', 'dist');
const BW = { name: 'Brightwater Example Holdings Ltd', role: 'client' };

export const DEMO_MATTERS = [
  {
    name: 'Project Aster (acquisition)', client: BW.name, practiceArea: 'M&A',
    parties: [BW, { name: 'Aster Example Topco Ltd', role: 'counterparty' }, { name: 'Aster Example Systems Ltd', role: 'target' }],
    files: ['msa-brightwater-quillon.pdf', 'saas-agreement-lattice.docx', 'office-lease-cedar-row.pdf', 'spa-excerpt-aster.pdf',
      'supply-agreement-meridian.pdf', 'dpa-lattice.docx'],
  },
  {
    name: 'Quillon commercial', client: BW.name, practiceArea: 'Commercial',
    parties: [BW, { name: 'Quillon Analytics Inc.', role: 'counterparty' }],
    files: ['mutual-nda-quillon.docx', 'one-way-nda-harbor.pdf', 'employment-agreement-tarrow.docx', 'consulting-agreement-pell.txt'],
  },
];

const MIME: Record<string, string> = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain',
};

export async function seed(firmId?: string) {
  const c = adminClient();
  const firm = await c.query<{ _id: string; name: string } | null>('seed:firm', firmId ? { firmId } : {});
  if (!firm) throw new Error('no ready firm: sign up and finish onboarding first');
  const out: Record<string, { matterId: string; documents: Array<{ _id: string; filename: string; status: string; pages?: number; paras?: number }> }> = {};
  for (const m of DEMO_MATTERS) {
    const matterId = await c.mutation<string>('seed:matter', { firmId: firm._id, name: m.name, client: m.client, parties: m.parties, practiceArea: m.practiceArea });
    for (const f of m.files) {
      const uploadUrl = await c.mutation<string>('seed:uploadUrl');
      const res = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': MIME[f.split('.').pop()!] }, body: readFileSync(join(DIST, f)) });
      const { storageId } = (await res.json()) as { storageId: string };
      await c.mutation('seed:addDocument', { matterId, storageId, filename: f });
    }
    out[m.name] = { matterId, documents: [] };
  }
  // Wait for ingest (≤ 2 min).
  for (let i = 0; i < 60; i++) {
    let pending = 0;
    for (const [name, m] of Object.entries(out)) {
      m.documents = await c.query('seed:documents', { matterId: m.matterId });
      pending += m.documents.filter((d) => d.status === 'extracting' || d.status === 'uploading').length;
      if (i === 0) void name;
    }
    if (!pending) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { firm, matters: out };
}

if (import.meta.main) {
  const i = process.argv.indexOf('--firm');
  const t0 = Date.now();
  const r = await seed(i > 0 ? process.argv[i + 1] : undefined);
  console.log(`firm ${r.firm.name} (${r.firm._id}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const [name, m] of Object.entries(r.matters)) {
    console.log(`${name} ${m.matterId}`);
    for (const d of m.documents) console.log(`  ${d.status.padEnd(10)} ${String(d.pages ?? '-').padStart(2)} p ${String(d.paras ?? '-').padStart(3)} paras  ${d.filename}  ${d._id}`);
  }
}
