/**
 * Step 5 — change the model, with a typesafe model picker.
 *
 * Changes the workspace default model via `workspace.modelDefaults.set(...)`,
 * then re-reads the defaults and asserts the change stuck. Every new session
 * in the workspace resolves to this model unless a prompt overrides it.
 *
 * Model selection is compile-time safe: `ManagedModelId` is a literal union,
 * so a typo like 'claude-opus-4.9' is a type error, not a 400 at runtime.
 * The catalog types model ids as plain `string` (it is generated data), so
 * the union is pinned here and cross-checked against `MANAGED_MODELS` — the
 * set the gateway actually serves — before anything talks to the API.
 *
 * Workspace selection: argv[3] → KORTIX_WORKSPACE_ID → deprecated KORTIX_PROJECT_ID.
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *     bun run playground/chat/14-change-default-model.ts glm-5.2 [workspaceId]
 *
 * As an npm consumer, the import lines change to:
 *   import { createKortix } from '@kortix/sdk';
 *   import { MANAGED_MODELS } from '@kortix/llm-catalog';
 */
import { MANAGED_MODELS } from "@kortix/llm-catalog";

import { createKortix } from "../../src/index";

const MODEL_IDS = ["glm-5.2", "deepseek-v4-flash"] as const;

type ManagedModelId = (typeof MODEL_IDS)[number];

function isPinnedModelId(input: string): input is ManagedModelId {
  return (MODEL_IDS as readonly string[]).includes(input);
}

/** The shape `session.setModel(...)` and `session.send(text, { model })` take. */
function toSessionModel(modelID: ManagedModelId) {
  return { providerID: "kortix", modelID } as const;
}

function assertCatalogInSync() {
  const catalogIds = MANAGED_MODELS.map((m) => m.id).sort();
  const pinnedIds = [...MODEL_IDS].sort();
  if (JSON.stringify(catalogIds) !== JSON.stringify(pinnedIds)) {
    console.error(
      "✗ MODEL_IDS is out of sync with MANAGED_MODELS (@kortix/llm-catalog):",
    );
    console.error(`  catalog: ${catalogIds.join(", ")}`);
    console.error(`  pinned:  ${pinnedIds.join(", ")}`);
    process.exit(1);
  }
}

function printModelMenu() {
  console.error("pick one of:");
  for (const model of MANAGED_MODELS) {
    console.error(`  ${model.id.padEnd(18)} ${model.name} (${model.tier})`);
  }
}

async function main() {
  assertCatalogInSync();

  const backendUrl = process.env.KORTIX_API_URL ?? "http://localhost:8008/v1";
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) {
    console.error(
      "Set KORTIX_API_KEY (mint one: user settings → API keys → Create API key).",
    );
    process.exit(1);
  }

  const requested = process.argv[2];
  if (!requested || !isPinnedModelId(requested)) {
    console.error(
      requested ? `✗ unknown model: ${requested}` : "✗ no model given",
    );
    printModelMenu();
    process.exit(1);
    return;
  }
  const model: ManagedModelId = requested;

  const workspaceId =
    process.argv[3] ?? process.env.KORTIX_WORKSPACE_ID ?? process.env.KORTIX_PROJECT_ID;
  if (!workspaceId) {
    console.error(
      "✗ no workspace given — pass argv[3] or set KORTIX_WORKSPACE_ID",
    );
    process.exit(1);
    return;
  }

  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });
  const workspace = kortix.workspace(workspaceId);

  const before = await workspace.modelDefaults.get();
  if (before.freeTier) {
    console.warn(
      "⚠ account is free-tier — the gateway may reject managed models",
    );
  }
  console.log(
    `current: workspace=${before.workspaceDefault ?? "(unset)"} account=${before.accountDefault ?? "(unset)"} platform=${before.platformDefault}`,
  );
  console.log(
    `resolved for this workspace: ${before.resolvedForCaller ?? "(none)"} · source: ${before.resolvedSource ?? "n/a"}`,
  );

  await workspace.modelDefaults.set({ scope: "workspace", model });
  console.log(`✓ set workspace default → ${model}`);

  const after = await workspace.modelDefaults.get();
  if (after.workspaceDefault !== model) {
    console.error(
      `✗ step 5 FAILED — re-read workspaceDefault is ${after.workspaceDefault ?? "(unset)"}, expected ${model}`,
    );
    process.exit(1);
  }
  console.log(
    `✓ re-read defaults — workspaceDefault is ${after.workspaceDefault}, resolves via '${after.resolvedSource ?? "workspace"}'`,
  );

  console.log("\nper-session override (paste into step 4 before send):");
  console.log(`  session.setModel(${JSON.stringify(toSessionModel(model))})`);
  console.log(
    `  // or one-shot: session.send(prompt, { model: ${JSON.stringify(toSessionModel(model))} })`,
  );
}

main().catch((error) => {
  console.error("✗ step 5 FAILED");
  console.error(error);
  process.exit(1);
});
