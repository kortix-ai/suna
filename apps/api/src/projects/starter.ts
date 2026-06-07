/**
 * Thin re-export of the Kortix starter for the API.
 *
 * The actual templates live as real files under `packages/starter/templates/`
 * — edit there, both the API's project creation paths and the `kortix init`
 * CLI pick up the change.
 */

export {
  DEFAULT_STARTER_TEMPLATE_ID,
  getStarterFiles as buildStarterFiles,
  normalizeStarterTemplateId,
} from '@kortix/starter';
