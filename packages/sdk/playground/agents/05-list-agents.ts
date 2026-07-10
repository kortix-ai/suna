/**
 * 05 — what agents does the project have, and what is their config?
 *
 * Agents are config files in the repo (`.kortix/opencode/agents/*.md` here).
 * The platform surfaces them read-only through `projects.detail().config`,
 * and `getAgentConfig()` returns one agent's resolved opencode config.
 *
 * Run (from packages/sdk):  bun run playground/agents/05-list-agents.ts [projectId]
 */
import { getAgentConfig } from "../../src/index";
import { makeKortix, pickProjectId, run } from "../_shared";

run("list-agents", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);

  const detail = await kortix.projects.detail(projectId);
  const config = detail.config;

  console.log(`✓ agent discovery: ${config.agent_discovery}`);
  console.log(`✓ default agent:   ${config.open_code_default_agent ?? "—"}`);
  console.log(`✓ ${config.agents.length} agent(s):\n`);
  for (const agent of config.agents) {
    console.log(`  ${agent.name}${agent.mode ? ` (${agent.mode})` : ""}`);
    console.log(`    path: ${agent.path}`);
    if (agent.description)
      console.log(`    desc: ${agent.description.slice(0, 100)}`);
    console.log("");
  }

  const first = config.open_code_default_agent ?? config.agents[0]?.name;
  if (first) {
    const agentConfig = await getAgentConfig(projectId, first);
    console.log(`✓ getAgentConfig('${first}'):`);
    console.log(`  ${JSON.stringify(agentConfig).slice(0, 400)}…`);
  }
});
