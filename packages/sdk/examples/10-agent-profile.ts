/**
 * 10 — Stage an agent-profile instruction draft and search published knowledge.
 *
 * The draft update uses optimistic concurrency. It does not publish or merge.
 * Session knowledge search derives its agent from the authenticated session.
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=... KORTIX_AGENT_NAME=researcher \
 *   KORTIX_AGENT_INSTRUCTIONS="Answer with cited evidence." \
 *   KORTIX_SESSION_ID=... \
 *     bun run examples/10-agent-profile.ts "What is the refund policy?"
 *
 * As an npm consumer:
 *   import { createKortix } from '@kortix/sdk';
 */
import { createKortix } from "../src/index";

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? "http://localhost:8008/v1";
  const apiKey = process.env.KORTIX_API_KEY;
  const projectId = process.env.KORTIX_PROJECT_ID;
  const agentName = process.env.KORTIX_AGENT_NAME;
  const instructions = process.env.KORTIX_AGENT_INSTRUCTIONS;
  const automationToPause = process.env.KORTIX_AUTOMATION_TO_PAUSE;
  const sessionId = process.env.KORTIX_SESSION_ID;
  const query = process.argv[2];

  if (!apiKey || !projectId || !agentName) {
    console.error(
      "Set KORTIX_API_KEY, KORTIX_PROJECT_ID, and KORTIX_AGENT_NAME.",
    );
    process.exit(1);
  }

  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });
  const profile = kortix.project(projectId).agents.profile(agentName);
  const current = await profile.get();

  console.log(
    `${agentName}: ${current.status}; revision ${current.revision}; ` +
      `${current.draft?.changed_sections.length ?? 0} changed section(s)`,
  );

  if (instructions) {
    const sections = current.draft?.sections ?? current.sections;
    const draft = await profile.updateDraft({
      expectedRevision: current.revision,
      sections: {
        ...sections,
        instructions: {
          ...sections.instructions,
          prompt: instructions,
        },
      },
    });
    const preview = await profile.preview();
    console.log(
      `Staged revision ${draft.revision}; risk ${draft.highest_risk}; ` +
        `${preview.changes.length} deterministic change(s)`,
    );
  }

  if (automationToPause) {
    const paused = await profile.pauseAutomation(automationToPause);
    console.log(
      `Paused ${paused.slug}; cancelled ${paused.cancelled_executions} queued execution(s)`,
    );
  }

  if (sessionId && query) {
    const session = kortix.session(projectId, sessionId);
    const result = await session.knowledge.search({ query });
    console.log(
      `Knowledge mode: ${result.mode}; ${result.results.length} result(s)`,
    );

    const first = result.results[0];
    if (first) {
      const passage = await session.knowledge.read(first.citation.citation_id);
      console.log(`[${passage.citation.source_title}] ${passage.content}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
