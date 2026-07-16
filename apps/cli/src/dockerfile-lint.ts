/**
 * Static lint for a project's sandbox Dockerfile — the pre-push gate.
 *
 * `kortix validate` used to read kortix.yaml and stop there: every constraint
 * a sandbox Dockerfile has to satisfy was only discovered by the CLOUD builder,
 * minutes after a push, as an opaque remote failure. These checks are the ones
 * that can be decided from the Dockerfile TEXT alone — no Docker, no network,
 * microseconds — so they belong at authoring time, where `validate` already
 * runs (standalone, inside `kortix ship`, and in the CR-merge gate).
 *
 * The three checks below are each backed by a real incident. None of them is a
 * style opinion: every one is a build that FAILS in the cloud today.
 *
 * Emits `ManifestIssue`s so `validate` can merge them straight into the report
 * it already prints — `path` carries the Dockerfile's repo-relative path (not a
 * kortix.yaml dot-path) and `line` is the line WITHIN that Dockerfile, so
 * `formatIssues` renders `error path/to/Dockerfile: … (line 3)`.
 */
import type { ManifestIssue } from '@kortix/manifest-schema';

export interface LintDockerfileOpts {
  /**
   * Repo-relative path of the Dockerfile being linted. Used verbatim as the
   * issue `path` so the report points at the file the author has to edit.
   */
  path: string;
}

/**
 * The complete set of names `stageBuildContext` (apps/api/src/snapshots/
 * build-context.ts) stages into the cloud build context. Nothing else exists
 * there — in particular, NOT the user's repo.
 *
 * This is the precision argument for the COPY check being an ERROR rather than
 * a hint: the context's contents are a CLOSED set, fixed by Kortix, and none of
 * it is anything a user Dockerfile would legitimately COPY. So every
 * context-reading COPY in a user Dockerfile is a build that cannot succeed —
 * there is no false positive to trade against.
 */
export const STAGED_CONTEXT_ENTRIES = [
  'kortix-agent.gz',
  'kortix.gz',
  'kortix-entrypoint',
  'kortix-slack-cli/',
  'kortix-executor-sdk/',
  'kortix-opencode-config/',
  'kortix-llm-catalog.json',
  'scaffold.git',
] as const;

/** Bases whose package manager is not apt — the Kortix layer's floor needs it. */
const NON_DEBIAN_BASES = [
  'alpine',
  'amazonlinux',
  'archlinux',
  'busybox',
  'centos',
  'chainguard',
  'clearlinux',
  'distroless',
  'fedora',
  'gentoo',
  'mariner',
  'nixos',
  'opensuse',
  'oraclelinux',
  'photon',
  'rhel',
  'rockylinux',
  'scratch',
  'suse',
  'voidlinux',
  'wolfi',
];

/** A logical Dockerfile instruction: continuations joined, comments dropped. */
interface Instruction {
  /** Uppercased instruction keyword (`COPY`, `RUN`, `FROM`, …). */
  keyword: string;
  /** Everything after the keyword, with `\`-continuations joined into one line. */
  args: string;
  /** 1-indexed line where the instruction STARTS. */
  line: number;
  /** The instruction's first physical line, verbatim (for heredoc reporting). */
  firstLine: string;
}

/**
 * The buildah-portability guard's heredoc detector, ported VERBATIM from
 * `stageBuildContext` (apps/api/src/snapshots/build-context.ts). Keep the two
 * in lock-step: this is the authoring-time copy of a check that otherwise only
 * fires server-side, mid-build.
 */
