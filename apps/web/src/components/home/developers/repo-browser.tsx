'use client';

import { useMemo, useState } from 'react';
import { ChevronRight, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  FileContentRenderer,
  FileSourceProvider,
  type FileSource,
} from '@/features/file-viewer';
import { getFileIcon } from '@/features/files/components/file-icon';

/* -------------------------------------------------------------------------- */
/*  A real Kortix project, as plain files. This is the exact in-product file   */
/*  viewer (FileContentRenderer) fed static content through a mock FileSource. */
/* -------------------------------------------------------------------------- */

const FILES: Record<string, string> = {
  'kortix.toml': `# Kortix project manifest — the source of truth for project-wide
# config, versioned in git. kortix_version pins the schema.
kortix_version = 1

[project]
name = "acme"
description = "Acme's AI workforce."

# Env the runtime needs. Required values must be set in the Kortix
# Secrets Manager before a session can start.
[env]
required = ["ANTHROPIC_API_KEY"]
optional = ["STRIPE_API_KEY"]

# Sessions boot from a sandbox image; the Kortix runtime layer is
# always added on top of the base.
[sandbox]
default = "agent-box"

[[sandbox.templates]]
slug = "agent-box"
name = "Agent box"
dockerfile = ".kortix/Dockerfile"
cpu = 4
memory = 8
disk = 20

# OpenCode runtime: the daemon launches opencode with OPENCODE_CONFIG_DIR
# pointed here, so agents, skills and tools live under this folder.
[opencode]
config_dir = ".kortix/opencode"

# A trigger spawns a fresh session that runs \`prompt\` as its first message.
[[triggers]]
slug = "daily-digest"
name = "Daily digest"
type = "cron"
agent = "research"
enabled = true
cron = "0 0 9 * * 1-5"          # 09:00 Mon–Fri
timezone = "America/Los_Angeles"
prompt = "Summarize yesterday across Slack and Linear, post to #standup."

# Connect a tool's API so agents can call it. (3,000+ apps via Pipedream.)
[[connectors]]
slug = "stripe"
name = "Stripe"
provider = "http"
base_url = "https://api.stripe.com"

  [connectors.auth]
  type = "bearer"
  secret = "STRIPE_API_KEY"

# Answer where your team already works.
[[channels]]
platform = "slack"
enabled = true
agent = "support"
events = ["mention", "dm"]
`,

  '.kortix/opencode/agents/support.md': `---
description: Acme's support agent. Resolves customer tickets end to end with full product and order context.
mode: primary
model: anthropic/claude-opus-4-8
tools:
  lookup_order: true
---

You are Acme's support agent. Resolve customer tickets end to
end, with full product and order context.

- Look up the customer and their recent orders before replying.
- Issue refunds under $500 on your own. Anything higher goes to
  a human for approval.
- Always close the loop in the channel the ticket came from.
`,

  '.kortix/opencode/agents/research.md': `---
description: Acme's research agent. Turns open questions into short, sourced briefs the team can act on.
mode: primary
model: anthropic/claude-opus-4-8
tools:
  webfetch: true
---

You are Acme's research agent. Turn open questions into short,
sourced briefs the team can act on.

- Start from the question, not the tools.
- Every claim gets a source. No source, no claim.
- Deliver a one-page brief, then the supporting notes.
`,

  '.kortix/opencode/skills/refund-policy/SKILL.md': `---
name: refund-policy
description: When and how to issue customer refunds. Load before any refund.
---

# Refund policy

A skill is a folder under .kortix/opencode/skills/ that an agent
loads on demand — instructions, plus any scripts or references.

- Full refund within 30 days of purchase, no questions asked.
- Between 30 and 90 days, offer store credit first.
- Over 90 days, escalate to a human with the order context.

Log every refund in the #refunds channel with the order ID.
`,

  '.kortix/opencode/tools/lookup-order.ts': `import { tool } from "@opencode-ai/plugin";

// A custom tool is just a file. opencode loads everything under
// .kortix/opencode/tools/ and hands it to your agents.
export default tool({
  description: "Fetch an order and its fulfilment status by ID.",
  args: {
    orderId: tool.schema.string().describe("The order ID, e.g. ord_123"),
  },
  async execute(args, _context) {
    const res = await fetch(\`https://api.acme.com/orders/\${args.orderId}\`, {
      headers: { authorization: \`Bearer \${process.env.ACME_API_KEY}\` },
    });
    const order = await res.json();
    return JSON.stringify({
      status: order.status,
      total: order.total,
      shipped_at: order.shipped_at,
    });
  },
});
`,

  '.kortix/opencode/memory/company.md': `# Company memory

What every agent should know about Acme, kept in one place
and updated as the company learns.

- Acme sells developer tooling to ~4,000 teams.
- Billing runs on Stripe. Support SLA is 4 hours.
- Voice: plain, direct, never hype. Founder-grade.
`,

  '.kortix/Dockerfile': `# The image every session boots into. The Kortix runtime layer is
# added on top automatically — you just declare the tools you need.
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y ripgrep jq curl

WORKDIR /workspace
`,

  'AGENTS.md': `# Acme — operating rules

Rules every agent in this repo follows, no exceptions.
(AGENTS.md is loaded into every session as shared context.)

- Be concise and factual. Cite the source for any claim.
- Never share secrets or internal links with customers.
- When unsure, open a change request instead of acting.
`,

  'README.md': `# Acme

This repo *is* Acme's AI workforce. Every agent, skill,
automation and integration lives here as a plain file you
can read, diff, review and roll back.

- \`kortix.toml\` declares the company and its runtime.
- \`.kortix/opencode/\` holds the agents, skills, tools and memory.

Build it locally with your coding agent, then run \`kortix ship\`
to take it live as a fleet of cloud sandboxes.
`,
};

