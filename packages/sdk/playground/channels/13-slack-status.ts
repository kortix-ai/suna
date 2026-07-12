/**
 * 13 — Slack channel: read the installation status, mode, and app manifest.
 *
 * Connecting for real needs a Slack app (created from the manifest this
 * prints) — export SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET and re-run to
 * actually call `connect()`. Without them this is a safe read-only check.
 *
 * Run (from packages/sdk):  bun run playground/channels/13-slack-status.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("slack-status", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);
  const slack = kortix.project(projectId).channels.slack;

  const installation = await slack.installation();
  if (installation) {
    console.log("✓ Slack is connected:");
    console.log(`  ${JSON.stringify(installation).slice(0, 300)}`);
  } else {
    console.log("✓ installation(): null — Slack not connected on this project");
  }

  const mode = await slack.mode();
  console.log(`✓ mode(): ${JSON.stringify(mode)}`);

  const botToken = process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (botToken && signingSecret) {
    const connected = await slack.connect({
      bot_token: botToken,
      signing_secret: signingSecret,
    });
    console.log(
      `✓ connect() succeeded: ${JSON.stringify(connected).slice(0, 300)}`,
    );
    return;
  }

  const manifest = await slack.manifest();
  console.log(
    "\nto connect: create a Slack app from this manifest, install it to your",
  );
  console.log(
    "workspace, then re-run with SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET set:\n",
  );
  console.log(JSON.stringify(manifest, null, 2).slice(0, 800));
});
