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