/* ── file tree ───────────────────────────────────────────────────────────── */

type Node = { name: string; path?: string; children?: Node[] };

const TREE: Node[] = [
  { name: 'kortix.toml', path: 'kortix.toml' },
  {
    name: '.kortix',
    children: [
      { name: 'Dockerfile', path: '.kortix/Dockerfile' },
      {
        name: 'opencode',
        children: [
          {
            name: 'agents',
            children: [
              { name: 'support.md', path: '.kortix/opencode/agents/support.md' },
              { name: 'research.md', path: '.kortix/opencode/agents/research.md' },
            ],
          },
          {
            name: 'skills',
            children: [
              {
                name: 'refund-policy',
                children: [
                  { name: 'SKILL.md', path: '.kortix/opencode/skills/refund-policy/SKILL.md' },
                ],
              },
            ],
          },
          {
            name: 'tools',
            children: [
              { name: 'lookup-order.ts', path: '.kortix/opencode/tools/lookup-order.ts' },
            ],
          },
          {
            name: 'memory',
            children: [
              { name: 'company.md', path: '.kortix/opencode/memory/company.md' },
            ],
          },
        ],
      },
    ],
  },
  { name: 'AGENTS.md', path: 'AGENTS.md' },
  { name: 'README.md', path: 'README.md' },
];

const DEFAULT_FILE = 'kortix.toml';

/* All folders open by default — the whole company is meant to be visible. */
const ALL_DIRS = new Set<string>([
  '.kortix',
  '.kortix/opencode',
  '.kortix/opencode/agents',
  '.kortix/opencode/skills',
  '.kortix/opencode/skills/refund-policy',
  '.kortix/opencode/tools',
  '.kortix/opencode/memory',
]);

/* ── mock FileSource — same renderer the product uses, static content ─────── */

