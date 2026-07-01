#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "src");

type ScanIssue = {
  readonly file: string;
  readonly message: string;
};

const issues: ScanIssue[] = [];

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

const findMatchingParen = (source: string, openIndex: number): number => {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let regexLiteral = false;

  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (regexLiteral) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "/") regexLiteral = false;
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (
      ch === "/" &&
      /[=(,:![{?]\s*$/.test(source.slice(Math.max(0, i - 20), i))
    ) {
      regexLiteral = true;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && ch === ")") return i;
    }
  }
  return -1;
};

const splitTopLevelArgs = (source: string): Array<[number, number]> => {
  const args: Array<[number, number]> = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let regexLiteral = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (regexLiteral) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "/") regexLiteral = false;
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (
      ch === "/" &&
      /[=(,:![{?]\s*$/.test(source.slice(Math.max(0, i - 20), i))
    ) {
      regexLiteral = true;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      args.push([start, i]);
      start = i + 1;
    }
  }

  args.push([start, source.length]);
  return args;
};

const effectHandlerPattern =
  /Effect\.|run[A-Za-z]*Effect\s*\(|run[A-Za-z]*Workflow\s*\(|effectHandler\s*\(|effectMiddleware|effect-workflow|effect-workflows|accountTry\s*\(|attemptBilling\s*\(|attemptRoute\s*\(|attemptTunnel\s*\(|attemptProxy\s*\(/;

let routeRegistrations = 0;
let effectRouteRegistrations = 0;

for (const file of walk(SRC_ROOT)) {
  const source = readFileSync(file, "utf8");
  const display = relative(join(import.meta.dir, "..", "..", ".."), file);

  if (
    /new\s+(OpenAPI)?Hono\b/.test(source) &&
    !/(effectMiddleware|makeOpenApiApp)/.test(source)
  ) {
    issues.push({
      file: display,
      message:
        "raw Hono/OpenAPIHono app is missing an Effect middleware/factory boundary",
    });
  }

  let index = 0;
  while ((index = source.indexOf(".openapi(", index)) !== -1) {
    const openIndex = index + ".openapi".length;
    const closeIndex = findMatchingParen(source, openIndex);
    if (closeIndex < 0) {
      issues.push({
        file: display,
        message: "could not parse .openapi(...) registration",
      });
      break;
    }

    const inner = source.slice(openIndex + 1, closeIndex);
    const args = splitTopLevelArgs(inner);
    const firstArg = args[0] ? inner.slice(args[0][0], args[0][1]) : "";
    const secondArg = args[1] ? inner.slice(args[1][0], args[1][1]) : "";

    // zod schemas also use `.openapi("Name")`; only route registrations pass createRoute(...).
    if (/createRoute\s*\(/.test(firstArg)) {
      routeRegistrations++;
      if (effectHandlerPattern.test(secondArg)) {
        effectRouteRegistrations++;
      } else {
        issues.push({
          file: display,
          message:
            "OpenAPI route registration is missing an explicit Effect handler boundary",
        });
      }
    }

    index = closeIndex + 1;
  }
}

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(`${issue.file}: ${issue.message}`);
  }
  console.error(
    `[audit-effect-coverage] failed: ${effectRouteRegistrations}/${routeRegistrations} OpenAPI routes have explicit Effect boundaries`,
  );
  process.exit(1);
}

console.log(
  `[audit-effect-coverage] ok: ${effectRouteRegistrations}/${routeRegistrations} OpenAPI routes have explicit Effect boundaries`,
);
