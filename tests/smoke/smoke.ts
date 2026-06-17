#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const API_BASE_URL = (process.env.API_BASE_URL ?? "http://localhost:8008/v1").replace(/\/+$/, "");
const ORIGIN = API_BASE_URL.replace(/\/v1$/, "");
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 10000);
const JUNIT_PATH = resolve(
  process.env.SMOKE_JUNIT ?? resolve(import.meta.dir, "../test-results/smoke/junit.xml"),
);

interface Check {
  name: string;
  url: string;
  assert: (res: Response, body: string) => void;
}

interface CheckResult {
  name: string;
  url: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

const checks: Check[] = [
  {
    name: "GET /health is alive",
    url: `${ORIGIN}/health`,
    assert: (res, body) => {
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const json = JSON.parse(body);
      if (json.status !== "ok") throw new Error(`expected status "ok", got ${JSON.stringify(json.status)}`);
    },
  },
  {
    name: "GET /v1/health is alive",
    url: `${API_BASE_URL}/health`,
    assert: (res) => {
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    },
  },
  {
    name: "GET /v1/openapi.json is served",
    url: `${API_BASE_URL}/openapi.json`,
    assert: (res, body) => {
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const json = JSON.parse(body);
      if (!json.openapi && !json.paths) throw new Error("response is not an OpenAPI document");
    },
  },
  {
    name: "GET /v1/system/maintenance (public route)",
    url: `${API_BASE_URL}/system/maintenance`,
    assert: (res) => {
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    },
  },
];

async function runCheck(check: Check): Promise<CheckResult> {
  const start = performance.now();
  try {
    const res = await fetch(check.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    check.assert(res, body);
    return { name: check.name, url: check.url, ok: true, durationMs: performance.now() - start };
  } catch (err) {
    return {
      name: check.name,
      url: check.url,
      ok: false,
      durationMs: performance.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function writeJunit(results: CheckResult[]): void {
  const failures = results.filter((r) => !r.ok).length;
  const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0) / 1000;
  const cases = results
    .map((r) => {
      const time = (r.durationMs / 1000).toFixed(3);
      if (r.ok) {
        return `    <testcase classname="smoke" name="${escapeXml(r.name)}" time="${time}"/>`;
      }
      return [
        `    <testcase classname="smoke" name="${escapeXml(r.name)}" time="${time}">`,
        `      <failure message="${escapeXml(r.error ?? "failed")}">${escapeXml(`${r.url}\n${r.error ?? ""}`)}</failure>`,
        `    </testcase>`,
      ].join("\n");
    })
    .join("\n");
  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="smoke" tests="${results.length}" failures="${failures}" time="${totalTime.toFixed(3)}">`,
    `  <testsuite name="smoke" tests="${results.length}" failures="${failures}" time="${totalTime.toFixed(3)}">`,
    cases,
    `  </testsuite>`,
    `</testsuites>`,
    "",
  ].join("\n");
  mkdirSync(dirname(JUNIT_PATH), { recursive: true });
  writeFileSync(JUNIT_PATH, xml);
}

async function main(): Promise<void> {
  console.log(`smoke → ${API_BASE_URL}`);
  const results: CheckResult[] = [];
  for (const check of checks) {
    const result = await runCheck(check);
    results.push(result);
    const tag = result.ok ? "PASS" : "FAIL";
    const detail = result.ok ? `${result.durationMs.toFixed(0)}ms` : result.error;
    console.log(`  ${tag}  ${result.name} (${detail})`);
  }
  writeJunit(results);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed · junit → ${JUNIT_PATH}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(2);
});
