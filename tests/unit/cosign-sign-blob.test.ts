import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT as repoRoot } from "../src/fixtures/repo";

const signer = join(repoRoot, "scripts/ci/cosign-sign-blob.sh");
const tempDirs: string[] = [];

// A fake `cosign sign-blob` that fails per COSIGN_TEST_MODE and writes the
// `--bundle` file only on the attempts that succeed (or "persist" the entry).
function runSigner(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "kortix-cosign-blob-test-"));
  tempDirs.push(dir);
  const attempts = join(dir, "attempts");
  writeFileSync(attempts, "0\n");
  const manifest = join(dir, "SHA256SUMS");
  writeFileSync(manifest, "abc  kortix\n");
  const cosign = join(dir, "cosign");
  writeFileSync(
    cosign,
    `#!/usr/bin/env bash
set -euo pipefail
bundle=""
while [ $# -gt 0 ]; do
  [ "$1" = "--bundle" ] && bundle="$2"
  shift
done
count="$(cat "$COSIGN_TEST_ATTEMPTS")"
count="$((count + 1))"
printf '%s\\n' "$count" > "$COSIGN_TEST_ATTEMPTS"
case "$COSIGN_TEST_MODE:$count" in
  transient-then-duplicate:1)
    echo 'Post "https://rekor.sigstore.dev/api/v1/log/entries": giving up after 2 attempt(s)' >&2
    exit 1
    ;;
  transient-then-duplicate:2)
    printf '{}' > "$bundle"
    echo '[409] createLogEntryConflict {"message":"an equivalent entry already exists in the transparency log"}' >&2
    exit 1
    ;;
  transient-forever:*)
    echo 'rekor.sigstore.dev: 503 temporarily unavailable' >&2
    exit 1
    ;;
  fatal:*)
    echo 'unauthorized: invalid identity' >&2
    exit 1
    ;;
  *)
    printf '{}' > "$bundle"
    exit 0
    ;;
esac
`,
  );
  chmodSync(cosign, 0o755);

  const result = spawnSync("bash", [signer, manifest], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      COSIGN_RETRY_DELAY_SECONDS: "0",
      COSIGN_TEST_ATTEMPTS: attempts,
      COSIGN_TEST_MODE: mode,
    },
  });

  return {
    ...result,
    attempts: Number.parseInt(readFileSync(attempts, "utf8").trim(), 10),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("keyless checksum-manifest signing", () => {
  it("signs on the first attempt", () => {
    const result = runSigner("ok");

    expect(result.status).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.stdout).toContain("✔ signed SHA256SUMS → SHA256SUMS.bundle");
  });

  it("retries a transient Rekor failure and accepts the duplicate entry", () => {
    const result = runSigner("transient-then-duplicate");

    expect(result.status).toBe(0);
    expect(result.attempts).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "equivalent Rekor entry already exists",
    );
  });

  it("gives up with cosign's status after the attempt budget", () => {
    const result = runSigner("transient-forever");

    expect(result.status).toBe(1);
    expect(result.attempts).toBe(3);
  });

  it("does not hide a non-Rekor signing failure", () => {
    const result = runSigner("fatal");

    expect(result.status).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.stderr).toContain("unauthorized: invalid identity");
  });
});
