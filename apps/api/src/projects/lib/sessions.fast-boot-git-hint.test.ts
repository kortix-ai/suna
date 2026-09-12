import { describe, expect, test } from 'bun:test';

async function sessionsSource(): Promise<string> {
  return Bun.file(new URL('./sessions.ts', import.meta.url)).text();
}

async function monitorBoxProvisionSource(): Promise<string> {
  return Bun.file(new URL('./monitor-box-provision.ts', import.meta.url)).text();
}

describe('session fast boot Git hint cache', () => {
  test('resolves a validated cache entry through the authenticated project', async () => {
    const source = await sessionsSource();
    const authPromise = source.indexOf('const projectWithGitAuthPromise');
    const gate = source.indexOf('config.KORTIX_FAST_GIT_BOOT_ENABLED', authPromise);
    const resolver = source.indexOf('resolveFastBootGitHintWithCache(', gate);
    const provision = source.indexOf('provisionSessionSandbox({', resolver);
    expect(authPromise).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(authPromise);
    expect(resolver).toBeGreaterThan(gate);
    expect(provision).toBeGreaterThan(resolver);
    expect(source.slice(gate, provision)).toContain('projectWithGitAuthPromise');
    expect(source.slice(resolver, provision)).toContain('project.metadata');
  });

  test('keeps the cache lookup inside the existing two-second boot deadline', async () => {
    const source = await sessionsSource();
    // Anchor on the hint declaration, not on the gate: the gate now sits INSIDE
    // an early-return whose own text the slice would otherwise cut in half.
    const hint = source.indexOf('const fastBootGitHintPromise');
    const provision = source.indexOf('provisionSessionSandbox({', hint);
    const fastBootBlock = source.slice(hint, provision);
    expect(fastBootBlock).toContain('setTimeout(() => resolve(undefined), 2_000)');
    expect(fastBootBlock).toContain('clearTimeout(fastBootHintTimeout)');
    // A disabled gate resolves to `undefined` without touching Git. Config
    // Provider v1 turned the old ternary into an early return so the snapshot
    // pin can answer first; the "no hint work when disabled" property is the
    // same one, still pinned.
    expect(fastBootBlock).toContain(
      'if (piWorkerBoot || !config.KORTIX_FAST_GIT_BOOT_ENABLED) return undefined;',
    );
  });

  test('a pinned repository snapshot replaces the Git hint entirely', async () => {
    const source = await sessionsSource();
    const hint = source.indexOf('const fastBootGitHintPromise');
    const gate = source.indexOf('config.KORTIX_FAST_GIT_BOOT_ENABLED', hint);
    const block = source.slice(hint, gate);
    // The pin is checked BEFORE the gate, and its branch returns without ever
    // reaching resolveFastBootGitHintWithCache — that call is what performs the
    // `ls-remote` plus mirror refresh a prepared start must not do.
    expect(block).toContain('if (pin) {');
    expect(block).toContain('resolveOpencodeConfigDirFromSnapshot(pin.row, project.manifestPath)');
    expect(block).not.toContain('resolveFastBootGitHintWithCache');
    // A pinned snapshot also suppresses the compiled-boot prebuild, which would
    // otherwise refresh the mirror for an artifact nothing consumes.
    expect(source).toContain('!pin && authedProject && hint?.baseSha');
    // The authoring credential is LAZY on a prepared start: `withProjectGitAuth`
    // mints a GitHub token, and a prepared start must attempt no GitHub call.
    expect(source).toContain('const preparedStart = governingPin !== null;');
    expect(source).toContain('const projectWithGitAuthPromise = preparedStart');
    // …and the remote session branch, which is authoring work, is deferred.
    expect(source).toContain('const deferRemoteBranch = preparedStart;');
  });

  test('gates every session allocation before a full-repository image can be selected', async () => {
    const [sessions, allocator, actions, shared, sandbox] = await Promise.all([
      sessionsSource(),
      Bun.file(new URL('./session-runtime-allocator.ts', import.meta.url)).text(),
      Bun.file(new URL('../session-lifecycle/actions.ts', import.meta.url)).text(),
      Bun.file(new URL('../routes/shared.ts', import.meta.url)).text(),
      Bun.file(new URL('../../platform/services/session-sandbox.ts', import.meta.url)).text(),
    ]);

    // The pi worker boot (harness/worker split) wraps the gate in a ternary:
    // a pi session never receives a project image, every other session still
    // goes through projectImageAllowedForSession. Both halves are pinned.
    expect(sessions).toContain('allowProjectImage: piWorkerBoot');
    expect(sessions).toContain(': projectImageAllowedForSession(agentName, workspaceMode)');
    expect(actions).toContain('allowProjectImage: projectImageAllowedForSession(');
    expect(shared).toContain('allowProjectImage: projectImageAllowedForSession(');
    expect(actions).toContain('restoreSessionBranch: true');
    expect(shared).toContain('restoreSessionBranch: true');
    expect(allocator).toContain('allowProjectImage: input.allowProjectImage');
    expect(sandbox).toContain('allowProjectImage: opts.allowProjectImage');
  });

  test('keeps persistent monitor boxes on the shared image', async () => {
    const source = await monitorBoxProvisionSource();
    const ensureCall = source.slice(
      source.indexOf('ensureSandboxImage(gitProject'),
      source.indexOf('});', source.indexOf('ensureSandboxImage(gitProject')),
    );

    expect(ensureCall).toContain('allowProjectImage: false');
  });
});

