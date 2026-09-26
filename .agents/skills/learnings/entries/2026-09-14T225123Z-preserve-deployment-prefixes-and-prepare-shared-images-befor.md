---
recorded: 2026-09-14T22:51:23Z
incident_date: 2026-09-14
commit: 95f49b7a8f
---
# Preserve deployment prefixes and prepare shared images before timed preview flows

**When:** running the full suite on a self-hosted preview. Preserve the gateway's
`/_gateway` mount when binding test credentials. Enable every tested page in the
preview profile. Finish the cold default-image build before runtime flow timers;
run forced shared-image rebuilds only after concurrent flows finish. Require the
current template identity to be ready; fallback images carry an older daemon.
*Incident:* PR #7240 preview run 34902478412: four gateway failures and seven
runtime timeouts; `SNAP-2` deleted the shared image while sessions were booting.
*Enforcers:* `client-ci-passthrough.test.ts`, `preview-stack.test.ts`, runner sandbox
setup, and `SNAP-2` global scheduling. Vercel analytics also mounts only on Vercel.
