/** Set by the API (projects/lib/genui-env.ts) at provisioning. Boot-only. */
export const GENUI_ENV_NAME = 'KORTIX_GENUI'

/** The managed system skill that teaches the generative UI catalog (packages/starter/templates/managed/skills). */
export const GENUI_SKILL_NAME = 'kortix-genui'

/** The project's `genui` flag: on lists the kortix-genui skill, off hides it. */
export function genuiEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env[GENUI_ENV_NAME] === '1'
}
