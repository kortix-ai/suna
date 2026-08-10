import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./publish-npm-package.sh", import.meta.url),
);

function run(requireAuth) {
  const env = {
    ...process.env,
    VERSION: "0.0.0-test",
    REQUIRE_NPM_AUTH: requireAuth ? "1" : "0",
  };
  delete env.NODE_AUTH_TOKEN;
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  return spawnSync("bash", [script], { env, encoding: "utf8" });
}

const required = run(true);
if (
  required.status !== 1 ||
  !required.stdout.includes("required publication cannot continue")
) {
  console.error(required.stdout);
  console.error(required.stderr);
  throw new Error(
    "Required npm publication must fail closed when auth is unavailable",
  );
}

const optional = run(false);
if (optional.status !== 0 || !optional.stdout.includes("skipping publish")) {
  console.error(optional.stdout);
  console.error(optional.stderr);
  throw new Error(
    "Optional local npm publication must retain the no-auth skip behavior",
  );
}

console.log("publish-npm-package.test: 2 assertions passed");
