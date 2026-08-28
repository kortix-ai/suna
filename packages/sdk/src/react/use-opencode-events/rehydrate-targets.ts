/**
 * Which sessions get their transcript re-read after an SSE gap or resync.
 *
 * The runtime stream is per (projectId, sessionId): `connectSessionStream`
 * opens ONE connection for ONE session, and its `onRuntimeGap` / `onRuntimeResync`
 * fire only for that session's frames. So the honest repair for "this stream
 * lost frames" is a tail read of THIS stream's session — nothing else.
 *
 * The rule this replaced re-read EVERY transcript the tab was holding on any
 * one stream's resync ("a tab holds one open session plus a handful of recently
 * viewed ones … re-read every transcript this tab is holding"). It was written
 * for a since-removed model where one multiplexed stream carried the whole tab;
 * under the owned per-session stream it is over-broad. Against the daemon's tiny
 * 2,000-frame replay ring (`kortix-event-bus.ts` `DEFAULT_RING_CAPACITY`), a
 * routine ~30-60s reconnect overflows the ring and resyncs (`gap-too-old`)
 * constantly — and every resync then dragged a multi-MB `?limit=50` tail page
 * down for every background session no gap had touched. That is the "why is
 * `/kortix/opencode/messages` hit so often, for two sessions at once" storm.
 *
 * A background session that genuinely lost frames is not abandoned: it runs its
 * own stream (repairing its own gaps) and re-reads on its next mount / tab-focus
 * (`reconcile('initial')` / `reconcile('visible')`). The eager refetch-all here
 * bought nothing those paths do not already cover, at a cost measured in tens of
 * MB per reconnect.
 */
export function sessionsNeedingRehydrate(streamSessionId: string): string[] {
  return streamSessionId ? [streamSessionId] : [];
}
