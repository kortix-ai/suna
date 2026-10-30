import {
  type KortixArtifactLayerOpts,
  SANDBOX_BASE_IMAGE,
  kortixDefaultsSetup,
  kortixDefaultsTail,
} from './defaults';

/** My Kortix's image takes the same staged artifacts as every Kortix image. */
export type MyKortixSandboxDockerfileOptions = KortixArtifactLayerOpts;

/**
 * Render the image of My Kortix, the built-in agent (slug `mykortix`).
 *
 * The Kortix defaults (defaults.ts), exactly as every other Kortix image has
 * them, on the platform default's base. No project-agent workstation: My
 * Kortix delegates project work, browsing and desktop work to a project
 * agent's session. Its instructions are not in the image: the API serves them
 * in the compiled config (`MY_KORTIX_PROMPT`,
 * apps/api/src/projects/lib/my-kortix-prompt.ts), so a wording change needs no
 * image rebuild.
 */
export function buildMyKortixSandboxDockerfile(options: MyKortixSandboxDockerfileOptions): string {
  return [
    '# syntax=docker/dockerfile:1.7',
    `FROM ${SANDBOX_BASE_IMAGE}`,
    '',
    kortixDefaultsSetup() + kortixDefaultsTail(options),
    '# ─── My Kortix ───',
    // My Kortix has no project checkout: the daemon must not clone one.
    'ENV KORTIX_PROJECT_AUTO_CLONE=0',
    '',
  ].join('\n');
}
