/**
 * 17 — LLM gateway observability: cost/latency overview, time series,
 * per-model breakdown, per-session rollup, error rollup, recent request
 * logs, budgets, and gateway API keys. All reads.
 *
 * Run (from packages/sdk):  bun run playground/gateway/17-gateway-observability.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("gateway-observability", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);
  const gateway = kortix.project(projectId).gateway;

  const overview = await gateway.overview(7);
  console.log(`✓ overview(7d): ${JSON.stringify(overview).slice(0, 250)}…`);

  const series = await gateway.series(7);
  console.log(
    `✓ series(7d): ${JSON.stringify(series).length} bytes of time-series data`,
  );

  const breakdown = await gateway.breakdown(7);
  console.log(`✓ breakdown(7d): ${JSON.stringify(breakdown).slice(0, 250)}…`);

  const sessions = await gateway.sessions(7);
  console.log(`✓ sessions(7d): ${JSON.stringify(sessions).slice(0, 200)}…`);

  const errors = await gateway.errors(7);
  console.log(`✓ errors(7d): ${JSON.stringify(errors).slice(0, 250)}…`);

  const logs = await gateway.logs({ limit: 5 });
  console.log(`✓ logs(limit 5): ${JSON.stringify(logs).slice(0, 250)}…`);

  const budgets = await gateway.budgets();
  console.log(`✓ budgets(): ${JSON.stringify(budgets).slice(0, 200)}`);

  const keys = await gateway.keys();
  console.log(`✓ keys(): ${JSON.stringify(keys).slice(0, 200)}`);
});