const HEREDOC_RE = /<<-?['"]?[A-Za-z_]\w*['"]?\s*\\?\s*$/;

/** Extract a heredoc's delimiter so its BODY can be skipped by the parser. */
function heredocDelimiter(line: string): string | null {
  const m = line.match(/<<-?['"]?([A-Za-z_]\w*)['"]?\s*\\?\s*$/);
  return m ? m[1]! : null;
}

/**
 * Split a Dockerfile into logical instructions. Deliberately small: it handles
 * comments, blank lines, `\` continuations and heredoc bodies — which is
 * everything these three checks need — and does NOT try to be a full parser
 * (no ARG expansion, no parser directives beyond ignoring them as comments).
 */
function parseInstructions(text: string): Instruction[] {
  const lines = text.split('\n');
  const out: Instruction[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue;

    const startLine = i + 1;
    const firstLine = raw;
    // Join `\`-continuations into one logical line. A heredoc opener ends the
    // JOIN too (its body is not part of the instruction's arg text) — we record
    // the instruction, then skip the body below.
    let joined = raw;
    let heredoc = heredocDelimiter(raw);
    while (!heredoc && /\\\s*$/.test(lines[i] ?? '') && i + 1 < lines.length) {
      i++;
      const next = lines[i]!;
      joined = `${joined.replace(/\\\s*$/, '')} ${next.trim()}`;
      heredoc = heredocDelimiter(next);
    }

    const m = joined.trim().match(/^([A-Za-z]+)\s*(.*)$/s);
    if (m) out.push({ keyword: m[1]!.toUpperCase(), args: m[2]!.trim(), line: startLine, firstLine });

    // Skip the heredoc body so `COPY foo bar` inside a `RUN cat <<EOF` isn't
    // mistaken for a real instruction.
    if (heredoc) {
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== heredoc) i++;
      i++; // consume the terminator
    }
  }
  return out;
}

/** Tokenize instruction args, honoring the JSON-array (exec) form and quotes. */
function tokenizeArgs(args: string): string[] {
  const trimmed = args.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map(String);
    } catch {
      /* fall through to whitespace splitting */
    }
  }
  return trimmed.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, '')) ?? [];
}

/** True for an `ADD` source Docker fetches over the network rather than the context. */
function isRemoteSource(src: string): boolean {
  return /^(https?|ftp|git):\/\//i.test(src) || /^git@/.test(src);
}

/** The base image name a `FROM` line names, or null if it can't be read statically. */
function fromBase(args: string): { base: string; stage?: string } | null {
  const tokens = tokenizeArgs(args).filter((t) => !t.startsWith('--'));
  const base = tokens[0];
  if (!base) return null;
  // `FROM x AS name`
  const asIdx = tokens.findIndex((t) => t.toUpperCase() === 'AS');
  const stage = asIdx > 0 ? tokens[asIdx + 1] : undefined;
  return { base, stage };
}

/**
 * Lint a sandbox Dockerfile for the constraints the Kortix cloud builder
 * enforces. Returns `ManifestIssue`s in source order; an empty array means the
 * text passes every static check (it says NOTHING about whether the image
 * actually builds — see `kortix sandboxes build --local` for that).
 */
