/**
 * Where OpenCode reads its config from, as this box reports it.
 *
 * Under config releases the chain is: the desired release, then the last
 * release this box proved, then the platform's image default. `/workspace` is
 * NOT a step in it — OpenCode never boots from the session's checkout while
 * the feature is on.
 *
 * `workspace` is reachable only when config releases are OFF for the project,
 * which is the pre-release behaviour: OpenCode reads `<workspace>/<config dir>`.
 * The API emits no
 * release block for such a session, so `workspace` never reaches a client.
 */
export type ConfigSource = 'release' | 'workspace' | 'image-default'
/** The health `config` block. The converge response carries the same object. */
export interface ConfigReleaseReport {
  release_id: string | null
  desired_release_id: string | null
  source: ConfigSource
  /**
   * Always `follow-base`: a box runs the base branch's CURRENT config release.
   * `/workspace` stays the editable clone; an edit there reaches the box only
   * once it is pushed to the base branch. Null before the boot path ran.
   */
  mode: 'follow-base' | null
  proven: boolean
  fallback_reason: string | null
  failed_release_id: string | null
}
