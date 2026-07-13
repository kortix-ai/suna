/**
 * 28 — the other channels: email installation/mode and the meeting bot's
 * voice catalog. All reads (13-slack-status covers Slack).
 *
 * Run (from packages/sdk):  bun run playground/channels/28-email-and-meet.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("email-and-meet", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);
  const channels = kortix.project(projectId).channels;

  const email = await channels.email.installation();
  console.log(`✓ email.installation(): ${JSON.stringify(email).slice(0, 250)}`);

  const emailMode = await channels.email.mode();
  console.log(`✓ email.mode(): ${JSON.stringify(emailMode).slice(0, 200)}`);

  const voices = await channels.meet.voices();
  console.log(`✓ meet.voices(): ${JSON.stringify(voices).slice(0, 250)}…`);
});
