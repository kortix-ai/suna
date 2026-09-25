/**
 * Transcript structure — how a turn's parts become the rows a reader sees.
 *
 * Segmentation (bursts vs text vs standalone tools), same-family step
 * grouping ("Read 6 files"), burst summaries ("Working · N steps"), thought
 * merging ("Thought for 12s"), plain-language narration, the working-turn
 * resolver, compaction state, and message timestamps. Pure data → data, no
 * framework, so web and mobile render the same transcript from one source.
 */
export * from './burst-summary';
export * from './compaction-state';
export * from './group-steps';
export * from './merge-steps';
export * from './message-time';
export * from './narration';
export * from './segment-turn';
export * from './session-activity-groups';
export * from './show-group';
export * from './step-label';
export * from './working-turn';
export * from './turn-busy-visibility';
