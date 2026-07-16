/**
 * `kortix sandboxes build --local [slug]` — build a project's sandbox image on
 * THIS machine, the way the cloud would.
 *
 * `kortix validate`'s Dockerfile lint catches everything decidable from text.
 * This catches the rest: the failures that only exist once apt/pip/npm actually
 * run. The motivating one is the Python floor colliding with a user's
 * dpkg-owned packages ("Cannot uninstall numpy 1.26.4, RECORD file not found")
 * — invisible until something executes the layer.
 *
 * Two choices make this an honest reproduction rather than a lookalike:
 *
 *   • The layer is `kortixToolchainLayer` ONLY — not the artifact tail. That
 *     tail COPYs staged Kortix build outputs (kortix-agent.gz, scaffold.git, …)
 *     that a consumer developer has no way to produce, and it installs nothing:
 *     everything that can FAIL on a user's base image lives in the toolchain
 *     half. Skipping it costs no coverage and makes the command runnable by
 *     anyone.
 *
 *   • The build context is EMPTY, structurally — the Dockerfile goes in over
 *     stdin (`docker build -f - -`) with `-` as the context. There is no
 *     directory to accidentally leak the repo in. That is exactly the cloud's
 *     constraint (the repo is cloned to /workspace at session start, never
 *     baked), so a `COPY ./src` fails here for the same reason and with a
 *     similar message.
 *
 * What it is NOT: a guarantee. The cloud composes the artifact tail on top,
 * builds linux/amd64, and may use buildah rather than BuildKit. A green local
 * build means the user's own Dockerfile + the Kortix floor agree — the most
 * common failure, not every failure.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_SANDBOX_SLUG,
  PLATFORM_DEFAULT_USER_DOCKERFILE,
  type SandboxTemplate,
  extractSandboxDefault,
  extractSandboxTemplates,
  kortixToolchainLayer,
  normalizeUserDockerfileForSnapshot,
} from '@kortix/shared/sandbox';
import { AGENT_BROWSER_VERSION, OPENCODE_VERSION } from '@kortix/shared/runtime-versions';
import { emitJson, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { dockerAvailable, hostPlatform } from '../docker.ts';
import { loadLocalManifest, resolveLocalManifest } from '../manifest.ts';
import { C, status } from '../style.ts';

export interface LocalBuildFlags {
  slug?: string;
  platform?: string;
  tag?: string;
  noCache: boolean;
  layer: boolean;
  print: boolean;
  json: boolean;
}

/**
 * Which template a bare `build --local` means. Precedence:
 *
 *   1. the slug the user named (positional or --slug)
 *   2. `sandbox.default` — the template this project's sessions actually boot
 *   3. the sole declared template, when there's exactly one (unambiguous)
 *   4. otherwise: error, listing the slugs
 *
 * Note what is NOT in that list: the platform `default` slug. Falling back to it
 * would produce a green build of `FROM ubuntu:24.04` + the layer — a build that
 * tests nothing the user wrote, while looking like it validated their project.
 * An explicit `default` is still honored: "build the platform base" is a
 * legitimate thing to ask for, just never something to assume.
 */
export function resolveLocalTemplate(
  slugArg: string | undefined,
  templates: SandboxTemplate[],
  defaultSlug: string | null,
): { template: SandboxTemplate } | { error: string } {
  const listSlugs = () =>
    templates.length === 0
      ? 'This project declares no `sandbox.templates` in kortix.yaml.'
      : `Declared templates: ${templates.map((t) => t.slug).join(', ')}.`;

  if (slugArg) {
    if (slugArg === DEFAULT_SANDBOX_SLUG) {
      return { template: { slug: DEFAULT_SANDBOX_SLUG, name: 'Default', spec: {}, isDefault: true } };
    }
    const hit = templates.find((t) => t.slug === slugArg);
    if (!hit) return { error: `No sandbox template "${slugArg}". ${listSlugs()}` };
    return { template: hit };
  }

  if (defaultSlug) {
    const hit = templates.find((t) => t.slug === defaultSlug);
    if (hit) return { template: hit };
    return {
      error: `\`sandbox.default\` points at "${defaultSlug}", which isn't declared. ${listSlugs()}`,
    };
  }

  if (templates.length === 1) return { template: templates[0]! };

  return {
    error:
      templates.length === 0
        ? `${listSlugs()} Nothing project-specific to build — pass \`--slug default\` to build the platform base image.`
        : `Ambiguous: ${templates.length} templates and no \`sandbox.default\`. Name one — ${listSlugs()}`,
  };
}

/**
 * The user-Dockerfile bytes a template contributes, exactly as the cloud
 * builder derives them (apps/api/src/snapshots/templates.ts): a `dockerfile:`
 * template supplies its file's bytes, an `image:` template a one-line `FROM`
 * shim, and the platform default its own canned base.
 */
