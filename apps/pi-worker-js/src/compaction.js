// COMPACTION — the transcript table is the LLM bill.
//
// Every other cost in this system is three to four orders of magnitude below a
// model turn. Storage is a rounding error; a tool call is ~17 ms. What actually
// costs money is re-sending the conversation on every turn: a 200-turn session
// carrying 50k tokens of context is ~10M input tokens, tens of dollars, and it
// grows with the square of the session length. So this is the one optimisation
// in the whole design that pays for itself.
//
// pi ships the machinery, but the full path (prepareCompaction/compact) works on
// pi's SESSION TREE — `Entry[]` with parent ids — and this cell stores a flat
// AgentMessage[] (README "Level 1"). The pieces that operate on messages are
// public and are what this uses:
//
//   estimateContextTokens(messages)                 what the context costs now
//   shouldCompact(tokens, contextWindow, settings)  pi's own threshold decision
//   estimateTokens(message)                         per-message, for the cut
//   createCompactionSummaryMessage(text, before, t) the message pi's loop knows
//
// The summary itself is generated with the SAME streamFn the agent uses, rather
// than pi's generateSummary, which needs a `Models` registry this design does
// not build. One extra model call, the same provider, and it works with the
// scripted model — so compaction is testable offline and for free.
import {
  COMPACTION_SUMMARY_PREFIX,
  DEFAULT_COMPACTION_SETTINGS,
  createCompactionSummaryMessage,
  estimateContextTokens,
  estimateTokens,
  shouldCompact,
} from "@earendil-works/pi-agent-core";

export const SUMMARY_PROMPT =
  "Summarise the conversation so far: what the user wants, what has been done, " +
  "which files and commands matter, and what is still open. Be specific and brief. " +
  "Do not continue the conversation.";

/**
 * SCALE THE SETTINGS TO THE WINDOW, or they are nonsense for small models.
 *
 * DEFAULT_COMPACTION_SETTINGS reserves 16384 tokens and keeps 20000, which is
 * right for a 200k-1M model and absurd below about 40k. Both failures were
 * measured, and both are silent:
 *
 *   reserveTokens > window  shouldCompact() compares against a NEGATIVE budget
 *                           and answers true for an empty transcript. Observed:
 *                           wouldCompact=true at 253 tokens in a 3000 window.
 *   keepRecentTokens > all  the cut then keeps everything, so compaction is
 *                           decided, attempted, and does nothing. Forever.
 *
 * A quarter of the window for the summary call and half for the retained tail
 * leaves a quarter of headroom, which is the shape the defaults have at 200k.
 */
export function settingsFor(contextWindow, settings = DEFAULT_COMPACTION_SETTINGS) {
  return {
    ...settings,
    reserveTokens: Math.max(256, Math.min(settings.reserveTokens, Math.floor(contextWindow / 4))),
    keepRecentTokens: Math.max(1, Math.min(settings.keepRecentTokens, Math.floor(contextWindow / 2))),
  };
}

/** What the transcript currently costs, and whether pi thinks it is time. */
export function compactionState(messages, contextWindow, settings = DEFAULT_COMPACTION_SETTINGS) {
  const scaled = settingsFor(contextWindow, settings);
  const estimate = estimateContextTokens(messages);
  return {
    tokens: estimate.tokens,
    contextWindow,
    should: scaled.enabled && shouldCompact(estimate.tokens, contextWindow, scaled),
    settings: scaled,
  };
}

/**
 * Split a transcript into the part to summarise and the tail to keep.
 *
 * Walks BACKWARDS accumulating `keepRecentTokens`, then advances the cut to the
 * next user message. Cutting mid-turn would leave a tool result whose call is in
 * the summary — a transcript the model cannot read, and the specific corruption
 * pi's own findCutPoint exists to avoid on the session-tree path.
 */
export function planCut(messages, keepRecentTokens) {
  let budget = keepRecentTokens;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    budget -= estimateTokens(messages[i]);
    if (budget <= 0) { cut = i; break; }
    cut = i;
  }
  // Advance to a turn boundary so the tail begins with a user message.
  //
  // AUDIT-EQUIVALENT: at cut === length, messages[length] is undefined and `?.role !== "user"` is true, so `<=` walks to length + 1 and the guard below resets it to length - 2 — the same place `<` reaches.
  while (cut < messages.length && messages[cut]?.role !== "user") cut++;
  // Never summarise everything: a transcript that is only a summary has lost
  // the turn in progress.
  if (cut >= messages.length) cut = Math.max(0, messages.length - 2);
  return { olderCount: cut, older: messages.slice(0, cut), tail: messages.slice(cut) };
}

/**
 * Compact if pi says so. Returns null when nothing was done, so the caller can
 * tell "not needed" from "done" without inspecting lengths.
 *
 * `summarise` runs one model call and returns text.
 */
export async function maybeCompact({ messages, contextWindow, summarise, settings = DEFAULT_COMPACTION_SETTINGS }) {
  const state = compactionState(messages, contextWindow, settings);
  if (!state.should) return null;

  const { older, tail, olderCount } = planCut(messages, state.settings.keepRecentTokens);
  // Nothing worth summarising — a huge single turn, for instance. Compacting
  // here would spend a model call to produce a longer transcript.
  if (olderCount === 0) return null;

  const summary = await summarise(older);
  const summaryMessage = createCompactionSummaryMessage(summary, state.tokens, Date.now());
  const next = [summaryMessage, ...tail];

  return {
    messages: next,
    tokensBefore: state.tokens,
    tokensAfter: estimateContextTokens(next).tokens,
    summarised: olderCount,
    kept: tail.length,
    summary,
  };
}

/** Does this message carry a compaction summary?
 *
 * It is its own ROLE, not a text block: createCompactionSummaryMessage returns
 * {role: "compactionSummary", summary, tokensBefore, timestamp}. An earlier
 * version of this looked for COMPACTION_SUMMARY_PREFIX inside `content` and
 * never matched — the prefix is what pi wraps the summary in when it renders
 * the message for the model, not how it stores it. */
export function isCompactionSummary(message) {
  return message?.role === "compactionSummary";
}

/** The prefix pi wraps a summary in when rendering it. Exported so a caller can
 *  recognise a rendered summary as well as a stored one. */
export { COMPACTION_SUMMARY_PREFIX };
