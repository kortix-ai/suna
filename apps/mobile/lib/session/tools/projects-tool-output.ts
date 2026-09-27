/**
 * Parsers for Kortix orchestrator tool outputs (projects, connectors).
 *
 * The parsers live in `@kortix/shared/tool-output`, shared with apps/web.
 */

export {
  type ConnectorEntry,
  type ConnectorGetData,
  type ConnectorSetupData,
  type ProjectCreateData,
  type ProjectEntry,
  type ProjectGetData,
  type ProjectSelectData,
  parseConnectorGetOutput,
  parseConnectorListOutput,
  parseConnectorSetupOutput,
  parseProjectCreateOutput,
  parseProjectGetOutput,
  parseProjectListOutput,
  parseProjectSelectOutput,
} from '@kortix/shared/tool-output';