export function userDockerfileForTemplate(
  template: SandboxTemplate,
  projectRoot: string,
): { text: string; source: string } | { error: string } {
  if (template.isDefault) {
    return { text: PLATFORM_DEFAULT_USER_DOCKERFILE, source: '(platform default base)' };
  }
  if (template.dockerfile) {
    const abs = resolve(projectRoot, template.dockerfile);
    if (!existsSync(abs)) {
      return { error: `Template "${template.slug}" points at ${template.dockerfile}, which doesn't exist.` };
    }
    try {
      return { text: readFileSync(abs, 'utf8'), source: template.dockerfile };
    } catch (err) {
      return { error: `Can't read ${template.dockerfile}: ${(err as Error).message}` };
    }
  }
  if (template.image) return { text: `FROM ${template.image}\n`, source: `(image: ${template.image})` };
  return { error: `Template "${template.slug}" declares neither a dockerfile nor an image.` };
}

/**
 * Compose what gets built: the user's Dockerfile (normalized the same way the
 * snapshot builder normalizes it) plus the Kortix toolchain layer.
 *
 * `opencodeConfigPath` and `warmRepo` are deliberately OMITTED — both make the
 * layer emit steps that read staged context (`COPY <config>/ …`) or clone with
 * build-time credentials, neither of which exists locally. Everything they'd
 * add is a warm-up, not a correctness step, so their absence changes nothing
 * about whether the image BUILDS.
 */
export function composeLocalDockerfile(userDockerfile: string, opts: { layer: boolean }): string {
  const user = normalizeUserDockerfileForSnapshot(userDockerfile).trimEnd();
  if (!opts.layer) return `${user}\n`;
  return `${user}\n${kortixToolchainLayer({
    opencodeVersion: OPENCODE_VERSION,
    agentBrowserVersion: AGENT_BROWSER_VERSION,
  })}`;
}

/** The exact `docker build` argv. Pure, so a test can assert the shape. */
export function dockerBuildArgs(opts: { platform: string; tag: string; noCache: boolean }): string[] {
  return [
    'build',
    '--platform',
    opts.platform,
    '-t',
    opts.tag,
    ...(opts.noCache ? ['--no-cache'] : []),
    // A bare `-` context with the Dockerfile on stdin: docker sniffs stdin, sees
    // a Dockerfile rather than a tar, and builds it against an EMPTY context.
    // That is the load-bearing bit — "your repo is not in the build context"
    // stops being a rule someone has to remember and becomes a property of the
    // build, because there is no directory here to leak it from.
    //
    // NOT `-f - -`: docker rejects that outright ("can't use stdin for both
    // build context and dockerfile"). `-` alone is the supported spelling.
    '-',
  ];
}

/**
 * `--local` needs no auth and no linked project — it only reads kortix.yaml,
 * a Dockerfile, and the local Docker daemon. `sandboxes.ts` therefore routes it
 * above `resolveProjectContext`, alongside add/update/rm, and hands over the
 * argv it has already taken the shared flags (`--json`, `--project`, …) out of.
 */
