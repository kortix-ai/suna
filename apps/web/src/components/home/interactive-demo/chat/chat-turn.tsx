'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { Badge } from '@/components/ui/badge';
import { AnimatePresence, motion } from 'motion/react';
import { Reveal } from '../../reveal';
import { SkillsRead } from './skill-reads';
import { ToolCard } from './tool-card';
import type { DemoConversation } from './use-demo-conversation';

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="bg-card flex max-w-[90%] flex-col overflow-hidden rounded-3xl rounded-br-lg border">
        <div className="px-4 py-3">
          <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">{text}</div>
        </div>
      </div>
    </div>
  );
}

export function AssistantTurn({
  convo,
  onSkillClick,
}: {
  convo: DemoConversation;
  onSkillClick?: (name: string) => void;
}) {
  const sc = convo.scenario;
  if (!sc) return null;
  const isDone = convo.phase === 'done';
  const thinking = convo.phase === 'thinking';
  const skills = sc.skills ?? [];

  return (
    <Reveal>
      <div className="mb-2 flex items-center gap-2">
        <AgentAvatar isDefault size={22} />
        <span className="text-foreground text-sm font-medium">Kortix</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={isDone ? 'done' : 'working'}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Badge size="sm" variant={isDone ? 'badgeSuccess' : 'secondary'}>
              {isDone ? 'done' : 'working'}
            </Badge>
          </motion.span>
        </AnimatePresence>
        <span className="text-muted-foreground ml-auto text-xs">just now</span>
      </div>

      <AnimatePresence>
        {thinking && skills.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
            className="flex items-center gap-1.5 py-0.5"
          >
            <span className="relative flex size-2.5 shrink-0">
              <span className="bg-muted-foreground/30 absolute inline-flex h-full w-full animate-ping rounded-full" />
              <span className="bg-muted-foreground/50 relative inline-flex size-2.5 rounded-full" />
            </span>
            <AnimatedThinkingText
              statusText={sc.thinkingLabel}
              className="text-muted-foreground text-xs"
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="space-y-3">
        {skills.length > 0 && (
          <SkillsRead skills={skills} phase={convo.phase} onSkillClick={onSkillClick} />
        )}
        {sc.steps.map((step, i) => {
          if (i >= convo.startedSteps) return null;
          if (step.kind === 'tool') {
            return (
              <ToolCard
                key={step.id}
                icon={step.icon}
                tool={step.tool}
                title={step.title}
                done={convo.doneToolIds.has(step.id)}
                body={step.body}
              />
            );
          }
          if (step.kind === 'text') {
            const content = convo.streamed[step.id] ?? '';
            const streaming = convo.phase !== 'done' && content.length < step.markdown.length;
            return (
              <div key={step.id} className="text-sm">
                <UnifiedMarkdown content={content} isStreaming={streaming} />
              </div>
            );
          }
          return <div key={step.id}>{step.render()}</div>;
        })}
      </div>
    </Reveal>
  );
}
