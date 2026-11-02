/**
 * The agents segment of the tray, the row under the input:
 *
 *   ● 2 agents · 1 working        ? 1 agent · needs you        ✓ 1 agent · poet done
 *
 * It names what the open session started in the last hour (its child
 * sessions, its teammates, its workflow runs) and the messages held for the
 * person. Null while there is nothing, so the tray does not grow a segment on
 * a session that started nothing. `/agents` lists the rows behind it.
 *
 * It reads the same `useSessionAgents` queries as the panel, so the panel
 * opens on a warm cache.
 */

import { theme } from '../../theme.ts';
import { type SummaryMark, agentsSummary, recentOnly } from './agents-model.ts';
import { useSessionAgents } from './use-session-agents.ts';

export interface AgentsSummary {
  /** `2 agents · 1 working`, or null when the session started nothing. */
  text: string | null;
  mark: SummaryMark;
  /** One column: `?` needs you, `●` working, `!` failed, `✓` done. */
  glyph: string;
  /** The glyph's color, from the theme. */
  color: string;
}

const MARK: Record<SummaryMark, { glyph: string; color: string }> = {
  needs_input: { glyph: '?', color: theme.accent },
  working: { glyph: '●', color: theme.busy },
  failed: { glyph: '!', color: theme.danger },
  done: { glyph: '✓', color: theme.ok },
};

export function summaryOf(summary: ReturnType<typeof agentsSummary>): AgentsSummary {
  return { ...summary, ...MARK[summary.mark] };
}

export function useAgentsSummary(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
): AgentsSummary {
  const agents = useSessionAgents(projectId, sessionId);
  const recent = recentOnly(agents.groups, agents.runs, Date.now());
  return summaryOf(agentsSummary(recent.groups, recent.runs, agents.held.length));
}

/** The segment as tray spans: the colored mark, then the text. Nothing when null. */
export function AgentsSegment({ summary }: { summary: AgentsSummary }) {
  if (!summary.text) return null;
  return (
    <>
      <span fg={summary.color}>{`${summary.glyph} `}</span>
      <span fg={theme.dim}>{summary.text}</span>
    </>
  );
}
