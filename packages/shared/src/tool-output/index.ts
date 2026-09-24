/**
 * `@kortix/shared/tool-output`: the parsers the web and mobile tool renderers
 * run on tool output.
 *
 * Tool output is text an attacker can choose: `read` returns file contents,
 * `webfetch` returns web pages, and `bash` returns command output. Every
 * viewer of a session parses every tool part in it, so a parser that is
 * super-linear in its input freezes the tab or the phone of each person who
 * opens the session. Each parser here reads its input in linear time and
 * returns exactly what the regex it replaces returned; the tests next to each
 * module pin that against the old code on thousands of random inputs.
 */

export { type BackgroundWorker, parseBackgroundWorkers } from './background-workers';
export { looksLikeMarkdown } from './markdown-detect';
export { sandboxMediaPath, withoutEdgeQuotes, withoutTrailingSlashes } from './media-path';
export {
  type ParsedLtmMemory,
  type ParsedMemoryEntry,
  type ParsedObservationMemory,
  parseMemoryEntryOutput,
} from './memory-entry';
export {
  type MemorySearchHitSource,
  type ParsedMemorySearchHit,
  type ParsedMemorySearchOutput,
  parseMemorySearchOutput,
} from './memory-search';
export {
  type GrepFileGroup,
  type GrepMatch,
  type ParsedSessionMessage,
  type ParsedSessionMeta,
  parseGrepOutput,
  parseSessionMessagesOutput,
  parseSessionMetadataOutput,
} from './session-dump';
export { type ParsedSessionGetOutput, parseSessionGetOutput } from './session-get';
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
} from './projects';
export { type SessionSearchHit, parseSessionSearchHits } from './session-search';
export { skillDocumentBody } from './skill';
export { ptyOutputBlock, ptySpawnedBody, stripBashMetadata } from './tags';
export { type TriggerLine, parseTriggerLines } from './triggers';