describe('pi worker boot skips the OpenCode boot chain', () => {
  test('the hint, the compiled-boot prebuild, and the env build are all forked on piWorkerBoot', async () => {
    const source = await sessionsSource();
    // Hint: a worker never clones, so the scaffold/delta race must not hold
    // its env build (measured 1.1–2.4 s on dev 2026-08-27).
    expect(source).toContain('if (piWorkerBoot || !config.KORTIX_FAST_GIT_BOOT_ENABLED) return undefined;');
    // A worker never pins a snapshot either — same reason, same fork.
    expect(source).toContain('if (piWorkerBoot || platformMetaAgent || !createSnapshotPin) return null;');
    // OpenCode compiled-boot artifacts are daemon-path-only.
    expect(source).toContain("!piWorkerBoot && config.KORTIX_COMPILED_BOOT_MODE !== 'off'");
    // The env fork must sit before the OpenCode builder in the same chain.
    const fork = source.indexOf('const envPromise = piWorkerBoot');
    const slim = source.indexOf('buildPiWorkerSessionEnvVars({', fork);
    const full = source.indexOf('buildSessionSandboxEnvVars({', fork);
    expect(fork).toBeGreaterThan(-1);
    expect(slim).toBeGreaterThan(fork);
    expect(full).toBeGreaterThan(slim);
  });

  test('the pi decision resolves runtime and tip in one parallel round trip', async () => {
    const source = await sessionsSource();
    const decision = source.indexOf("resolveFeatureFlag(project.metadata, 'pi_worker')");
    expect(decision).toBeGreaterThan(-1);
    const parallel = source.indexOf('[runtime, sha] = await Promise.all([', decision);
    expect(parallel).toBeGreaterThan(decision);
    const block = source.slice(parallel, source.indexOf(']);', parallel));
    expect(block).toContain('resolveManifestRuntime(authedProject, baseRef)');
    expect(block).toContain('resolveCommitSha(authedProject, ref).catch(() => null)');
  });

  test('a pinned snapshot answers the pi decision with no Git and no GitHub', async () => {
    const source = await sessionsSource();
    const decision = source.indexOf("resolveFeatureFlag(project.metadata, 'pi_worker')");
    // Slice the PINNED branch only: the else branch legitimately keeps the Git
    // resolution, so including it would make the negative assertions vacuous.
    const branchStart = source.indexOf('if (pinnedSnapshotRow) {', decision);
    const pinned = source.slice(branchStart, source.indexOf('} else {', branchStart));
    // The pinned branch reads the manifest from the archive and takes the SHA
    // from the pin. `withProjectGitAuth` and `resolveCommitSha` — an
    // installation-token mint and an `ls-remote` — stay in the else branch.
    expect(pinned).toContain('if (pinnedSnapshotRow) {');
    expect(pinned).toContain('resolveManifestRuntime(project, baseRef, pinnedSnapshotRow)');
    expect(pinned).toContain('sha = pinnedSnapshotRow.commitSha;');
    expect(pinned).not.toContain('withProjectGitAuth');
    expect(pinned).not.toContain('resolveCommitSha');
  });

  test('shadow mode changes nothing about the session', async () => {
    const source = await sessionsSource();
    // A shadow pin must not reach the sandbox env, the hint chain, or the
    // authoring decisions. Only a GOVERNING pin (prefer/required) does.
    expect(source).toContain(
      'createSnapshotPin?.pinned && createSnapshotPin.pin.governs ? createSnapshotPin.pin : null',
    );
    expect(source).toContain('const pinnedSnapshotRow = governingPin?.row ?? null;');
    expect(source).toContain('if (!createSnapshotPin.pinned || !createSnapshotPin.pin.governs) return null;');
  });

  test('required mode fails closed instead of falling through to the clone path', async () => {
    const source = await sessionsSource();
    // A miss or a thrown pin in `required` returns an error to the caller. The
    // old shape swallowed both into `null` and quietly used the Git path, which
    // would have made the mode inert.
    expect(source).toContain('const failure = requiredModeFailure(createSnapshotPin);');
    expect(source).toContain("code: 'REPO_SNAPSHOT_UNAVAILABLE'");
    // Per-project: the canary cohort decides whether THIS project fails closed.
    expect(source).toContain("} else if (repoSnapshotModeForProject(project.projectId) === 'required') {");
    // An explicit revision reaches the pin; it is not replaced by the tip.
    expect(source).toContain('const requestedSha = normalizeString(body.base_sha ?? body.baseSha);');
    expect(source).toContain('requestedSha,');
  });
});

describe('pi worker env model override', () => {
  test('only an explicit session model overrides the baked agent model', async () => {
    const source = await sessionsSource();
    const fork = source.indexOf('const envPromise = piWorkerBoot');
    const slim = source.indexOf('buildPiWorkerSessionEnvVars({', fork);
    const block = source.slice(slim, source.indexOf('apiUrl:', slim));
    expect(block).toContain("opencodeModelSource === 'explicit'");
    // Env refs reach the worker verbatim, so the gateway prefix is stripped
    // server-side (the baked path de-prefixes inside the worker).
    expect(block).toContain("replace(/^kortix\\//, '')");
  });
});
