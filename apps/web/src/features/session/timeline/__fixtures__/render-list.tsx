/**
 * `SessionTimelineList` over a fixture scenario, wired the way `SessionChat`
 * wires it: rows from `buildChatRows`, host facts from `deriveHostFacts`.
 */
import type { Turn } from '@/ui';

import { buildChatRows } from '../build-chat-rows';
import { deriveAnsweredQuestionIds } from '../project-rows';
import { SessionTimelineList, type SessionTimelineListProps } from '../session-timeline-list';
import { deriveHostFacts } from './host-facts';
import { FIXTURE_AGENT_NAMES, FIXTURE_SESSION_ID, type TimelineScenario } from './transcript';

const noopPermissionReply = async () => {};
const noopRewind = () => {};
const noopQueue = () => {};

export function scenarioListProps(
  scenario: TimelineScenario,
  overrides: Partial<SessionTimelineListProps> = {},
): SessionTimelineListProps {
  const facts = deriveHostFacts(scenario);
  const turnsById = new Map<string, Turn>(facts.turns.map((t) => [t.userMessage.info.id, t]));
  const rows = buildChatRows({
    messages: scenario.messages,
    activeUserMessageID: facts.workingTurnId ?? undefined,
    status: scenario.sessionStatus.type,
    standaloneCallIds: new Set(),
    answeredQuestionIds: deriveAnsweredQuestionIds(facts.turns, [], FIXTURE_SESSION_ID),
    prev: undefined,
  });
  return {
    rows,
    turnsById,
    turnRenderKeys: facts.turnRenderKeys,
    pendingTurnIds: facts.pendingTurnIds,
    interruptedTurnIds: facts.interruptedTurnIds,
    sessionWorking: scenario.lastTurnWorking,
    workingTurnId: facts.workingTurnId,
    planAnchorId: facts.planAnchorId,
    inboxRowsByMessageId: scenario.inboxRowsByMessageId,
    queueHeld: false,
    onQueueRemove: noopQueue,
    onQueueSendNow: noopQueue,
    onQueueRetry: noopQueue,
    sessionId: FIXTURE_SESSION_ID,
    sessionStatus: scenario.sessionStatus,
    permissions: [],
    questions: [],
    agentNames: FIXTURE_AGENT_NAMES,
    providers: undefined,
    commandMessages: scenario.commandMessages,
    commands: [],
    disableToolNavigation: false,
    onPermissionReply: noopPermissionReply,
    onRewind: noopRewind,
    rewindDisabled: scenario.rewindDisabled,
    ...overrides,
  };
}

export function ScenarioList({
  scenario,
  overrides,
}: {
  scenario: TimelineScenario;
  overrides?: Partial<SessionTimelineListProps>;
}) {
  return <SessionTimelineList {...scenarioListProps(scenario, overrides)} />;
}
