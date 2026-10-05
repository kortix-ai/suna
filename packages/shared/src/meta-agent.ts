export const META_AGENT_NAME = 'meta';
export const META_SANDBOX_SLUG = 'meta';
/** Meta — the platform coordinator's DISPLAY name. The internal id stays `meta`
 *  (it keys the grant, the sandbox slug, and the project default agent); this is
 *  the brand name every UI renders. */
export const META_AGENT_DISPLAY_NAME = 'Meta';

export function isMetaAgentName(name: string | null | undefined): boolean {
  return name === META_AGENT_NAME;
}
