/**
 * @deprecated Import from `@kortix/sdk` instead — the root entry is canonical.
 * This subpath still works and will keep working until the next major.
 *
 * The opencode-proxy SSE machine (`openEventStream`) that used to live behind
 * this subpath was DELETED in the Kortix Runtime API cutover: the live
 * connection is now `connectSessionStream` — one control-plane SSE per
 * session (`GET /projects/:pid/sessions/:sid/stream`) that multiplexes the
 * daemon's envelopes with the API's own snapshots.
 */
export {
  HEARTBEAT_TIMEOUT_MS,
  connectSessionStream,
  runtimeFrameToOpenCodeEvent,
  type ConnectSessionStreamOptions,
  type EventStreamHandle,
  type OpenCodeEvent,
  type RuntimeGapInfo,
  type RuntimeResyncInfo,
  type SessionStreamConnection,
  type SessionStreamReader,
  type SessionStreamTimers,
} from '../core/stream/session-stream-controller';
export {
  heartbeatGapEvent,
  narrowChatEvent,
  type KortixChatEvent,
  type KortixChatEventConnection,
  type KortixChatEventHeartbeatGap,
  type KortixChatEventMessageRemoved,
  type KortixChatEventMessageUpdated,
  type KortixChatEventPartRemoved,
  type KortixChatEventPartUpdated,
  type KortixChatEventPermissionAsked,
  type KortixChatEventPermissionReplied,
  type KortixChatEventQuestionAnswered,
  type KortixChatEventQuestionAsked,
  type KortixChatEventSessionError,
  type KortixChatEventSessionIdle,
  type KortixChatEventSessionStatus,
  type KortixChatEventTodoUpdated,
  type KortixChatQuestionInfo,
  type KortixChatQuestionOption,
  type KortixChatToolRef,
} from '../core/stream/chat-events';