const mockFileSource: FileSource = {
  useFileContent: (filePath) => {
    const content = filePath ? FILES[filePath] : undefined;
    return {
      data: content != null ? { type: 'text', content } : undefined,
      isLoading: false,
      error: filePath && content == null ? 'not found' : null,
      refetch: async () => {},
    };
  },
  useBinaryBlob: () => ({ blobUrl: null, blob: null, isLoading: false, error: null }),
  download: async () => {},
  upload: async () => {},
};

/* ── tree rows ───────────────────────────────────────────────────────────── */

function TreeRow({
  node,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
  dirPath = '',
}: {
  node: Node;
  depth: number;
  expanded: Set<string>;
  selected: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  dirPath?: string;
}) {
  const isDir = !!node.children;
  const selfPath = dirPath ? `${dirPath}/${node.name}` : node.name;
  const isOpen = isDir && expanded.has(selfPath);
  const isActive = !isDir && node.path === selected;

  return (
    <>
      <button
        type="button"
        onClick={() => (isDir ? onToggle(selfPath) : node.path && onSelect(node.path))}
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-sm transition-colors',
          isActive
            ? 'bg-primary/[0.07] text-foreground'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
        style={{ paddingLeft: depth * 14 + 8 }}
      >
        {isDir ? (
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-muted-foreground/60 transition-transform', isOpen && 'rotate-90')}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {getFileIcon(node.name, { isDirectory: isDir, isOpen, className: 'size-4 shrink-0' })}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && isOpen &&
        node.children!.map((child) => (
          <TreeRow
            key={child.name}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            selected={selected}
            onToggle={onToggle}
            onSelect={onSelect}
            dirPath={selfPath}
          />
        ))}
    </>
  );
}

/* ── the browser ─────────────────────────────────────────────────────────── */

export function RepoBrowser({ className }: { className?: string }) {
  const [selected, setSelected] = useState(DEFAULT_FILE);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ALL_DIRS));

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const fileName = selected.split('/').pop() ?? '';
  const segments = useMemo(() => selected.split('/'), [selected]);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_30px_80px_-40px_rgba(0,0,0,0.5)]',
        className,
      )}
    >
      {/* window bar — the project, not a fake terminal */}
      <div className="flex h-11 items-center gap-2.5 border-b border-border/60 bg-muted/30 px-4">
        <span className="flex size-5 items-center justify-center rounded-md bg-foreground text-[10px] font-semibold text-background">
          A
        </span>
        <span className="text-sm font-medium text-foreground">acme</span>
        <span className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-xs text-muted-foreground">
          <GitBranch className="size-3" />
          main
        </span>
        <span className="ml-auto hidden text-xs text-muted-foreground/70 sm:block">
          your company, as a git repo
        </span>
      </div>

      <div className="grid h-[520px] grid-cols-[148px_minmax(0,1fr)] sm:grid-cols-[200px_minmax(0,1fr)]">
        {/* file tree */}
        <div className="overflow-y-auto border-r border-border/60 bg-muted/[0.18] p-2">
          {TREE.map((node) => (
            <TreeRow
              key={node.name}
              node={node}
              depth={0}
              expanded={expanded}
              selected={selected}
              onToggle={toggle}
              onSelect={setSelected}
            />
          ))}
        </div>

        {/* viewer — the actual product FileContentRenderer */}
        <div className="flex min-w-0 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/50 px-3">
            {getFileIcon(fileName, { className: 'size-3.5 shrink-0' })}
            <div className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
              {segments.map((seg, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground/40">/</span>}
                  <span className={cn('truncate', i === segments.length - 1 && 'text-foreground')}>{seg}</span>
                </span>
              ))}
            </div>
            <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
              read only
            </span>
          </div>
          <div className="min-h-0 flex-1">
            <FileSourceProvider value={mockFileSource}>
              <FileContentRenderer key={selected} filePath={selected} showHeader={false} readOnly />
            </FileSourceProvider>
          </div>
        </div>
      </div>
    </div>
  );
}
