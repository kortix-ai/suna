'use client';

// @kortix/sdk/react — the complete OpenCode React hook surface, relocated
// verbatim from apps/web (every useOpenCode* hook, query-key factory, provider,
// and type). This is the single source of truth the web UI binds to.
export * from './opencode';

// `useSession`'s reply/error-classification surface — not (yet) re-exported by
// `./opencode`'s explicit barrel list, so re-exported directly here.
export {
  answerQuestion,
  answerPermission,
  rejectQuestion,
  classifySendError,
  type KortixSendError,
  type KortixSendErrorKind,
  type SendState,
} from './use-session';

// The billing/API error classes + helpers, relocated from apps/web's
// `lib/api/errors.ts` (byte-for-byte duplicate of `platform/api/errors.ts`) —
// hosts import the one SDK copy instead of keeping a parallel fork in sync.
export {
  BillingError,
  RequestTooLargeError,
  parseBillingError,
  isBillingError,
  formatBillingErrorForUI,
  type BillingErrorUI,
} from '../platform/api/errors';

// Fork-draft stash — see `session-start-stash.ts` for the full contract. Not
// (yet) re-exported by `./opencode`'s explicit barrel list, so re-exported
// directly here (same reasoning as the start-stash exports it lives beside).
export {
  forkDraftKey,
  writeForkDraft,
  readForkDraft,
  clearForkDraft,
} from './session-start-stash';
