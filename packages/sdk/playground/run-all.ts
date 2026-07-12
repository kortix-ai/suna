/**
 * Run EVERY playground script in order, in one go, with a summary table.
 *
 * - Creates ONE session up front and pins it via KORTIX_SESSION_ID, so the
 *   five sandbox scripts (04, 06, 07, 09, 11) share a single boot.
 * - Defaults KORTIX_MODEL to claude-sonnet-4.6 when unset (the local stack's
 *   default model currently 400s on `max_tokens`).
 * - Keeps going after a failure; exits 1 if anything failed.
 * - Skipped on purpose: 14-change-default-model (mutates the project's
 *   default model — run it deliberately) and full-flow.ts (duplicates 01+03+04).
 *
 * Run (from packages/sdk):  bun run playground/run-all.ts
 */
import { makeKortix, pickProjectId, run } from "./_shared";

const SCRIPTS = [
  "projects/01-list-projects.ts",
  "sessions/02-list-sessions.ts",
  "sessions/03-create-session.ts",
  "chat/04-send-and-stream.ts",
  "agents/05-list-agents.ts",
  "agents/06-create-agent.ts",
  "agents/07-use-agent.ts",
  "skills/08-list-skills.ts",
  "skills/09-create-skill.ts",
  "commands/10-list-commands.ts",
  "commands/11-create-command.ts",
  "env/12-env-and-secrets.ts",
  "channels/13-slack-status.ts",
  "accounts/15-accounts-and-tokens.ts",
  "billing/16-billing.ts",
  "gateway/17-gateway-observability.ts",
  "marketplace/18-marketplace.ts",
  "connectors/19-connectors.ts",
  "access/20-access-and-policies.ts",
  "git/21-files-and-git.ts",
  "review/22-review-and-changes.ts",
  "sandbox/23-sandbox.ts",
  "triggers/24-triggers.ts",
  "apps/25-apps.ts",
  "audit/26-audit.ts",
  "session-extras/27-session-lifecycle.ts",
  "channels/28-email-and-meet.ts",
  "github/29-github.ts",
  "sessions/30-session-crud.ts",
  "session-extras/31-files-deep.ts",
  "env/32-personal-secrets.ts",
  "projects/33-models-and-search.ts",
  "server/34-server-scoped.ts",
  "session-extras/35-shares.ts",
];

run("run-all", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix);

  const model = process.env.KORTIX_MODEL ?? "claude-sonnet-4.6";
  if (!process.env.KORTIX_MODEL) {
    console.log(
      `KORTIX_MODEL not set — defaulting to ${model} (local gateway bug workaround)`,
    );
  }

  let sessionId = process.env.KORTIX_SESSION_ID;
  if (!sessionId) {
    const created = await kortix.projects.createSession(projectId, {
      name: "sdk run-all",
    });
    sessionId = created.session_id;
    console.log(
      `created shared session ${sessionId} — the sandbox scripts will all use it`,
    );
  }

  const results: Array<{ script: string; exit: number; seconds: number }> = [];
  for (const script of SCRIPTS) {
    console.log(`\n${"═".repeat(60)}\n▶ ${script}\n`);
    const startedAt = Date.now();
    const proc = Bun.spawn(["bun", "run", `playground/${script}`], {
      env: {
        ...process.env,
        KORTIX_PROJECT_ID: projectId,
        KORTIX_SESSION_ID: sessionId,
        KORTIX_MODEL: model,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    const exit = await proc.exited;
    results.push({
      script,
      exit,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
  }

  console.log(`\n${"═".repeat(60)}\nSUMMARY\n`);
  for (const r of results) {
    console.log(
      `  ${r.exit === 0 ? "✓" : "✗"} ${r.script.padEnd(34)} ${String(r.seconds).padStart(4)}s${r.exit !== 0 ? ` (exit ${r.exit})` : ""}`,
    );
  }
  console.log(
    "  – chat/14-change-default-model.ts     skipped (mutates the project default — run deliberately)",
  );
  console.log(
    "  – full-flow.ts                        skipped (duplicates 01+03+04)",
  );

  const failed = results.filter((r) => r.exit !== 0);
  console.log(
    `\n${failed.length === 0 ? "✓ all" : `✗ ${failed.length} of`} ${results.length} scripts ${failed.length === 0 ? "passed" : "FAILED"}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
});
