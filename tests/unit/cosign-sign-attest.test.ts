import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "../..");
const signer = join(repoRoot, "scripts/ci/cosign-sign-attest.sh");
const workflow = join(repoRoot, ".github/workflows/deploy-dev.yml");
const tempDirs: string[] = [];

function runSigner(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "kortix-cosign-test-"));
  tempDirs.push(dir);
  const attempts = join(dir, "attempts");
  writeFileSync(attempts, "0\n");
  const cosign = join(dir, "cosign");
  writeFileSync(
    cosign,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "sign" ]; then
  exit 0
fi
count="$(cat "$COSIGN_TEST_ATTEMPTS")"
count="$((count + 1))"
printf '%s\\n' "$count" > "$COSIGN_TEST_ATTEMPTS"
case "$COSIGN_TEST_MODE:$count" in
  transient-then-duplicate:1)
    echo 'Post "https://rekor.sigstore.dev/api/v1/log/entries": giving up after 2 attempt(s)' >&2
    exit 1
    ;;
  transient-then-duplicate:2)
    echo '[409] createLogEntryConflict {"message":"an equivalent entry already exists in the transparency log"}' >&2
    exit 1
    ;;
  fatal:*)
    echo 'unauthorized: invalid identity' >&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`,
  );
  chmodSync(cosign, 0o755);

  const result = spawnSync(
    "bash",
    [signer, "kortix/example@sha256:abc", "sbom.json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        COSIGN_RETRY_DELAY_SECONDS: "0",
        COSIGN_TEST_ATTEMPTS: attempts,
        COSIGN_TEST_MODE: mode,
      },
    },
  );

  return {
    ...result,
    attempts: Number.parseInt(readFileSync(attempts, "utf8").trim(), 10),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("keyless image signing", () => {
  it("treats a duplicate Rekor entry after a transient failure as idempotent success", () => {
    const result = runSigner("transient-then-duplicate");

    expect(result.status).toBe(0);
    expect(result.attempts).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "equivalent Rekor entry already exists",
    );
  });

  it("does not hide a non-Rekor signing failure", () => {
    const result = runSigner("fatal");

    expect(result.status).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.stderr).toContain("unauthorized: invalid identity");
  });

  it("routes the Dev supply-chain gate through the retry-safe signer", () => {
    const yaml = readFileSync(workflow, "utf8");
    const supplyChain = yaml.slice(
      yaml.indexOf("  supply-chain:"),
      yaml.indexOf("  migrate-db:"),
    );

    expect(yaml).toContain(
      'bash scripts/ci/cosign-sign-attest.sh "$REF" sbom.spdx.json',
    );
    expect(yaml).not.toContain("cosign attest --yes --type spdxjson");
    expect(supplyChain).toContain("uses: actions/checkout@v7");
    expect(supplyChain.indexOf("uses: actions/checkout@v7")).toBeLessThan(
      supplyChain.indexOf("bash scripts/ci/cosign-sign-attest.sh"),
    );
  });

  it("pins buildx before resolving the digest the signer attests", () => {
    // The runner image's bundled buildx is not a contract: on Blacksmith's
    // ubuntu-2404 image `imagetools inspect --format` returned the human
    // listing (run 32905182332), the digest step failed, and SBOM + signing
    // were skipped for that dev image.
    const yaml = readFileSync(workflow, "utf8");
    const supplyChain = yaml.slice(
      yaml.indexOf("  supply-chain:"),
      yaml.indexOf("  migrate-db:"),
    );
    const buildx = supplyChain.indexOf("uses: docker/setup-buildx-action@v4");
    const resolve = supplyChain.indexOf("imagetools inspect \"$IMAGE\" --format '{{.Manifest.Digest}}'");
    expect(buildx).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(-1);
    expect(buildx).toBeLessThan(resolve);
  });
});
