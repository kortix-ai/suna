/**
 * Thin re-export of the Kortix starter for the API.
 *
 * The actual template lives as real files under
 * `packages/starter/templates/base/` — edit there, both the API's
 * `POST /v1/projects/create-repo` path and the `kortix init` CLI pick
 * up the change.
 */

export {
  getStarterFiles as buildStarterFiles,
  type StarterFile,
} from '@kortix/starter';
