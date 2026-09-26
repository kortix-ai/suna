/**
 * Parser for memory search outputs (`ltm_search` / `mem_search` /
 * `memory_search`): JSON result lists and the text formats.
 *
 * The parser lives in `@kortix/shared/tool-output`, shared with apps/web.
 */

export {
  type MemorySearchHitSource,
  type ParsedMemorySearchHit,
  type ParsedMemorySearchOutput,
  parseMemorySearchOutput,
} from '@kortix/shared/tool-output';
