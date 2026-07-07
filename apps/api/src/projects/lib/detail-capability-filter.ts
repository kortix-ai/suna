// GET /:projectId/detail bundles several read surfaces (the config summary's
// agents/skills/commands + raw customization config, and the repo file list)
// behind ONE coarse project.read floor. To keep each capability checkbox
// authoritative WITHOUT 403-ing the whole workspace load, the handler resolves
// the caller's per-leaf read capabilities and passes them here to blank out the
// sections they can't read. Pure + exported so the gating is unit-tested
// independent of git/DB (the handler just supplies the resolved booleans).

export interface DetailCaps {
  /** project.file.read — the repo file list. */
  canFiles: boolean;
  /** project.agent.read — the agents summary + discovery mode. */
  canAgents: boolean;
  /** project.skill.read — the skills summary. */
  canSkills: boolean;
  /** project.command.read — the slash-commands summary. */
  canCommands: boolean;
  /** project.customize.read — the raw project config (kortix.toml / opencode). */
  canCustomize: boolean;
}

/**
 * Blank out the /detail sections the caller lacks the leaf for. Structural
 * signals (is_kortix_repo, signals) are always preserved so the shell renders;
 * only the resource lists / raw config are emptied. Files are capped at 300 (the
 * same cap the handler used inline) and dropped entirely without file.read.
 */
export function applyDetailCapabilityFilter<C extends Record<string, unknown>, F>(
  config: C,
  visibleFiles: F[],
  caps: DetailCaps,
): { config: C; files: F[]; file_count: number } {
  const gatedConfig = {
    ...config,
    ...(caps.canAgents ? {} : { agents: [], agent_discovery: null }),
    ...(caps.canSkills ? {} : { skills: [] }),
    ...(caps.canCommands ? {} : { commands: [] }),
    ...(caps.canCustomize
      ? {}
      : { manifest_raw: null, manifest: {}, env: [], open_code_raw: null, open_code_default_agent: null }),
  } as C;
  return {
    config: gatedConfig,
    files: caps.canFiles ? visibleFiles.slice(0, 300) : [],
    file_count: caps.canFiles ? visibleFiles.length : 0,
  };
}
