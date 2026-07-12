/**
 * 07 — change the agent: send a message handled by a SPECIFIC agent.
 *
 * The session handle takes a per-send `{ agent }` override (there is also a
 * sticky `session.setAgent(name)`). Agent names come from
 * `projects.detail().config.agents` — script 05 lists them.
 *
 * Run (from packages/sdk):
 *   KORTIX_MODEL=claude-sonnet-4.6 bun run playground/agents/07-use-agent.ts [agentName]
 */
import {
  makeKortix,
  modelOverride,
  pickOrCreateSessionId,
  pickProjectId,
  reportTurn,
  run,
  sendAndWait,
} from "../_shared";

run("use-agent", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix);

  const detail = await kortix.projects.detail(projectId);
  const agents = detail.config.agents.map((a) => a.name);
  const agent =
    process.argv[2] ?? detail.config.open_code_default_agent ?? agents[0];
  if (!agent) {
    console.error("project has no agents — run 05-list-agents to inspect");
    process.exit(1);
  }
  if (!agents.includes(agent)) {
    console.warn(
      `note: '${agent}' is not in the discovered list [${agents.join(", ")}]`,
    );
  }
  console.log(`✓ using agent: ${agent} (available: ${agents.join(", ")})`);

  const sessionId = await pickOrCreateSessionId(
    kortix,
    projectId,
    `sdk agent ${agent}`,
  );
  const session = kortix.session(projectId, sessionId);

  const turn = await sendAndWait(
    session,
    "In one sentence, which agent are you?",
    {
      agent,
      model: modelOverride(),
    },
  );
  reportTurn(`use-agent (${agent})`, turn);
});
