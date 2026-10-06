// SLASH COMMANDS: pi's prompt templates, read from the workspace.
//
// kortixd's pi harness hands pi `<pi config dir>/prompts` as its prompt
// template path (harness/pi/extensions/host.ts `additionalPromptTemplatePaths`),
// lists them on `GET /command` and runs one on `POST /session/:id/command` by
// prompting `/name arguments`, which pi expands (runtime.ts `commandList`,
// `commandPrompt`). pi-durable has no template loader, so the cell reads the
// directory over its ExecutionEnv, as skills.js does.
//
// `parseCommandArgs`, `substituteArgs` and the loader's rules are vendored
// from @earendil-works/pi-coding-agent 1.0.3 dist/core/prompt-templates.js
// (MIT, Copyright (c) Earendil Works): same quoting, same `$1` / `$@` /
// `$ARGUMENTS` / `${N:-default}` / `${@:N:L}` substitution, same description
// fallback, non-recursive, `.md` only.
import { parse } from "yaml";

/** Bash-style argument split: quotes group, whitespace separates. */
export function parseCommandArgs(argsString) {
  const args = [];
  let current = "";
  let inQuote = null;
  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) { args.push(current); current = ""; }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/** `$1`, `$@`, `$ARGUMENTS`, `${N:-default}`, `${@:N}`, `${@:N:L}`; values are not re-substituted. */
export function substituteArgs(content, args) {
  const allArgs = args.join(" ");
  return content.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g, (_m, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
    if (defaultTarget) {
      const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
      return value ? value : defaultValue;
    }
    if (sliceStart) {
      let start = parseInt(sliceStart, 10) - 1;
      if (start < 0) start = 0;
      if (sliceLength) return args.slice(start, start + parseInt(sliceLength, 10)).join(" ");
      return args.slice(start).join(" ");
    }
    if (simple === "ARGUMENTS" || simple === "@") return allArgs;
    return args[parseInt(simple, 10) - 1] ?? "";
  });
}

/** pi's frontmatter split (utils/frontmatter.js): BOM and CRLF normalised, YAML between `---` lines. */
export function parseFrontmatter(content) {
  const normalized = String(content).replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: normalized };
  return { frontmatter: parse(normalized.slice(4, end)) ?? {}, body: normalized.slice(end + 4).trim() };
}

/** One template from its file text, or null with a diagnostic. */
export function templateFromText(filePath, text) {
  let parsed;
  try { parsed = parseFrontmatter(text); } catch (e) {
    return { template: null, diagnostic: { type: "warning", message: String(e?.message ?? e), path: filePath } };
  }
  const { frontmatter, body } = parsed;
  const name = filePath.split("/").pop().replace(/\.md$/, "");
  let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  if (!description) {
    const firstLine = body.split("\n").find((line) => line.trim());
    if (firstLine) description = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
  }
  const argumentHint = typeof frontmatter["argument-hint"] === "string" ? frontmatter["argument-hint"] : undefined;
  return { template: { name, description, ...(argumentHint ? { argumentHint } : {}), content: body, filePath }, diagnostic: null };
}

/** Every `.md` directly in each directory (not recursive), in directory order. A missing directory is normal. */
export async function loadPromptTemplates(env, dirs) {
  const templates = [];
  const diagnostics = [];
  for (const dir of dirs) {
    const listed = await env.listDir(dir).catch((e) => ({ ok: false, error: e }));
    if (!listed?.ok) continue;
    const entries = [...listed.value].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
      const read = await env.readTextFile(entry.path).catch((e) => ({ ok: false, error: e }));
      if (!read?.ok) { diagnostics.push({ type: "warning", message: String(read?.error?.message ?? "failed to read prompt template file"), path: entry.path }); continue; }
      const { template, diagnostic } = templateFromText(entry.path, String(read.value ?? ""));
      if (template) templates.push(template);
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }
  return { templates, diagnostics };
}

/** `/name args` expanded when `name` is a template; any other text unchanged (pi `expandPromptTemplate`). */
export function expandPromptTemplate(text, templates) {
  if (!text.startsWith("/")) return text;
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return text;
  const template = templates.find((t) => t.name === match[1]);
  return template ? substituteArgs(template.content, parseCommandArgs(match[2] ?? "")) : text;
}

/** `GET /command`, in kortixd's shape (runtime.ts `commandList`). */
export function commandList(templates) {
  return templates.map((t) => ({
    name: t.name,
    description: t.description,
    source: "command",
    template: t.content,
    hints: [...new Set(t.content.match(/\$(\d+|ARGUMENTS)/g) ?? [])],
  }));
}

/**
 * The prompt a `POST /session/:id/command` body asks for: `/name arguments`.
 * Throws on an unknown command, as kortixd's `commandPrompt` does.
 */
export function commandPromptBody(raw, templates) {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const name = typeof body.command === "string" ? body.command : "";
  if (!templates.some((t) => t.name === name)) throw new Error(`unknown command "${name}"`);
  const args = typeof body.arguments === "string" ? body.arguments.trim() : "";
  const [providerID, ...model] = typeof body.model === "string" ? body.model.split("/") : [];
  return {
    parts: [{ type: "text", text: `/${name}${args ? ` ${args}` : ""}` }],
    ...(body.messageID !== undefined ? { messageID: body.messageID } : {}),
    ...(body.agent !== undefined ? { agent: body.agent } : {}),
    ...(body.variant !== undefined ? { variant: body.variant } : {}),
    ...(providerID && model.length ? { model: { providerID, modelID: model.join("/") } } : {}),
  };
}
