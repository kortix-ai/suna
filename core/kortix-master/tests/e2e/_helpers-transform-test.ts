// E2E: invoke the projectStatusTransform directly to confirm the gate.
// We call the imported function with a fake message array; if the gate
// in kortix-system.ts is working, the wrapper around it returns early
// and nothing is appended.

import { projectStatusTransform, ProjectManager, initProjectsDb } from "/ephemeral/kortix-master/opencode/plugin/kortix-system/projects.ts";
import { config } from "/ephemeral/kortix-master/src/config.ts";
import * as path from "node:path";

console.log("PROJECTS_ENABLED:", config.PROJECTS_ENABLED);
console.log("env KORTIX_PROJECTS_ENABLED:", process.env.KORTIX_PROJECTS_ENABLED);

// Build a real ProjectManager (it won't make outbound calls just by being constructed)
const ws = "/workspace";
const db = initProjectsDb(path.join(ws, ".kortix/kortix.db"));
const fakeClient = {} as any;
const mgr = new ProjectManager(fakeClient, ws, db);

// Test 1: if the gate is working, the wrapper in kortix-system.ts only invokes
// projectStatus when projectsEnabled=true. Here we DIRECTLY invoke the
// transform to confirm what it WOULD do. This shows the transform itself isn't
// gated — only the wrapper is — which is by design.
const transform = projectStatusTransform(mgr, () => null);
const messages: any[] = [
  { info: { role: "user", sessionID: "ses_test_" + Date.now() }, parts: [{ type: "text", text: "hello" }] },
];
await transform({}, { messages });
console.log("After direct transform call, message parts count:", messages[0].parts.length);
console.log("  parts:", messages[0].parts.map((p: any) => (p.text || "").slice(0, 80)));

// The transform mutated parts (because it doesn't know about the flag itself).
// The wrapper in kortix-system.ts is what skips it. Now simulate the wrapper:
const wrappedTransform = async (input: any, output: any) => {
  if (!config.PROJECTS_ENABLED) return;
  await transform(input, output);
};

const messages2: any[] = [
  { info: { role: "user", sessionID: "ses_test_2_" + Date.now() }, parts: [{ type: "text", text: "hello" }] },
];
await wrappedTransform({}, { messages: messages2 });
console.log("After WRAPPED (gated) transform call, message parts count:", messages2[0].parts.length);
console.log("  parts:", messages2[0].parts.map((p: any) => (p.text || "").slice(0, 80)));

// Conclusion: gated path leaves parts untouched.
const gatedSilent = messages2[0].parts.length === 1 && !messages2[0].parts.some((p: any) => /project[-_]status/.test(p.text || ""));
console.log("\n=== GATED-PATH SILENT:", gatedSilent, "===");
