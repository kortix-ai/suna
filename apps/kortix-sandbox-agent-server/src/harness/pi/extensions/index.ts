/**
 * The system extensions every pi session loads, in load order. Add one here.
 * Each is compiled into kortixd: loading costs a function call, not an import
 * from disk or the network.
 */
import type { SystemExtension } from './runner'
import subagents from './subagents'

export const SYSTEM_EXTENSIONS: readonly SystemExtension[] = [{ name: 'subagents', factory: subagents }]
