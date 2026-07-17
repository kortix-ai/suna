#!/usr/bin/env bun
/**
 * Full split of tool-renderers.tsx into shared/ + tools/ + barrel files.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const TOOL_DIR = join(ROOT, 'src/features/session/tool');
const SHARED_DIR = join(TOOL_DIR, 'shared');
const TOOLS_DIR = join(TOOL_DIR, 'tools');
const SRC = join(TOOL_DIR, 'tool-renderers.tsx.bak');

const lines = readFileSync(SRC, 'utf8').split('\n');

function slice(start: number, end?: number) {
  return lines.slice(start, end).join('\n');
}

function toolNameToFile(name: string) {
  const base = name.replace(/Tool$/, '');
  return (
    base
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
      .toLowerCase() + '-tool.tsx'
  );
}

const IMPORTS_END = 118;
const SHARED_START = 139;
const FIRST_TOOL = 1461;
const VALIDATION_ISSUE = 7489;
const TOOL_ERROR_EXPORT = 7888;
const PARSE_TOOL_NAME = 7994;
const PERMISSION_PROMPT = 8067;

const importsBlock = slice(0, IMPORTS_END + 1).replace(
  "from '../show-availability'",
  "from '@/features/session/show-availability'",
);

mkdirSync(SHARED_DIR, { recursive: true });
mkdirSync(TOOLS_DIR, { recursive: true });

// ─── types.ts ───
writeFileSync(
  join(SHARED_DIR, 'types.ts'),
  `import type { ComponentType } from 'react';
import type { ToolPart } from '@/ui';

export interface ToolProps {
  part: ToolPart;
  sessionId?: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  locked?: boolean;
  hasActiveQuestion?: boolean;
  onPermissionReply?: (requestId: string, reply: 'once' | 'always' | 'reject') => void;
}

export type ToolComponent = ComponentType<ToolProps>;

export interface BasicToolProps {
  icon: React.ReactNode;
  trigger: import('@/ui').TriggerTitle | React.ReactNode;
  children?: React.ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  locked?: boolean;
  onSubtitleClick?: () => void;
  badge?: React.ReactNode;
  rightAccessory?: React.ReactNode;
  onClick?: () => void;
  durationMs?: number;
}

export interface ParsedJsonFailure {
  errorSummary: string;
  hint?: string;
  status?: number;
  nestedMessage?: string;
  nestedError?: boolean;
}
`,
);

// ─── registry.ts ───
writeFileSync(
  join(SHARED_DIR, 'registry.ts'),
  `import type { ToolComponent } from '@/features/session/tool/shared/types';

const registry = new Map<string, ToolComponent>();

export const ToolRegistry = {
  register(name: string, component: ToolComponent) {
    registry.set(name, component);
  },
  get(name: string): ToolComponent | undefined {
    const candidates = new Set<string>();
    const add = (value?: string | null) => {
      if (!value) return;
      const cleaned = value.trim();
      if (!cleaned) return;
      candidates.add(cleaned);
      candidates.add(cleaned.toLowerCase());
    };

    add(name);
    add(name.replace(/_/g, '-'));
    add(name.replace(/-/g, '_'));

    const slashIdx = name.lastIndexOf('/');
    if (slashIdx > 0) {
      const short = name.slice(slashIdx + 1);
      add(short);
      add(short.replace(/_/g, '-'));
      add(short.replace(/-/g, '_'));
    }

    for (const key of candidates) {
      const component = registry.get(key);
      if (component) return component;
    }

    const allRegistered = Array.from(registry.keys());
    for (const candidate of candidates) {
      for (const key of allRegistered) {
        if (
          candidate.endsWith(\`/\${key}\`) ||
          candidate.endsWith(\`-\${key}\`) ||
          candidate.endsWith(\`_\${key}\`)
        ) {
          return registry.get(key);
        }
      }
    }

    return undefined;
  },
};
`,
);

// ─── infrastructure.tsx (shared core without registry/types blocks) ───
let infraBody = slice(SHARED_START, FIRST_TOOL);

// Remove blocks now in types.ts and registry.ts
infraBody = infraBody
  .replace(/interface ToolProps \{[\s\S]*?\}\n\n/, '')
  .replace(/type ToolComponent = ComponentType<ToolProps>;\n\n/, '')
  .replace(/const registry = new Map[\s\S]*?\};\n\n/, '')
  .replace(/interface BasicToolProps \{[\s\S]*?\}\n\n/, '')
  .replace(/interface ParsedJsonFailure \{[\s\S]*?\}\n\n/, '');

// Add exports for public + cross-module symbols
const exportNames = [
  'MD_FLUSH_CLASSES',
  'useToolNavigation',
  'useProxyUrl',
  'isLocalSandboxFilePath',
  'useServicePreview',
  'ServicePreviewUrlFallback',
  'ServicePreviewViewport',
  'InlineServicePreview',
  'parsePartialJSON',
  'partStreamingInput',
  'partInput',
  'partMetadata',
  'partOutput',
  'partStatus',
  'firstMeaningfulLine',
  'getAgentCardLabel',
  'StatusIcon',
  'ToolEmptyState',
  'looksLikeError',
  'parseJsonFailure',
  'JsonFailureOutputCard',
  'formatJsonFailureOutput',
  'ToolOutputFallback',
  'RawOutputBlock',
  'ToolRunningContext',
  'StalePendingContext',
  'ToolDurationContext',
  'ToolSurfaceContext',
  'shouldShowToolPartInActionsPanel',
  'ToolActivateContext',
  'BoundActivateContext',
  'BasicTool',
  'InlineDiffView',
  'ToolCode',
  'getToolDiagnostics',
  'DiagnosticsDisplay',
  'DiffChanges',
  'StructuredOutput',
];

for (const name of exportNames) {
  infraBody = infraBody.replace(
    new RegExp(`^(export )?(const|function) (${name})\\b`, 'm'),
    'export $2 $3',
  );
}

// Export ToolSurface type
infraBody = infraBody.replace(/^export type ToolSurface/m, 'export type ToolSurface');

writeFileSync(
  join(SHARED_DIR, 'infrastructure.tsx'),
  `${importsBlock}
import type { BasicToolProps, ParsedJsonFailure } from '@/features/session/tool/shared/types';
import type { ToolProps } from '@/features/session/tool/shared/types';

${infraBody}
`,
);

// ─── session-helpers.tsx ───
writeFileSync(
  join(SHARED_DIR, 'session-helpers.tsx'),
  `'use client';

import { Badge } from '@/components/ui/badge';
import { STATUS_TEXT } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { Check, ChevronRight, Clock, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { stripAnsi } from '@/ui';

${slice(2018, 2299).replace(/^function /gm, 'export function ').replace(/^const ParsedSessionMeta/m, 'export interface ParsedSessionMeta').replace(/^interface ParsedSessionMeta/m, 'export interface ParsedSessionMeta').replace(/^interface ParsedSessionMessage/m, 'export interface ParsedSessionMessage')}
`,
);

// ─── file-list.tsx ───
writeFileSync(
  join(SHARED_DIR, 'file-list.tsx'),
  `'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { FileIcon, Folder } from 'lucide-react';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import { useToolNavigation } from '@/features/session/tool/shared/infrastructure';

${slice(3021, 3242)
  .replace(/^function /gm, 'export function ')
  .replace(/^interface GrepFileGroup/m, 'export interface GrepFileGroup')}
`,
);

// ─── sub-agent.tsx (imports ToolPartRenderer — register loads after ToolPartRenderer is defined) ───
writeFileSync(
  join(SHARED_DIR, 'sub-agent.tsx'),
  `'use client';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
import type { MessageWithParts, ToolPart } from '@/ui';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { getChildSessionError, getRetryInfo, getRetryMessage } from '@/ui';
import { useSyncStore } from '@/stores/opencode-sync-store';
import { useEffect, useMemo, useState } from 'react';

${slice(5075, 5144).replace(/^function /gm, 'export function ')}
`,
);

// ─── error-and-executor.tsx ───
writeFileSync(
  join(SHARED_DIR, 'error-and-executor.tsx'),
  `'use client';

import { STATUS_BG, STATUS_BORDER, STATUS_TEXT } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { Plug } from 'lucide-react';
import type { ReactNode } from 'react';

${slice(VALIDATION_ISSUE, TOOL_ERROR_EXPORT)
  .replace(/^interface ValidationIssue/m, 'export interface ValidationIssue')
  .replace(/^function /gm, 'export function ')}
`,
);

// ─── Split tools ───
const toolStarts: { line: number; name: string }[] = [];
for (let i = FIRST_TOOL; i < VALIDATION_ISSUE; i++) {
  const m = lines[i].match(/^function (\w+Tool)\(/);
  if (m) toolStarts.push({ line: i, name: m[1] });
}

function findFunctionEnd(startLine: number): number {
  let braceDepth = 0;
  let started = false;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        braceDepth++;
        started = true;
      } else if (ch === '}') braceDepth--;
    }
    if (started && braceDepth === 0) return i + 1;
  }
  return startLine + 1;
}

function findRegistrationsEnd(fromLine: number): number {
  let i = fromLine;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t.startsWith('ToolRegistry.register')) {
      i++;
      continue;
    }
    if (t.startsWith('[') && t.includes('integration')) {
      while (i < lines.length && !lines[i].includes('].forEach')) i++;
      i++;
      continue;
    }
    break;
  }
  return i;
}

const toolBlocks: { name: string; file: string; start: number; end: number }[] = [];
for (let t = 0; t < toolStarts.length; t++) {
  const { line: start, name } = toolStarts[t];
  const funcEnd = findFunctionEnd(start);
  let end = findRegistrationsEnd(funcEnd);
  const nextLine = t + 1 < toolStarts.length ? toolStarts[t + 1].line : VALIDATION_ISSUE;
  if (end < nextLine) end = nextLine;
  toolBlocks.push({ name, file: toolNameToFile(name), start, end });
}

const toolImportHeader = `'use client';

import { PreWithPaths } from '@/components/common/clickable-path';
import { DiffView } from '@/components/diff/diff-view';
import { HighlightedCode, UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { DiffStat, STATUS_BG, STATUS_BORDER, STATUS_TEXT, StatusDot } from '@/components/ui/status';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toSandboxAbsolutePath } from '@/features/files/api/opencode-files';
import { useFileContent } from '@/features/files/hooks/use-file-content';
import { parseImageOutput } from '@/features/session/image-output-path';
import { prefersPreviewLink } from '@/features/session/preview-url-fallback';
import { QuestionPrompt } from '@/features/session/question-prompt';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import {
  cleanResultSnippet,
  formatRawOutput,
  looksLikeJsonPayload,
  recoverLinkResults,
} from '@/features/session/tool/tool-output-format';
import {
  extractReadableHtml,
  stripMarkupForToolOutput,
} from '@/features/session/tool/tool-renderers-sanitization';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  ToolActivateContext,
  ToolDurationContext,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
  ToolSurfaceContext,
  BoundActivateContext,
  StalePendingContext,
  InlineDiffView,
  DiffChanges,
  ToolCode,
  DiagnosticsDisplay,
  StructuredOutput,
  InlineServicePreview,
  StatusIcon,
  RawOutputBlock,
  getToolDiagnostics,
  partInput,
  partOutput,
  partStatus,
  partMetadata,
  firstMeaningfulLine,
  getAgentCardLabel,
  useToolNavigation,
  isLocalSandboxFilePath,
  MD_FLUSH_CLASSES,
} from '@/features/session/tool/shared/infrastructure';
import {
  formatBashOutput,
  parseSessionMetadataOutput,
  parseSessionMessagesOutput,
  SessionMetadataList,
  SessionTimeLabel,
  InlineSessionMessagesList,
  formatSessionTime,
} from '@/features/session/tool/shared/session-helpers';
import {
  InlineFileList,
  InlineGrepResults,
  ToolListRow,
  parseFilePaths,
  parseGrepOutput,
} from '@/features/session/tool/shared/file-list';
import { SubAgentActivity, SubAgentStatusBanner } from '@/features/session/tool/shared/sub-agent';
import {
  ExecutorJson,
  ExecutorRiskBadge,
  ExecutorSectionLabel,
  parseExecutorOutput,
} from '@/features/session/tool/shared/error-and-executor';
import { ToolError } from '@/features/session/tool/tool-error';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import { useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { openSafeExternalUrl, safeHttpUrl } from '@/lib/safe-url';
import { INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';
import { cn } from '@/lib/utils';
import { parseMemoryEntryOutput } from '@/lib/utils/memory-entry-output';
import { parseMemorySearchOutput } from '@/lib/utils/memory-search-output';
import { isAppRouteUrl, isProxiableLocalhostUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata, getActiveSessionContext } from '@/lib/utils/session-context';
import {
  hasStructuredContent,
  normalizeToolOutput,
  type OutputSection,
  parseStructuredOutput,
} from '@/lib/utils/structured-output';
import { type LspDiagnostic, parseDiagnosticsFromToolOutput } from '@/stores/diagnostics-store';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useSyncStore } from '@/stores/opencode-sync-store';
import {
  getActivePanelSessionId,
  sessionPreviewTabId,
  useSessionBrowserStore,
} from '@/stores/session-browser-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
import {
  AlertTriangle,
  Ban,
  BookOpen,
  Brain,
  CalendarClock,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Clock,
  Code2,
  Cpu,
  ExternalLink,
  FileCode2,
  FileIcon,
  FileText,
  Fingerprint,
  Folder,
  Glasses,
  Globe,
  Hash,
  Image as ImageIcon,
  Layers,
  ListTodo,
  ListTree,
  Loader2,
  Maximize2,
  MessageCircle,
  Minimize2,
  MonitorPlay,
  Music,
  PanelRight,
  Plug,
  Plus,
  Presentation,
  RefreshCw,
  Scissors,
  Search,
  SquareKanban,
  StopCircle,
  Tags,
  Terminal,
  Trash2,
  Type,
  Video,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import React, {
  type ComponentType,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { isShowContentUnavailable, type ShowLoadStatus } from '@/features/session/show-availability';
import {
  type Diagnostic,
  getChildSessionError,
  getChildSessionId,
  getChildSessionToolParts,
  getDiagnostics,
  getDirectory,
  getFilename,
  getRetryInfo,
  getRetryMessage,
  getToolInfo,
  type MessageWithParts,
  PERMISSION_LABELS,
  type PermissionRequest,
  type QuestionRequest,
  stripAnsi,
  type ToolPart,
  type TriggerTitle,
} from '@/ui';
`;

for (const block of toolBlocks) {
  let content = slice(block.start, block.end);
  content = content.replace(/^function (\w+Tool)\(/gm, 'export function $1(');
  writeFileSync(join(TOOLS_DIR, block.file), `${toolImportHeader}\n\n${content}\n`);
}

writeFileSync(
  join(TOOLS_DIR, 'register.ts'),
  toolBlocks.map((b) => `import './${b.file.replace('.tsx', '')}';`).join('\n') + '\n',
);

// tool-error.tsx
writeFileSync(
  join(TOOL_DIR, 'tool-error.tsx'),
  `'use client';

import { StructuredOutput } from '@/features/session/tool/shared/infrastructure';
import { parseErrorContent } from '@/features/session/tool/shared/error-and-executor';
import {
  hasStructuredContent,
  normalizeToolOutput,
  parseStructuredOutput,
} from '@/lib/utils/structured-output';
import { Ban, ChevronRight, CircleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

${slice(TOOL_ERROR_EXPORT, PARSE_TOOL_NAME)}
`,
);

// generic-tool.tsx
writeFileSync(
  join(TOOL_DIR, 'generic-tool.tsx'),
  `'use client';

import {
  BasicTool,
  partInput,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { Cpu } from 'lucide-react';
import { useMemo } from 'react';

${slice(PARSE_TOOL_NAME, PERMISSION_PROMPT)}
`,
);

// tool-part-renderer.tsx — register import at bottom to avoid circular deps
const rendererBody = slice(PERMISSION_PROMPT);
writeFileSync(
  join(TOOL_DIR, 'tool-part-renderer.tsx'),
  `'use client';

import { GenericTool } from '@/features/session/tool/generic-tool';
import { ToolError } from '@/features/session/tool/tool-error';
import {
  BasicTool,
  BoundActivateContext,
  partInput,
  shouldShowToolPartInActionsPanel,
  StalePendingContext,
  ToolActivateContext,
  ToolDurationContext,
  ToolRunningContext,
  ToolSurfaceContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { QuestionPrompt } from '@/features/session/question-prompt';
import { Button } from '@/components/ui/button';
import { PERMISSION_LABELS, type PermissionRequest, type QuestionRequest, type ToolPart } from '@/ui';
import { CircleAlert } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

${rendererBody}

// Register all tool renderers after ToolPartRenderer is defined (avoids circular imports).
import '@/features/session/tool/tools/register';
`,
);

// barrel
writeFileSync(
  join(TOOL_DIR, 'tool-renderers.tsx'),
  `/**
 * Session tool renderers — public barrel.
 */
export {
  BasicTool,
  ToolActivateContext,
  ToolSurfaceContext,
  type ToolSurface,
  shouldShowToolPartInActionsPanel,
} from '@/features/session/tool/shared/infrastructure';

export { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
export { ToolError } from '@/features/session/tool/tool-error';
export { GenericTool } from '@/features/session/tool/generic-tool';
export { ToolRegistry } from '@/features/session/tool/shared/registry';
`,
);

console.log(`Split complete: ${toolBlocks.length} tool files.`);
