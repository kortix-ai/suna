#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "src");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const enforce = process.argv.includes("--enforce");

type FileReport = {
  readonly file: string;
  readonly domain: string;
  readonly usesEffect: boolean;
  readonly usesServiceLayer: boolean;
  readonly usesSchema: boolean;
  readonly usesSchedule: boolean;
  readonly usesStream: boolean;
  readonly usesScope: boolean;
  readonly directInfrastructure: readonly string[];
};

const infrastructureAdapterFiles = new Set([
  "apps/api/src/config.ts",
  "apps/api/src/effect/services.ts",
  "apps/api/src/shared/db.ts",
  "apps/api/src/shared/supabase.ts",
]);

const walk = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "__tests__") continue;
      files.push(...walk(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
};

const domainFor = (display: string): string => {
  const parts = display.split("/");
  const srcIndex = parts.indexOf("src");
  return srcIndex >= 0 ? parts[srcIndex + 1] ?? "(root)" : "(unknown)";
};

const directInfrastructure = (source: string): string[] => {
  const matches: string[] = [];
  const sourceWithoutFetchMethods = source.replace(/\basync\s+fetch\s*\(/g, "asyncFetch(");
  if (/from ['"](?:\.\.?\/)*shared\/db['"]/.test(source)) matches.push("direct shared/db import");
  if (/from ['"](?:\.\.?\/)*shared\/supabase['"]/.test(source)) matches.push("direct shared/supabase import");
  if (/from ['"](?:\.\.?\/)*config['"]/.test(source)) matches.push("direct config import");
  if (/(?<!\.)\bfetch\s*\(/.test(sourceWithoutFetchMethods) && !/HttpClient/.test(source)) matches.push("direct fetch");
  if (/\bnew Promise\s*\(/.test(source)) matches.push("direct Promise construction");
  if (/\bset(?:Timeout|Interval)\s*\(/.test(source)) matches.push("direct timer");
  return matches;
};

const reports: FileReport[] = walk(SRC_ROOT).map((file) => {
  const source = readFileSync(file, "utf8");
  const display = relative(REPO_ROOT, file);
  return {
    file: display,
    domain: domainFor(display),
    usesEffect: /from ['"]effect['"]|from ['"]effect\//.test(source),
    usesServiceLayer:
      /\b(Context\.Tag|Layer\.|Effect\.Service|AppConfig|DatabaseService|SupabaseService|HttpClient)\b/.test(source),
    usesSchema: /\bSchema\./.test(source),
    usesSchedule: /\bSchedule\./.test(source),
    usesStream: /\bStream\./.test(source),
    usesScope: /\b(Scope\.|Effect\.acquireRelease|Effect\.scoped)\b/.test(source),
    directInfrastructure: infrastructureAdapterFiles.has(display)
      ? []
      : directInfrastructure(source),
  };
});

const productionReports = reports.filter((report) => !report.file.includes("/scripts/"));
const totals = {
  files: productionReports.length,
  effectFiles: productionReports.filter((report) => report.usesEffect).length,
  serviceLayerFiles: productionReports.filter((report) => report.usesServiceLayer).length,
  schemaFiles: productionReports.filter((report) => report.usesSchema).length,
  scheduleFiles: productionReports.filter((report) => report.usesSchedule).length,
  streamFiles: productionReports.filter((report) => report.usesStream).length,
  scopeFiles: productionReports.filter((report) => report.usesScope).length,
  directInfrastructureFiles: productionReports.filter((report) => report.directInfrastructure.length > 0).length,
};

const domains = new Map<string, FileReport[]>();
for (const report of productionReports) {
  domains.set(report.domain, [...(domains.get(report.domain) ?? []), report]);
}

console.log("[audit-effect-architecture] backend production TypeScript:");
console.log(`  files: ${totals.files}`);
console.log(`  Effect imports: ${totals.effectFiles}`);
console.log(`  service/layer usage: ${totals.serviceLayerFiles}`);
console.log(`  Schema usage: ${totals.schemaFiles}`);
console.log(`  Schedule usage: ${totals.scheduleFiles}`);
console.log(`  Stream usage: ${totals.streamFiles}`);
console.log(`  Scope/resource usage: ${totals.scopeFiles}`);
console.log(`  direct infrastructure files: ${totals.directInfrastructureFiles}`);
console.log("");

console.log("[audit-effect-architecture] domain coverage:");
for (const [domain, files] of [...domains.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const effect = files.filter((file) => file.usesEffect).length;
  const serviceLayer = files.filter((file) => file.usesServiceLayer).length;
  const direct = files.filter((file) => file.directInfrastructure.length > 0).length;
  console.log(
    `  ${domain.padEnd(20)} files=${String(files.length).padStart(3)} effect=${String(effect).padStart(3)} serviceLayer=${String(serviceLayer).padStart(3)} directInfra=${String(direct).padStart(3)}`,
  );
}

const directExamples = productionReports
  .filter((report) => report.directInfrastructure.length > 0)
  .slice(0, 30);

if (directExamples.length > 0) {
  console.log("");
  console.log("[audit-effect-architecture] direct infrastructure examples:");
  for (const report of directExamples) {
    console.log(`  ${report.file}: ${report.directInfrastructure.join(", ")}`);
  }
}

const strictFailures: string[] = [];
if (totals.effectFiles !== totals.files) {
  strictFailures.push(`${totals.files - totals.effectFiles} production files do not import Effect`);
}
if (totals.directInfrastructureFiles > 0) {
  strictFailures.push(`${totals.directInfrastructureFiles} production files still use direct infrastructure`);
}
if (totals.scheduleFiles === 0) {
  strictFailures.push("no production file uses Effect Schedule");
}
if (totals.streamFiles === 0) {
  strictFailures.push("no production file uses Effect Stream");
}
if (totals.scopeFiles === 0) {
  strictFailures.push("no production file uses Effect Scope/resource management");
}

if (enforce && strictFailures.length > 0) {
  console.error("");
  console.error("[audit-effect-architecture] strict backend Effect claim is not yet true:");
  for (const failure of strictFailures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("");
console.log(
  strictFailures.length === 0
    ? "[audit-effect-architecture] ok: strict backend Effect architecture requirements are satisfied"
    : "[audit-effect-architecture] report-only: strict backend Effect architecture requirements are not yet satisfied",
);
