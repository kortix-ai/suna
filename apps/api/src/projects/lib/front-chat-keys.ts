/**
 * A front chat (flag `infinichat`): one endless My Kortix chat per person in
 * which the agent only talks; a worker session does the work. kortixd reads
 * the runtime_context key (`harness/pi/front.ts`, `FRONT_CONTEXT_KEY`).
 */
/** Session metadata a front chat carries. Server-managed: a request body cannot set it. */
export const FRONT_CHAT_METADATA_KEY = 'kortix_front';
/** The runtime_context key kortixd reads. Reserved (`kortix.`): only the platform sets it. */
export const FRONT_CHAT_CONTEXT_KEY = 'kortix.front';
/** The flag that gates it. */
export const FRONT_CHAT_FLAG = 'infinichat' as const;
