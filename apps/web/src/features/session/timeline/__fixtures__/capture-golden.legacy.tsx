/**
 * ONE-SHOT capture of the timeline golden from the LEGACY turn list.
 *
 * Renders `turns.map(TurnViewport > [CompactionDivider] > SessionTurn)` —
 * the exact block at `session-chat.tsx` `{turns.map((turn, turnIndex) => …)}`
 * — for every fixture scenario and writes `golden.<scenario>.html` beside this
 * file. Run ONCE on the pre-refactor tree:
 *
 *   cd apps/web && bun run src/features/session/timeline/__fixtures__/capture-golden.legacy.tsx
 *
 * This file is deleted in the same change that deletes `SessionTurn`; the
 * golden files it wrote stay, and `session-timeline-list.golden.test.tsx`
 * holds `SessionTimelineList` to them.
 */
import './clock';

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CompactionDivider, SessionTurn } from '../../session-chat';
import { TurnViewport } from '../../turn/turn-viewport';
import { deriveHostFacts } from './host-facts';
import { normalizeMarkup, renderWithProviders } from './render';
import { FIXTURE_AGENT_NAMES, FIXTURE_SESSION_ID, scenarios } from './transcript';

const noopPermissionReply = async () => {};
const noopRewind = () => {};
const noopQueue = () => {};

for (const scenario of scenarios) {
  const facts = deriveHostFacts(scenario);
  const { turns } = facts;
  const markup = renderWithProviders(
    <>
      {turns.map((turn, turnIndex) => {
        const hasCompaction =
          turn.assistantMessages.some((msg) => (msg.info as any).summary === true) ||
          turn.assistantMessages.some((msg) => msg.parts.some((p) => p.type === 'compaction'));
        const id = turn.userMessage.info.id;
        return (
          <TurnViewport
            key={facts.turnRenderKeys.get(id)}
            turnId={id}
            className={
              turnIndex === 0
                ? ''
                : scenario.lastTurnWorking &&
                    facts.pendingTurnIds.has(id) &&
                    facts.pendingTurnIds.has(turns[turnIndex - 1].userMessage.info.id)
                  ? 'mt-3'
                  : 'mt-12'
            }
          >
            {hasCompaction && <CompactionDivider />}
            <SessionTurn
              turn={turn}
              isLast={id === facts.lastUserMessageId}
              ownsPlan={id === facts.planAnchorId}
              sessionId={FIXTURE_SESSION_ID}
              sessionStatus={scenario.sessionStatus}
              permissions={[]}
              questions={[]}
              agentNames={FIXTURE_AGENT_NAMES}
              isFirstTurn={turnIndex === 0}
              sessionWorking={scenario.lastTurnWorking}
              isWorkingTurn={id === facts.workingTurnId}
              pending={scenario.lastTurnWorking && facts.pendingTurnIds.has(id)}
              queueRow={scenario.inboxRowsByMessageId.get(id) ?? null}
              queueHeld={false}
              onQueueRemove={noopQueue}
              onQueueSendNow={noopQueue}
              onQueueRetry={noopQueue}
              interruptedBeforeRun={facts.interruptedTurnIds.has(id)}
              isCompaction={hasCompaction}
              providers={undefined}
              commandMessages={scenario.commandMessages}
              commands={[]}
              disableToolNavigation={false}
              onPermissionReply={noopPermissionReply}
              onRewind={noopRewind}
              rewindDisabled={scenario.rewindDisabled}
            />
          </TurnViewport>
        );
      })}
    </>,
  );
  const out = fileURLToPath(new URL(`./golden.${scenario.name}.html`, import.meta.url));
  writeFileSync(out, normalizeMarkup(markup));
  console.log(`${scenario.name}: ${markup.length} bytes -> ${out}`);
}
