'use client';

import { type CodeTab, CodeWindow, DocLinks } from '@/features/marketing/v2/developer-kit';
import { CtaSection, GridSection, HeroSection } from '@/features/marketing/v2/page-kit';
import { MAX_W } from '@/features/marketing/v2/primitives';
import { VisualStage } from '@/features/marketing/v2/real-visual';
import { cn } from '@/lib/utils';

/**
 * The manifest fields, the executor commands, and the server card are the ones
 * that ship today: `provider: mcp` requires `url` and takes an optional
 * `transport`, the sandbox reaches connectors only through `kortix executor`,
 * and the card below is what https://kortix.com/mcp/server-card returns.
 */
const TABS: CodeTab[] = [
  {
    name: 'kortix.yaml',
    language: 'yaml',
    code: `# Kortix as a client: an MCP server becomes a connector.
connectors:
  - slug: docs-mcp
    name: Docs MCP
    provider: mcp
    url: https://mcp.example.com/mcp
    transport: http   # http (default) or sse

# An agent reaches only what its config declares.
agents:
  research:
    connectors: [docs-mcp]`,
  },
  {
    name: 'sandbox',
    language: 'bash',
    code: `# Inside a session the agent calls connectors through the executor,
# never with a raw credential — Kortix resolves it server-side.
kortix executor connectors
kortix executor call docs-mcp <action> '<json-args>'

# And the sandbox can speak MCP itself, over stdio.
kortix executor mcp`,
  },
  {
    name: 'kortix.com/mcp',
    language: 'json',
    code: `{
  "name": "com.kortix/public-content",
  "title": "Kortix Public Content",
  "description": "Search and read Kortix public documentation and API metadata.",
  "websiteUrl": "https://kortix.com",
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://kortix.com/mcp",
      "supportedProtocolVersions": ["2025-03-26"]
    }
  ]
}`,
  },
];

const DOCS = [
  { name: 'Connectors', href: '/docs/connect/connectors' },
  { name: 'Manifest reference', href: '/docs/project/manifest' },
  { name: 'Server card', href: 'https://kortix.com/mcp/server-card' },
];

export default function McpPage() {
  return (
    <main className="bg-background">
      <HeroSection
        id="hero"
        heading="Kortix speaks MCP in both directions."
        body="Point any MCP client at Kortix and it can start sessions and read results. Point Kortix at any MCP server and it becomes a connector your agents can use."
        visual="none"
      >
        <div className={cn(MAX_W, 'mt-16')}>
          <VisualStage size="lg">
            <CodeWindow tabs={TABS} />
          </VisualStage>
          <DocLinks links={DOCS} className="mt-8" />
        </div>
      </HeroSection>

      <GridSection
        id="both-directions"
        heading="Server and client."
        body="Same permission model either way."
        bullets={[
          'Kortix as a server. Expose your projects, agents, and sessions to any MCP-capable client or editor.',
          'Kortix as a client. Register an MCP server once and its tools become available to the agents you scope it to.',
          'Scoped like everything else. An MCP connector obeys the same per-agent permissions as a first-party connector.',
          'Declared in the repo. MCP servers live in kortix.yaml, so adding one is a reviewable change.',
        ]}
        columns={2}
      />

      <CtaSection
        id="cta"
        heading="Wire Kortix into your tooling."
        body="If it speaks MCP, it can reach your agents — or your agents can reach it."
      />
    </main>
  );
}
