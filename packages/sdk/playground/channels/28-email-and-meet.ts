/**
 * 28 — the other channels: email installation/mode and the meeting bot's
 * voice catalog. All reads (13-slack-status covers Slack).
 *
 * Channels are connectors now: `project(id).connectors.channels`, dispatched
 * by platform. Runtime actions (like the meet voice catalog) go through
 * `.action(platform, name, input, method)`.
 *
 * Run (from packages/sdk):  bun run playground/channels/28-email-and-meet.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("email-and-meet", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);
  const channels = kortix.project(projectId).connectors.channels;

  const email = await channels.installation("email");
  console.log(`✓ installation('email'): ${JSON.stringify(email).slice(0, 250)}`);

  const emailMode = await channels.mode("email");
  console.log(`✓ mode('email'): ${JSON.stringify(emailMode).slice(0, 200)}`);

  const voices = await channels.action("meet", "voices", undefined, "get");
  console.log(`✓ action('meet','voices'): ${JSON.stringify(voices).slice(0, 250)}…`);
});
