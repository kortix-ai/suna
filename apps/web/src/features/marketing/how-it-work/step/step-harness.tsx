'use client';

import { PageHead, Panel, Row } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { RuntimeMark as OpenCode } from '@/features/icon/icons/open-code';
import { ListChecksIcon, ShieldCheckIcon, WrenchIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { WebPanelWrapper } from '../web-panel-wrapper';

/**
 * The real file, with real keys.
 *
 * `description`, `model` and `permission` are all in `BEHAVIOR_FRONTMATTER_KEYS`
 * (`apps/api/src/projects/lib/compile-agent-config.ts`), and the glob-map form
 * of `permission.bash` is the shape the v2 validator accepts. `tools:` and
 * `skills:` are NOT frontmatter keys — an earlier version of this panel showed
 * both, and neither would parse.
 */
const CONFIG: { id: string; line: string; tone?: 'muted' | 'accent' }[] = [
  { id: 'path', line: '# .kortix/opencode/agents/kortix.md', tone: 'muted' },
  { id: 'description', line: 'description: General knowledge worker' },
  { id: 'model', line: 'model: auto' },
  { id: 'permission', line: 'permission:' },
  { id: 'edit', line: '  edit: allow' },
  { id: 'bash', line: '  bash:' },
  { id: 'git-push', line: '    git push: deny', tone: 'accent' },
  { id: 'bash-fallback', line: "    '*': allow" },
];

const CAPABILITIES = [
  { icon: ListChecksIcon, title: 'Planning', sub: 'breaks a request into steps it finishes' },
  { icon: WrenchIcon, title: 'Tool use', sub: 'reads, edits, runs, fetches, calls connectors' },
  { icon: ShieldCheckIcon, title: 'Permission', sub: 'allow · ask · deny, per tool and per glob' },
];

/** Layer 03 — credit OpenCode plainly, and show the harness is an editable file. */
export function StepHarness(): ReactNode {
  return (
    <WebPanelWrapper activeTab="agents">
      <PageHead
        title="Agent harness"
        sub="Powered by OpenCode."
        action={
          <Badge variant="kortix" size="sm" className="shrink-0 rounded">
            Open source
          </Badge>
        }
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Panel
          title="kortix"
          count="primary"
          action={
            <span className="border-border bg-background flex size-7 items-center justify-center rounded-md border">
              <OpenCode className="size-4" />
            </span>
          }
        >
          <div className="bg-background px-4 py-3">
            <pre
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll this overflowing code region, as required by Axe.
              tabIndex={0}
              aria-label="Kortix agent harness configuration"
              className="overflow-x-auto font-mono text-[11.5px] leading-[1.75]"
            >
              <code>
                {CONFIG.map((entry) => (
                  <div
                    key={entry.id}
                    className={
                      entry.tone === 'muted'
                        ? 'text-muted-foreground/55'
                        : entry.tone === 'accent'
                          ? 'text-foreground'
                          : 'text-foreground/85'
                    }
                  >
                    {entry.line}
                  </div>
                ))}
              </code>
            </pre>
          </div>
        </Panel>

        <Panel title="What the harness does">
          {CAPABILITIES.map((capability) => (
            <Row
              key={capability.title}
              leading={
                <span className="border-border bg-background text-muted-foreground flex size-8 items-center justify-center rounded-md border">
                  <capability.icon className="size-4" />
                </span>
              }
              title={capability.title}
              subtitle={capability.sub}
            />
          ))}
        </Panel>
      </div>
    </WebPanelWrapper>
  );
}
