import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const targetSmoke = readFileSync(
  new URL("./target-smoke.sh", import.meta.url),
  "utf8",
);
const frontendSmoke = readFileSync(
  new URL("./frontend-auth-smoke.sh", import.meta.url),
  "utf8",
);
const shadowWorkflow = readFileSync(
  new URL(
    "../../.github/workflows/deploy-prod-us-east-2-shadow.yml",
    import.meta.url,
  ),
  "utf8",
);

test("shadow smokes can bypass the production custom domain before cutover", () => {
  assert.match(
    targetSmoke,
    /TARGET_SUPABASE_URL="\$\{TARGET_SUPABASE_URL_OVERRIDE:-\$\(/,
  );
  assert.match(
    frontendSmoke,
    /target_supabase_url="\$\{TARGET_SUPABASE_URL_OVERRIDE:-\$\(/,
  );
  assert.equal(
    shadowWorkflow.match(
      /TARGET_SUPABASE_URL_OVERRIDE="https:\/\/uhrwvisbqjfxhxjvoofd\.supabase\.co"/g,
    )?.length,
    2,
  );
});
