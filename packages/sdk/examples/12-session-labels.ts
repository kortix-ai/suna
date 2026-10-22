/**
 * 12 — Classify sessions with labels and metadata, then render by them.
 *
 * Labels are a free-form list (each 1–64 characters, at most 20) the list
 * filters on server-side. Metadata is a free-form object for your own keys:
 * `update` merges keys, and a `null` value removes one.
 *
 * Run (creates one real session in the project):
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=<project-id> bun run examples/12-session-labels.ts
 *
 * As an npm consumer the only import line changes:
 *   import { createKortix } from '@kortix/sdk';
 */
import { createKortix, type ProjectSession } from '../src/index';

/** Render rule of a host app: gold-tier sessions get a badge, tickets a link. */
function describeSession(session: ProjectSession): string {
  const tier = session.labels?.includes('tier:gold') ? ' [gold]' : '';
  const ticket = typeof session.metadata.app_ticket === 'string' ? ` (${session.metadata.app_ticket})` : '';
  return `${session.name ?? session.session_id}${tier}${ticket} — ${(session.labels ?? []).join(', ')}`;
}

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const apiKey = process.env.KORTIX_API_KEY;
  const projectId = process.env.KORTIX_PROJECT_ID;
  if (!apiKey || !projectId) {
    console.error('Set KORTIX_API_KEY and KORTIX_PROJECT_ID and re-run.');
    process.exit(1);
  }
  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });
  const project = kortix.project(projectId);

  // Labels and metadata at create.
  const created = await project.sessions.create({
    initial_prompt: 'Summarize ticket T-142 in two sentences.',
    labels: ['support', 'tier:gold'],
    metadata: { app_ticket: 'T-142', app_priority: 2 },
  });

  // Later: replace the labels, drop one metadata key.
  const updated = await kortix
    .session(projectId, created.session_id)
    .update({ labels: ['support', 'tier:gold', 'triaged'], metadata: { app_priority: null } });
  console.log('updated:', describeSession(updated));

  // Server-side filter: sessions carrying EVERY label.
  const { items } = await project.sessions.listPage({ labels: ['support', 'triaged'] });
  for (const session of items) console.log(describeSession(session));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
