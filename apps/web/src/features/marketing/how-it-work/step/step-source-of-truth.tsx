'use client';

import { cn } from '@/lib/utils';
import {
  BrainIcon,
  CpuIcon,
  GitBranchIcon,
  IconWeight,
  LightningIcon,
  PlugsConnectedIcon,
  RobotIcon,
  ShieldIcon,
  SparkleIcon,
} from '@phosphor-icons/react';
import { m, useReducedMotion, type Transition } from 'motion/react';
import { useState, type ComponentType, type ReactNode } from 'react';
import { useStepShowcaseStart } from '../use-step-showcase';

/**
 * Layer 01 — the repo IS the company, drawn as an orthogonal schematic.
 *
 * One trunk line leaves the repo node and runs off the right edge of the
 * panel; seven nodes hang off it on strict 90° drops, alternating above and
 * below. The rightmost nodes are deliberately cut by the panel border — the
 * crop says "this row keeps going", which is the point: the repo holds more
 * than a diagram can politely fit.
 *
 * GEOMETRY. Nodes and edges share one CSS percentage space. Each node is
 * positioned AT ITS PORT (bottom-center for the top row, top-center for the
 * bottom row), and every edge is a 1px div spanning exactly from the trunk
 * row to the node's row — line and port meet by construction. No SVG: a
 * div has no dash math to go wrong (Motion's `pathLength` draw left
 * per-axis dash residue under `preserveAspectRatio="none"`), and it draws
 * with `scaleX`/`scaleY`, which composites.
 *
 * ACCURACY GATE — every node below is something that verifiably lives in the
 * repo, and these rules still bind:
 *   - Connectors, Triggers and Machine are all declared in `kortix.yaml` —
 *     that is the manifest's whole job (machine image, connectors, triggers).
 *   - Agent BEHAVIOUR (model, mode, prompt, permission) is a hard error in
 *     `kortix.yaml` — it lives in `.kortix/opencode/agents/<name>.md`. The
 *     manifest grants; it does not configure the agent. The "Rules" node says
 *     "what each agent may touch" for exactly this reason.
 *   - `channels:` is rejected outright in version 2 — channel routing is live
 *     project state, not manifest config. Never add a Channels node.
 *   - There is deliberately NO "Members" node: members and roles are live
 *     project state managed in the control plane, not files in the repo.
 *     Adding one would claim repo-ness the product does not have.
 *   - `secrets:` grants secret NAMES, and a granted secret IS a real env
 *     value inside the session. Never write that it is hidden from the model.
 * Paths are the shipped starter template (`packages/starter/templates/base`),
 * checked file by file: `kortix.yaml` at the repo ROOT, everything else under
 * `.kortix/`. `acme-co` is a placeholder, not a customer.
 */

type NodeId =
  | 'agents'
  | 'skills'
  | 'memory'
  | 'rules'
  | 'connectors'
  | 'triggers'
  | 'machine';

const NODES: {
  id: NodeId;
  icon: ComponentType<{ className?: string; weight?: IconWeight }>;
  label: string;
  note: string;
  path: string;
  /** Stub position along the trunk, percent. */
  x: number;
  /** Which side of the trunk the node sits on. */
  side: 'up' | 'down';
}[] = [
  {
    id: 'agents',
    icon: RobotIcon,
    label: 'Agents',
    note: 'who does the work',
    path: '.kortix/opencode/agents/',
    x: 34,
    side: 'up',
  },
  {
    id: 'skills',
    icon: SparkleIcon,
    label: 'Skills',
    note: 'how your company does a job',
    path: '.kortix/opencode/skills/',
    x: 46,
    side: 'down',
  },
  {
    id: 'memory',
    icon: BrainIcon,
    label: 'Memory',
    note: 'what it has learned so far',
    path: '.kortix/memory/',
    x: 58,
    side: 'up',
  },
  {
    id: 'rules',
    icon: ShieldIcon,
    label: 'Rules',
    note: 'what each agent may touch',
    path: 'kortix.yaml',
    x: 70,
    side: 'down',
  },
  {
    id: 'triggers',
    icon: LightningIcon,
    label: 'Triggers',
    note: 'when work starts on its own',
    path: 'kortix.yaml',
    x: 82,
    side: 'up',
  },
  {
    id: 'connectors',
    icon: PlugsConnectedIcon,
    label: 'Connectors',
    note: 'the tools it is wired to',
    path: 'kortix.yaml',
    x: 94,
    side: 'down',
  },
  {
    id: 'machine',
    icon: CpuIcon,
    label: 'Machine',
    note: 'the image sessions boot',
    path: 'kortix.yaml',
    x: 104,
    side: 'up',
  },
];