export function runSandboxBuildLocal(argv: string[], opts: { json: boolean }): number {
  let flags: LocalBuildFlags;
  try {
    const noCache = takeFlagBool(argv, ['--no-cache']);
    const noLayer = takeFlagBool(argv, ['--no-layer']);
    const print = takeFlagBool(argv, ['--print']);
    const platform = takeFlagValue(argv, ['--platform']);
    const tag = takeFlagValue(argv, ['--tag']);
    // `--slug x` is accepted as a synonym for the positional so `--slug default`
    // reads as the deliberate opt-in it is. The positional wins if both appear.
    const slugFlag = takeFlagValue(argv, ['--slug']);
    // Positionals only AFTER every flag has been spliced out of argv — the flag
    // takers mutate it, so reading them earlier would see `--platform`'s VALUE
    // (`linux/amd64`) sitting there looking exactly like a slug.
    const positional = argv.filter((a) => !a.startsWith('-'));
    flags = {
      slug: positional[0] ?? slugFlag,
      platform,
      tag,
      noCache,
      layer: !noLayer,
      print,
      json: opts.json,
    };
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const manifest = resolveLocalManifest(process.cwd());
  if (!manifest) {
    process.stderr.write(
      `${status.err('No kortix.yaml here.')} ${C.dim}Run from your project root.${C.reset}\n`,
    );
    return 2;
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = loadLocalManifest(process.cwd())?.data ?? null;
  } catch (err) {
    process.stderr.write(`${status.err(`kortix.yaml doesn't parse: ${(err as Error).message}`)}\n`);
    return 2;
  }

  const resolved = resolveLocalTemplate(
    flags.slug,
    extractSandboxTemplates(parsed),
    extractSandboxDefault(parsed),
  );
  if ('error' in resolved) {
    process.stderr.write(`${status.err(resolved.error)}\n`);
    return 2;
  }
  const template = resolved.template;

  const projectRoot = dirname(manifest.path);
  const user = userDockerfileForTemplate(template, projectRoot);
  if ('error' in user) {
    process.stderr.write(`${status.err(user.error)}\n`);
    return 2;
  }

  const composed = composeLocalDockerfile(user.text, { layer: flags.layer });

  // `--print` is the no-side-effects mode: hand back the exact bytes that would
  // be fed to `docker build` (pipe it into your own build, diff it, read it) and
  // never touch Docker. It must stay quiet enough to redirect, so the preamble
  // below is skipped entirely.
  if (flags.print) {
    process.stdout.write(composed);
    return 0;
  }

  const platform = flags.platform ?? hostPlatform();
  const tag = flags.tag ?? `kortix-local/${template.slug}:latest`;

  if (!dockerAvailable()) {
    // Environment/usage, not a crash: exit 2, no stack trace, and point at the
    // half of the gate that needs nothing installed.
    process.stderr.write(
      `${status.err('Docker is not available (need the `docker` CLI AND a running daemon).')}\n` +
        `  ${C.dim}Start Docker Desktop / the daemon, or install Docker, then re-run.${C.reset}\n` +
        `  ${C.dim}The static checks need no Docker at all:${C.reset} ${C.cyan}kortix validate${C.reset}\n` +
        `  ${C.dim}To see the composed Dockerfile without building:${C.reset} ${C.cyan}kortix sandboxes build --local --print${C.reset}\n`,
    );
    return 2;
  }

  if (flags.json) {
    emitJson({
      slug: template.slug,
      dockerfile: user.source,
      platform,
      cloud_platform: 'linux/amd64',
      layer: flags.layer,
      tag,
      no_cache: flags.noCache,
    });
  } else {
    process.stdout.write('\n');
    process.stdout.write(
      `${status.info(`Building ${C.bold}${template.slug}${C.reset} from ${C.cyan}${user.source}${C.reset}`)}\n`,
    );
    // The single most misleading thing about a local build: it reads what's on
    // disk right now, while the cloud builds the committed HEAD it fetched.
    process.stdout.write(
      `  ${C.dim}Reads your WORKING TREE — the cloud builds the committed HEAD, so uncommitted edits are only tested here.${C.reset}\n`,
    );
    process.stdout.write(
      `  ${C.dim}Platform ${C.reset}${platform}${C.dim} · the cloud always builds ${C.reset}linux/amd64${C.dim}.${C.reset}\n`,
    );
    if (platform !== 'linux/amd64') {
      process.stdout.write(
        `  ${C.dim}For an exact match pass ${C.reset}${C.cyan}--platform linux/amd64${C.reset}${C.dim} — but under emulation it can take hours (texlive + libreoffice + chromium via QEMU).${C.reset}\n`,
      );
    }
    process.stdout.write(
      flags.layer
        ? `  ${C.dim}Kortix toolchain layer ${C.reset}on${C.dim} (apt + pip floor + opencode + chromium) — expect ${C.reset}10–25 min${C.dim} cold, minutes warm.${C.reset}\n`
        : `  ${C.dim}Kortix toolchain layer ${C.reset}off${C.dim} (--no-layer) — your Dockerfile alone; this skips the floor most build failures come from.${C.reset}\n`,
    );
    process.stdout.write(`  ${C.dim}Empty build context — your repo is not in it (same as the cloud).${C.reset}\n`);
    process.stdout.write(`  ${C.dim}Tag ${C.reset}${tag}\n\n`);
  }

  // Stream docker's own output straight through — it is already a good progress
  // display, and the CLI has no spinner primitive to wrap it in.
  const args = dockerBuildArgs({ platform, tag, noCache: flags.noCache });
  const res = spawnSync('docker', args, { input: composed, stdio: ['pipe', 'inherit', 'inherit'] });
  if (res.error) {
    process.stderr.write(`${status.err(`Couldn't run docker: ${res.error.message}`)}\n`);
    return 2;
  }
  if (res.status !== 0) {
    process.stderr.write(`\n${status.err(`Build failed (docker exited ${res.status}) — see the output above.`)}\n`);
    process.stderr.write(
      `  ${C.dim}Read the composed Dockerfile:${C.reset} ${C.cyan}kortix sandboxes build --local ${template.slug} --print${C.reset}\n`,
    );
    return 1;
  }

  process.stdout.write(`\n${status.ok(`Built ${C.bold}${tag}${C.reset}`)}\n`);
  process.stdout.write(
    `  ${C.yellow}Not a guarantee the cloud build passes.${C.reset}${C.dim} The cloud stages Kortix's own artifacts and appends a layer this build skips${platform !== 'linux/amd64' ? `, and it builds linux/amd64` : ''}.${C.reset}\n`,
  );
  process.stdout.write(`  ${C.dim}Run it: ${C.reset}${C.cyan}docker run --rm -it ${tag} bash${C.reset}\n`);
  return 0;
}
