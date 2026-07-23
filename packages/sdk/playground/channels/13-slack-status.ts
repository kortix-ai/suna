/**
 * 13 — Slack channel: read the installation status, mode, and app manifest.
 *
 * Channels are connectors now: everything goes through
 * `project(id).connectors.channels`, dispatched by platform.
 *
 * Connecting for real needs a Slack app (created from the manifest this
 * prints) — export SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET and re-run to
 * actually call `connect()`. Without them this is a safe read-only check.
 *
 * Run (from packages/sdk):  bun run playground/channels/13-slack-status.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";
import { getSlackManifest } from "../../src/index";

run("slack-status", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);
  const channels = kortix.project(projectId).connectors.channels;

  const installation = await channels.installation("slack");
  if (installation) {
    console.log("✓ Slack is connected:");
    console.log(`  ${JSON.stringify(installation).slice(0, 300)}`);
  } else {
    console.log("✓ installation('slack'): null — Slack not connected on this project");
  }

  const mode = await channels.mode("slack");
  console.log(`✓ mode('slack'): ${JSON.stringify(mode)}`);

  const botToken = process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (botToken && signingSecret) {
    const connected = await channels.connect("slack", {
      bot_token: botToken,
      signing_secret: signingSecret,
    });
    console.log(
      `✓ connect() succeeded: ${JSON.stringify(connected).slice(0, 300)}`,
    );
    return;
  }

  // The Slack app manifest is a PUBLIC scaffolding endpoint (not a channel
  // capability), so it's fetched with the standalone helper.
  const manifest = await getSlackManifest(projectId);
  console.log(
    "\nto connect: create a Slack app from this manifest, install it to your",
  );
  console.log(
    "workspace, then re-run with SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET set:\n",
  );
  console.log(JSON.stringify(manifest, null, 2).slice(0, 800));
});