/** The trunk's row, and the two rows the stubs reach. All in percent. */
const TRUNK_Y = 46;
const UP_Y = 32;
const DOWN_Y = 60;
/** The repo's output port — the trunk starts here and runs off the edge. */
const REPO = { x: 22, y: TRUNK_Y };
const TRUNK_END = 112;

const ENTER: Transition = { duration: 0.4, ease: [0.23, 1, 0.32, 1] };
/** The trunk draws at constant speed — a line crossing a canvas is time
 *  passing, and time passes linearly. */
const TRUNK_AT = 0.15;
const TRUNK_DURATION = 0.8;
/** A stub fires the moment the trunk's tip passes its junction. */
const stubAt = (x: number): number =>
  TRUNK_AT + TRUNK_DURATION * ((x - REPO.x) / (TRUNK_END - REPO.x));
const nodeAt = (x: number): number => stubAt(x) + 0.22;

function PortDot({ className }: { className?: string }): ReactNode {
  return (
    <span
      aria-hidden
      className={cn(
        'border-border bg-background absolute size-1.5 rounded-full border transition-colors duration-200',
        className,
      )}
    />
  );
}

export function StepSourceOfTruth(): ReactNode {
  const reduced = useReducedMotion();
  const [drawn, setDrawn] = useState(false);
  const [hovered, setHovered] = useState<NodeId | null>(null);
  const rootRef = useStepShowcaseStart(() => setDrawn(true));

  /** Reduced motion keeps the fades — they say the schematic finished
   *  building — and drops travel, scale and the line drawing. */
  const from = (extra: object) => (reduced ? { opacity: 0 } : { opacity: 0, ...extra });
  const to = { opacity: 1, y: 0, scale: 1 };
  const at = (delay: number): Transition => (reduced ? { ...ENTER, delay: 0 } : { ...ENTER, delay });

  /**
   * Every edge is a 1px div, not SVG. Motion's `pathLength` draw runs on
   * `stroke-dasharray`, and under `preserveAspectRatio="none"` the dash math
   * scales differently per axis — finished lines kept residual dashes and
   * stopped short of their ports. A div has no dash math, and it is positioned
   * by the same CSS percentages as the nodes, so line and port meet exactly.
   * The wrapper owns position (and centering translate); the inner m.div owns
   * the scale draw — Motion's inline transform must never share an element
   * with a translate class.
   */
  const edge = (
    axis: 'x' | 'y',
    origin: string,
    delay: number,
    duration: number,
    active: boolean,
  ) => {
    const collapsed = axis === 'x' ? { scaleX: 0 } : { scaleY: 0 };
    return (
      <m.div
        initial={reduced ? { opacity: 0 } : collapsed}
        animate={
          drawn ? { scaleX: 1, scaleY: 1, opacity: 1 } : reduced ? { opacity: 0 } : collapsed
        }
        transition={reduced ? { duration: 0.3 } : { duration, ease: 'linear', delay }}
        style={{ transformOrigin: origin }}
        className={cn(
          'h-full w-full transition-colors duration-200',
          active ? 'bg-foreground/40' : 'bg-border',
        )}
      />
    );
  };

  return (
    <div ref={rootRef} className="h-full min-h-0 w-full overflow-hidden">
      {/* ── The schematic (lg+, where the pinned pane gives it room) ──── */}
      <div
        className={cn(
          'relative hidden h-full w-full lg:block',
          'bg-[radial-gradient(circle,color-mix(in_oklab,var(--color-border)_45%,transparent)_1px,transparent_1px)] bg-[size:16px_16px]',
        )}
      >
        {/* Trunk: repo port → off the right edge, drawn left to right. */}
        <div
          aria-hidden
          className="absolute -translate-y-1/2"
          style={{
            left: `${REPO.x}%`,
            top: `${TRUNK_Y}%`,
            width: `${TRUNK_END - REPO.x}%`,
            height: 1,
          }}
        >
          {edge('x', 'left center', TRUNK_AT, TRUNK_DURATION, false)}
        </div>

        {/* Stubs: trunk → each node's port, drawn away from the trunk. */}
        {NODES.map((node) => {
          const up = node.side === 'up';
          return (
            <div
              key={node.id}
              aria-hidden
              className="absolute -translate-x-1/2"
              style={{
                left: `${node.x}%`,
                top: `${up ? UP_Y : TRUNK_Y}%`,
                height: `${up ? TRUNK_Y - UP_Y : DOWN_Y - TRUNK_Y}%`,
                width: 1,
              }}
            >
              {edge(
                'y',
                up ? 'center bottom' : 'center top',
                stubAt(node.x),
                0.2,
                hovered === node.id,
              )}
            </div>
          );
        })}

        {/* The repo node — anchored by its output port (right-center). */}
        <div
          style={{ left: `${REPO.x}%`, top: `${REPO.y}%` }}
          className="absolute -translate-x-full -translate-y-1/2"
        >
          <m.div
            initial={from({ scale: 0.95, y: 6 })}
            animate={drawn ? to : from({ scale: 0.95, y: 6 })}
            transition={at(0)}
            className="relative translate-x-12"
          >
            <span className="bg-foreground text-background absolute -top-5 left-0 rounded-t-sm px-2 py-0.5 font-mono text-[10px] leading-4">
              repo
            </span>
            <div className="border-border bg-background relative flex items-center gap-3 rounded-md rounded-tl-none border px-4 py-3">
              <span className="bg-foreground text-background flex size-8 items-center justify-center rounded-sm">
                <GitBranchIcon weight='fill' className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="text-foreground block font-mono text-sm leading-tight font-medium">
                  acme-co
                </span>
                <span className="text-muted-foreground block text-[11px] leading-tight whitespace-nowrap">
                  your whole company, as files
                </span>
              </span>
              <PortDot
                className={cn(
                  'top-1/2 -right-[3px] -translate-y-1/2',
                  drawn && 'border-foreground/40',
                )}
              />
            </div>
          </m.div>
        </div>

        {/* The row — each node anchored by the port its stub arrives at. */}
        {NODES.map((node) => {
          const Icon = node.icon;
          const up = node.side === 'up';
          return (
            <div
              key={node.id}
              style={{ left: `${node.x}%`, top: `${up ? UP_Y : DOWN_Y}%` }}
              className={cn('absolute -translate-x-1/2', up && '-translate-y-full')}
            >
              <m.div
                initial={from({ scale: 0.95, y: up ? -6 : 6 })}
                animate={drawn ? to : from({ scale: 0.95, y: up ? -6 : 6 })}
                transition={at(nodeAt(node.x))}
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => setHovered(null)}
                className={cn(
                  'border-border bg-background relative rounded-md border transition-colors duration-200',
                  hovered === node.id && 'border-foreground/25',
                )}
              >
                <PortDot
                  className={cn(
                    up
                      ? '-bottom-[3px] left-1/2 -translate-x-1/2'
                      : '-top-[3px] left-1/2 -translate-x-1/2',
                    hovered === node.id && 'border-foreground/40',
                  )}
                />

                <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                  <span className="border-border bg-muted/50 text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-sm border">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="text-foreground block text-sm leading-tight font-medium">
                      {node.label}
                    </span>
                    {/* Meaning by default, file path on hover — both in one
                        grid cell so the swap never reflows the node. */}
                    <span className="grid text-[11px] leading-tight whitespace-nowrap">
                      <span
                        className={cn(
                          'text-muted-foreground col-start-1 row-start-1 transition-opacity duration-200',
                          hovered === node.id && 'opacity-0',
                        )}
                      >
                        {node.note}
                      </span>
                      <span
                        className={cn(
                          'text-muted-foreground col-start-1 row-start-1 font-mono opacity-0 transition-opacity duration-200',
                          hovered === node.id && 'opacity-100',
                        )}
                      >
                        {node.path}
                      </span>
                    </span>
                  </span>
                </div>
              </m.div>
            </div>
          );
        })}
      </div>

      {/* ── Below lg: the 256–304px frame has no room for a schematic —
          same content as a plain stack. ────────────────────────────── */}
      <div className="flex h-full flex-col justify-center gap-2 overflow-y-auto p-3 lg:hidden">
        <div className="border-border bg-background flex items-center gap-3 rounded-md border px-3.5 py-2.5">
          <span className="bg-foreground text-background flex size-7 items-center justify-center rounded-sm">
            <GitBranchIcon weight='fill' className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="text-foreground block font-mono text-sm leading-tight font-medium">
              acme-co
            </span>
            <span className="text-muted-foreground block text-[11px] leading-tight">
              your whole company, as files
            </span>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {NODES.map((node) => {
            const Icon = node.icon;
            return (
              <div
                key={node.id}
                className="border-border bg-background flex items-center gap-2.5 rounded-md border px-3 py-2"
              >
                <span className="border-border bg-muted/50 text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-sm border">
                  <Icon weight='fill' className="size-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="text-foreground block text-[13px] leading-tight font-medium">
                    {node.label}
                  </span>
                  <span className="text-muted-foreground block truncate text-[11px] leading-tight">
                    {node.note}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
