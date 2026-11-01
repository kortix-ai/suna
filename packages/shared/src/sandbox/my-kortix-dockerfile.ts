import { AGENT_BROWSER_VERSION } from '../runtime-versions';
import type { KortixArtifactLayerOpts } from './defaults';
import { PLATFORM_DEFAULT_USER_DOCKERFILE, buildLayeredDockerfile } from './dockerfile-layer';

/** My Kortix's image takes the same staged artifacts as every Kortix image. */
export type MyKortixSandboxDockerfileOptions = KortixArtifactLayerOpts;

/**
 * Render the image of My Kortix, the built-in agent (slug `mykortix`).
 *
 * The platform default image, verbatim: everything built into any Kortix
 * sandbox (the defaults, the desktop, Chromium with agent-browser, the
 * document tools, Claude Code). Whatever a later change adds to the platform
 * default reaches My Kortix with no edit here. My Kortix appends only what
 * makes it My Kortix. Its instructions are not in the image: the API serves
 * them in the compiled config (`MY_KORTIX_PROMPT`,
 * apps/api/src/projects/lib/my-kortix-prompt.ts), so a wording change needs no
 * image rebuild.
 */
export function buildMyKortixSandboxDockerfile(options: MyKortixSandboxDockerfileOptions): string {
  return (
    buildLayeredDockerfile({
      userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE,
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      ...options,
    }) +
    [
      '# ─── My Kortix ───',
      // My Kortix has no project checkout: the daemon must not clone one.
      'ENV KORTIX_PROJECT_AUTO_CLONE=0',
      '',
    ].join('\n')
  );
}
