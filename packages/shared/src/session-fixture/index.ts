/**
 * @kortix/shared/session-fixture
 *
 * One deterministic session, as OpenCode wire messages + parts, that the
 * mobile and web debug screens render through their real transcript
 * components for side-by-side parity checks (COR-91). Pure data: no React,
 * no network.
 *
 * Import through the `./session-fixture` subpath only. The root barrel does
 * not re-export it, so production bundles never carry the fixture.
 */

export {
  FIXTURE_AGENT_NAMES,
  FIXTURE_IMAGE_DATA_URI,
  FIXTURE_SESSION_ID,
  FIXTURE_SESSION_TITLE,
  FIXTURE_T0,
  FIXTURE_TOOL_GROUPS,
  SESSION_FIXTURE,
  buildSessionFixture,
} from './session';
export { FIXTURE_MARKDOWN_DOCUMENT, FIXTURE_MARKDOWN_FENCES } from './markdown';
export type * from './types';
