// Vendored from @earendil-works/pi-agent-core 0.84.4 (MIT), dist/harness/skills.js
// and formatSkillsForSystemPrompt from dist/harness/system-prompt.js.
//
// pi 1.0 removed its harness modules from pi-agent-core, and pi-durable has no
// skill loader. The cell reads skills from its workspace over an ExecutionEnv,
// which is exactly what this module takes, so it is kept verbatim (only
// `toError` is inlined) rather than re-implemented: same traversal, same
// frontmatter rules, same ignore-file handling, same diagnostics.
//
// MIT License. Copyright (c) Earendil Works. Permission is hereby granted, free
// of charge, to any person obtaining a copy of this software and associated
// documentation files, to deal in the Software without restriction. THE
// SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
import ignore from "ignore";
import { parse } from "yaml";
function toError(error) {
    if (error instanceof Error)
        return error;
    if (typeof error === "string")
        return new Error(error);
    try {
        return new Error(JSON.stringify(error));
    }
    catch {
        return new Error(String(error));
    }
}
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
/** Format a skill invocation prompt, optionally appending additional user instructions. */
export function formatSkillInvocation(skill, additionalInstructions) {
    const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirnameEnvPath(skill.filePath)}.\n\n${skill.content}\n</skill>`;
    return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}
/**
 * Load skills from one or more directories.
 *
 * Traverses directories recursively, loads `SKILL.md` files, loads direct root `.md` files with skill
 * frontmatter, honors ignore files, and returns diagnostics for invalid declared skill files. Missing input
 * directories are skipped.
 */
export async function loadSkills(env, dirs) {
    const skills = [];
    const diagnostics = [];
    for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
        const rootInfoResult = await env.fileInfo(dir);
        if (!rootInfoResult.ok) {
            if (rootInfoResult.error.code !== "not_found") {
                diagnostics.push({
                    type: "warning",
                    code: "file_info_failed",
                    message: rootInfoResult.error.message,
                    path: dir,
                });
            }
            continue;
        }
        const rootInfo = rootInfoResult.value;
        if ((await resolveKind(env, rootInfo, diagnostics)) !== "directory")
            continue;
        const result = await loadSkillsFromDirInternal(env, rootInfo.path, true, ignore(), rootInfo.path);
        skills.push(...result.skills);
        diagnostics.push(...result.diagnostics);
    }
    return { skills, diagnostics };
}
/**
 * Load skills from source-tagged directories.
 *
 * Source values are preserved exactly and attached to every loaded skill and diagnostic. The agent package does not
 * interpret source values; applications define their own provenance shape.
 */
export async function loadSourcedSkills(env, inputs, mapSkill) {
    const skills = [];
    const diagnostics = [];
    for (const input of inputs) {
        const result = await loadSkills(env, input.path);
        for (const skill of result.skills) {
            skills.push({ skill: mapSkill ? mapSkill(skill, input.source) : skill, source: input.source });
        }
        for (const diagnostic of result.diagnostics)
            diagnostics.push({ ...diagnostic, source: input.source });
    }
    return { skills, diagnostics };
}
async function loadSkillsFromDirInternal(env, dir, includeRootFiles, ignoreMatcher, rootDir) {
    const skills = [];
    const diagnostics = [];
    const dirInfoResult = await env.fileInfo(dir);
    if (!dirInfoResult.ok) {
        if (dirInfoResult.error.code !== "not_found") {
            diagnostics.push({
                type: "warning",
                code: "file_info_failed",
                message: dirInfoResult.error.message,
                path: dir,
            });
        }
        return { skills, diagnostics };
    }
    const dirInfo = dirInfoResult.value;
    if ((await resolveKind(env, dirInfo, diagnostics)) !== "directory")
        return { skills, diagnostics };
    await addIgnoreRules(env, ignoreMatcher, dir, rootDir, diagnostics);
    const entriesResult = await env.listDir(dir);
    if (!entriesResult.ok) {
        diagnostics.push({ type: "warning", code: "list_failed", message: entriesResult.error.message, path: dir });
        return { skills, diagnostics };
    }
    const entries = entriesResult.value;
    for (const entry of entries) {
        if (entry.name !== "SKILL.md")
            continue;
        const fullPath = entry.path;
        const kind = await resolveKind(env, entry, diagnostics);
        if (kind !== "file")
            continue;
        const relPath = relativeEnvPath(rootDir, fullPath);
        if (ignoreMatcher.ignores(relPath))
            continue;
        const result = await loadSkillFromFile(env, fullPath, dirInfo.name);
        if (result.skill)
            skills.push(result.skill);
        diagnostics.push(...result.diagnostics);
        return { skills, diagnostics };
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".") || entry.name === "node_modules")
            continue;
        const fullPath = entry.path;
        const kind = await resolveKind(env, entry, diagnostics);
        if (!kind)
            continue;
        const relPath = relativeEnvPath(rootDir, fullPath);
        const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
        if (ignoreMatcher.ignores(ignorePath))
            continue;
        if (kind === "directory") {
            const result = await loadSkillsFromDirInternal(env, fullPath, false, ignoreMatcher, rootDir);
            skills.push(...result.skills);
            diagnostics.push(...result.diagnostics);
            continue;
        }
        if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md"))
            continue;
        const result = await loadSkillFromFile(env, fullPath, dirInfo.name);
        if (result.skill)
            skills.push(result.skill);
        diagnostics.push(...result.diagnostics);
    }
    return { skills, diagnostics };
}
async function addIgnoreRules(env, ig, dir, rootDir, diagnostics) {
    const relativeDir = relativeEnvPath(rootDir, dir);
    const prefix = relativeDir ? `${relativeDir}/` : "";
    for (const filename of IGNORE_FILE_NAMES) {
        const ignorePathResult = await env.joinPath([dir, filename]);
        if (!ignorePathResult.ok) {
            diagnostics.push({
                type: "warning",
                code: "file_info_failed",
                message: ignorePathResult.error.message,
                path: dir,
            });
            continue;
        }
        const ignorePath = ignorePathResult.value;
        const info = await env.fileInfo(ignorePath);
        if (!info.ok) {
            if (info.error.code !== "not_found") {
                diagnostics.push({
                    type: "warning",
                    code: "file_info_failed",
                    message: info.error.message,
                    path: ignorePath,
                });
            }
            continue;
        }
        if (info.value.kind !== "file")
            continue;
        const content = await env.readTextFile(ignorePath);
        if (!content.ok) {
            diagnostics.push({ type: "warning", code: "read_failed", message: content.error.message, path: ignorePath });
            continue;
        }
        const patterns = content.value
            .split(/\r?\n/)
            .map((line) => prefixIgnorePattern(line, prefix))
            .filter((line) => Boolean(line));
        if (patterns.length > 0)
            ig.add(patterns);
    }
}
function prefixIgnorePattern(line, prefix) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))
        return null;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
        negated = true;
        pattern = pattern.slice(1);
    }
    else if (pattern.startsWith("\\!")) {
        pattern = pattern.slice(1);
    }
    if (pattern.startsWith("/"))
        pattern = pattern.slice(1);
    const prefixed = prefix ? `${prefix}${pattern}` : pattern;
    return negated ? `!${prefixed}` : prefixed;
}
async function loadSkillFromFile(env, filePath, parentDirName) {
    const diagnostics = [];
    const isDeclaredSkill = filePath
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() === "SKILL.md";
    const rawContent = await env.readTextFile(filePath);
    if (!rawContent.ok) {
        diagnostics.push({ type: "warning", code: "read_failed", message: rawContent.error.message, path: filePath });
        return { skill: null, diagnostics };
    }
    const parsed = parseFrontmatter(rawContent.value);
    if (!parsed.ok) {
        if (isDeclaredSkill) {
            diagnostics.push({ type: "warning", code: "parse_failed", message: parsed.error.message, path: filePath });
        }
        return { skill: null, diagnostics };
    }
    const { frontmatter, body } = parsed.value;
    const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;
    if (!isDeclaredSkill && (!description || description.trim() === "")) {
        return { skill: null, diagnostics };
    }
    for (const error of validateDescription(description)) {
        diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
    }
    const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
    const name = frontmatterName || parentDirName;
    for (const error of validateName(name, parentDirName)) {
        diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
    }
    if (!description || description.trim() === "") {
        return { skill: null, diagnostics };
    }
    return {
        skill: {
            name,
            description,
            content: body,
            filePath,
            disableModelInvocation: frontmatter["disable-model-invocation"] === true,
        },
        diagnostics,
    };
}
function validateName(name, parentDirName) {
    const errors = [];
    if (name !== parentDirName)
        errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
    if (name.length > MAX_NAME_LENGTH)
        errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
    if (!/^[a-z0-9-]+$/.test(name)) {
        errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
    }
    if (name.startsWith("-") || name.endsWith("-"))
        errors.push("name must not start or end with a hyphen");
    if (name.includes("--"))
        errors.push("name must not contain consecutive hyphens");
    return errors;
}
function validateDescription(description) {
    const errors = [];
    if (!description || description.trim() === "") {
        errors.push("description is required");
    }
    else if (description.length > MAX_DESCRIPTION_LENGTH) {
        errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
    }
    return errors;
}
function parseFrontmatter(content) {
    try {
        const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        if (!normalized.startsWith("---"))
            return { ok: true, value: { frontmatter: {}, body: normalized } };
        const endIndex = normalized.indexOf("\n---", 3);
        if (endIndex === -1)
            return { ok: true, value: { frontmatter: {}, body: normalized } };
        const yamlString = normalized.slice(4, endIndex);
        const body = normalized.slice(endIndex + 4).trim();
        return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}), body } };
    }
    catch (error) {
        return { ok: false, error: toError(error) };
    }
}
async function resolveKind(env, info, diagnostics) {
    if (info.kind === "file" || info.kind === "directory")
        return info.kind;
    const canonicalPath = await env.canonicalPath(info.path);
    if (!canonicalPath.ok) {
        if (canonicalPath.error.code !== "not_found") {
            diagnostics.push({
                type: "warning",
                code: "file_info_failed",
                message: canonicalPath.error.message,
                path: info.path,
            });
        }
        return undefined;
    }
    const target = await env.fileInfo(canonicalPath.value);
    if (!target.ok) {
        if (target.error.code !== "not_found") {
            diagnostics.push({
                type: "warning",
                code: "file_info_failed",
                message: target.error.message,
                path: info.path,
            });
        }
        return undefined;
    }
    return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
}
function dirnameEnvPath(path) {
    const normalized = path.replace(/[\\/]+$/, "");
    const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    if (separatorIndex === 2 && normalized[1] === ":")
        return normalized.slice(0, 3);
    return separatorIndex <= 0 ? "/" : normalized.slice(0, separatorIndex);
}
function relativeEnvPath(root, path) {
    const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalizedPath === normalizedRoot)
        return "";
    return normalizedPath.startsWith(`${normalizedRoot}/`)
        ? normalizedPath.slice(normalizedRoot.length + 1)
        : normalizedPath.replace(/^\/+/, "");
}

export function formatSkillsForSystemPrompt(skills) {
    const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
    if (visibleSkills.length === 0)
        return "";
    const lines = [
        "The following skills provide specialized instructions for specific tasks.",
        "Read the full skill file when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        "",
        "<available_skills>",
    ];
    for (const skill of visibleSkills) {
        lines.push("  <skill>");
        lines.push(`    <name>${escapeXml(skill.name)}</name>`);
        lines.push(`    <description>${escapeXml(skill.description)}</description>`);
        lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
        lines.push("  </skill>");
    }
    lines.push("</available_skills>");
    return lines.join("\n");
}
function escapeXml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