export function lintDockerfile(text: string, opts: LintDockerfileOpts): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const instructions = parseInstructions(text);

  // ── 1. COPY/ADD from the build context ───────────────────────────────────
  // `stageBuildContext` stages ONLY Kortix's own artifacts (see
  // STAGED_CONTEXT_ENTRIES). The user's repo is NEVER in the build context —
  // it is git-cloned to /workspace when a session boots, precisely so that a
  // code change doesn't invalidate the image. So any COPY that reads from the
  // context can only ever resolve to "Path does not exist" in the cloud. This
  // is decidable and exact: the only legal reads are `--from=<stage>` (a
  // multi-stage copy, which reads from an image, not the context) and a remote
  // `ADD <url>` (which Docker fetches over the network).
  for (const ins of instructions) {
    if (ins.keyword !== 'COPY' && ins.keyword !== 'ADD') continue;
    const tokens = tokenizeArgs(ins.args);
    if (tokens.some((t) => /^--from=/.test(t))) continue; // reads an image/stage, not the context
    const operands = tokens.filter((t) => !t.startsWith('--'));
    if (operands.length < 2) continue; // malformed or heredoc form — not ours to judge
    const sources = operands.slice(0, -1);
    for (const src of sources) {
      if (src.startsWith('<<')) continue; // heredoc content — check 2 owns it
      if (ins.keyword === 'ADD' && isRemoteSource(src)) continue; // fetched, not staged
      issues.push({
        path: opts.path,
        line: ins.line,
        severity: 'error',
        message:
          `\`${ins.keyword} ${src}\` reads from the build context, but your repo is NOT in it — ` +
          `the cloud build fails with "Path does not exist: …/${src.replace(/^\.\//, '')}". Kortix ` +
          `stages only its own artifacts there; your project source is git-cloned to /workspace ` +
          `when a session boots, so the image never bakes it in. Read it from /workspace at ` +
          `runtime, inline it with a RUN, or copy it from an earlier stage (\`COPY --from=<stage>\`).`,
      });
    }
  }

  // ── 2. RUN heredocs ──────────────────────────────────────────────────────
  // Rationale ported verbatim from the buildah-portability guard in
  // apps/api/src/snapshots/build-context.ts:
  //
  //   The SAME composed context ships to BOTH providers. Daytona builds with
  //   BuildKit (supports `# syntax=docker/dockerfile:1.7` + RUN heredocs);
  //   Platinum builds with podman/buildah's classic imagebuilder, which
  //   supports NEITHER — it parses a heredoc body's first line (e.g. `import
  //   importlib`) as a Dockerfile instruction and aborts EVERY build ("Unknown
  //   instruction: IMPORT"), failing all Platinum sessions. This exact
  //   regression (a `<<'PY'` python verify added 2026-06-27) took dev down for
  //   hours because Daytona silently tolerated it.
  //
  // That guard throws SERVER-side, mid-build, and only for Platinum — so on a
  // Daytona-backed project a heredoc ships green and breaks later. Deciding it
  // here, from the text, is the same check moved to where it costs nothing.
  for (const ins of instructions) {
    if (/^\s*#/.test(ins.firstLine) || !HEREDOC_RE.test(ins.firstLine)) continue;
    issues.push({
      path: opts.path,
      line: ins.line,
      severity: 'error',
      message:
        `RUN heredoc is not buildah-portable: "${ins.firstLine.trim().slice(0, 120)}". Kortix's ` +
        `Platinum provider builds with buildah's classic imagebuilder, which parses the heredoc ` +
        `body's first line as a Dockerfile instruction and aborts the build ("Unknown ` +
        `instruction: …"). Use a single-line equivalent (e.g. \`python3 -c '…'\`) — heredocs and ` +
        `BuildKit-only \`# syntax\` directives work on Daytona but break every Platinum build.`,
    });
  }

  // ── 3. Non-Debian base ───────────────────────────────────────────────────
  // The Kortix layer's floor opens with `apt-get update && apt-get install`, so
  // a base without apt cannot carry it. Only the FINAL stage's base matters —
  // the layer is appended to the end of the user's Dockerfile, so an
  // alpine BUILDER stage is perfectly legal. This is a WARNING, not an error:
  // the tag alone can't prove the absence of apt (a Debian derivative can be
  // named anything, and `FROM myorg/alpine-migrated-to-debian` is a real
  // shape), so we flag the smell and let the author overrule it.
  const stages = new Map<string, string>(); // stage name (lower) -> base
  let finalBase: { base: string; line: number } | null = null;
  for (const ins of instructions) {
    if (ins.keyword !== 'FROM') continue;
    const parsed = fromBase(ins.args);
    if (!parsed) continue;
    if (parsed.stage) stages.set(parsed.stage.toLowerCase(), parsed.base);
    finalBase = { base: parsed.base, line: ins.line };
  }
  if (finalBase) {
    // `FROM builder` in the last stage means the real base is whatever `builder`
    // was FROM. Resolve through the stage graph (bounded — no cycles possible in
    // a valid Dockerfile, but cap anyway).
    let base = finalBase.base;
    for (let hops = 0; hops < 16 && stages.has(base.toLowerCase()); hops++) {
      const next = stages.get(base.toLowerCase())!;
      if (next.toLowerCase() === base.toLowerCase()) break;
      base = next;
    }
    // Skip anything we can't read statically (`FROM ${BASE_IMAGE}`).
    if (!base.includes('$')) {
      const [nameRaw, tagRaw = ''] = [base.split(':')[0]!, base.split(':')[1] ?? ''];
      const name = nameRaw.split('/').pop()!.toLowerCase();
      const tag = tagRaw.toLowerCase();
      const hit =
        NON_DEBIAN_BASES.find((n) => name === n || name.startsWith(`${n}-`) || name.endsWith(`-${n}`)) ??
        // `node:20-alpine`, `python:3.12-alpine3.19` — the family is in the TAG.
        NON_DEBIAN_BASES.find((n) => new RegExp(`(^|[-.])${n}([-.\\d]|$)`).test(tag));
      if (hit) {
        issues.push({
          path: opts.path,
          line: finalBase.line,
          severity: 'warning',
          message:
            `\`FROM ${base}\` looks like a non-Debian base (${hit}). The Kortix runtime layer ` +
            `appended on top installs its floor with \`apt-get\`, which only exists on ` +
            `Debian/Ubuntu-family images — on this base the cloud build fails at the layer's ` +
            `first RUN. Warning, not an error: only the tag is visible here, and it could be a ` +
            `Debian derivative. If it is, ignore this; otherwise switch to a Debian/Ubuntu base ` +
            `(e.g. \`ubuntu:24.04\`, \`python:3.12-slim\`).`,
        });
      }
    }
  }

  return issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
