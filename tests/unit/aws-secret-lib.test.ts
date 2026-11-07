import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT as root } from "../src/fixtures/repo";

const lib = resolve(root, "infra/scripts/lib/aws-secret.sh");

// A fake `aws` that keeps each secret in <store>/<region>__<name>.json, logs
// the operation names, and implements only the secretsmanager calls the lib makes.
const fakeAws = `#!/usr/bin/env bash
set -euo pipefail
op="$2"; shift 2
region="" id="" description=""
while [ $# -gt 0 ]; do
  case "$1" in
    --region) region="$2"; shift 2 ;;
    --secret-id|--name) id="$2"; shift 2 ;;
    --description) description="$2"; shift 2 ;;
    *) shift ;;
  esac
done
file="$STORE/\${region}__\${id}.json"
echo "$op" >> "$STORE/ops.log"
case "$op" in
  describe-secret) [ -f "$file" ] ;;
  get-secret-value) cat "$file" ;;
  put-secret-value|create-secret) [ "\${FAIL_WRITE:-}" != 1 ] || exit 254 ;;&
  put-secret-value) cat > "$file" ;;
  create-secret) cat > "$file"; printf '%s' "$description" > "$file.description" ;;
esac
`;

function run(existing: boolean, failWrite = false) {
  const dir = mkdtempSync(join(tmpdir(), "aws-secret-lib-"));
  writeFileSync(join(dir, "aws"), fakeAws);
  chmodSync(join(dir, "aws"), 0o755);
  const file = join(dir, "eu-west-2__web-env.json");
  if (existing) writeFileSync(file, '{"OLD":"x"}');
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail; . "${lib}"; printf '%s' '{"API_KEY":"synthetic-value"}' | put_or_create_secret eu-west-2 web-env "Synthetic description"`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STORE: dir, FAIL_WRITE: failWrite ? "1" : "" },
    },
  );
  const read = (path: string) =>
    existsSync(path) ? readFileSync(path, "utf8") : undefined;
  return {
    result,
    value: read(file),
    description: read(`${file}.description`),
    ops: readFileSync(join(dir, "ops.log"), "utf8").trim().split("\n"),
  };
}

describe("put_or_create_secret", () => {
  it("writes a new version of an existing secret and reports updated", () => {
    const { result, value, description, ops } = run(true);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("updated");
    expect(value).toBe('{"API_KEY":"synthetic-value"}');
    expect(description).toBeUndefined();
    expect(ops).toEqual(["describe-secret", "put-secret-value"]);
    expect(result.stdout + result.stderr).not.toContain("synthetic-value");
  });

  it("creates a missing secret with the description and reports created", () => {
    const { result, value, description, ops } = run(false);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("created");
    expect(value).toBe('{"API_KEY":"synthetic-value"}');
    expect(description).toBe("Synthetic description");
    expect(ops).toEqual(["describe-secret", "create-secret"]);
    expect(result.stdout + result.stderr).not.toContain("synthetic-value");
  });

  it.each([true, false])(
    "fails without reporting success when the write fails (existing=%s)",
    (existing) => {
      const { result } = run(existing, true);

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toMatch(/updated|created/);
    },
  );

  it("keeps the failure visible inside a command substitution (copy-env-secret.sh)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-secret-copy-"));
    writeFileSync(join(dir, "aws"), fakeAws);
    chmodSync(join(dir, "aws"), 0o755);
    writeFileSync(join(dir, "us-east-2__src.json"), '{"A":"b"}');
    writeFileSync(join(dir, "eu-west-2__dst.json"), '{"A":"c"}');
    const result = spawnSync(
      "bash",
      [resolve(root, "infra/scripts/copy-env-secret.sh"), "src", "us-east-2", "eu-west-2", "--to-name", "dst"],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STORE: dir, FAIL_WRITE: "1" },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toMatch(/updated|created/);
  });
});
