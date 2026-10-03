import {
  INBOX_OBSERVATION_MAX_MS,
  OPTIMISTIC_ABORT_MAX_MS,
  OPTIMISTIC_RECEIPT_MAX_MS,
  SERVER_OBSERVATION_MAX_MS,
  STREAM_OBSERVATION_MAX_MS,
  type WorkingInputs,
} from './working';

/** Freshness and local-action floors: a read issued before acknowledgement cannot answer for that action. */
export function workingEvidence({
  optimistic,
  abort,
  inbox,
  server,
  stream,
  activity,
  nowMs,
}: WorkingInputs) {
  const receiptLive = !!optimistic && nowMs - optimistic.atMs < OPTIMISTIC_RECEIPT_MAX_MS;
  const abortLive = !!abort && nowMs - abort.atMs < OPTIMISTIC_ABORT_MAX_MS;
  return {
    receiptLive,
    receiptTurnId: optimistic
      ? optimistic.turnId === undefined
        ? optimistic.messageId
        : optimistic.turnId
      : null,
    serverFloor: receiptLive
      ? (optimistic?.acceptedAtMs ?? Number.POSITIVE_INFINITY)
      : Number.NEGATIVE_INFINITY,
    streamFloor: receiptLive ? optimistic?.atMs : Number.NEGATIVE_INFINITY,
    abortLive,
    abortFloor: abortLive
      ? (abort?.settledAtMs ?? Number.POSITIVE_INFINITY)
      : Number.NEGATIVE_INFINITY,
    serverFresh: !!server && nowMs - server.atMs <= SERVER_OBSERVATION_MAX_MS,
    streamFresh: !!stream && nowMs - stream.atMs <= STREAM_OBSERVATION_MAX_MS,
    inboxFresh: !!inbox && nowMs - inbox.atMs <= INBOX_OBSERVATION_MAX_MS,
    activityFresh: !!activity && nowMs - activity.atMs <= STREAM_OBSERVATION_MAX_MS,
  };
}
