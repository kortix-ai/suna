#!/usr/bin/env node
/**
 * Splits tool-renderers.tsx into shared modules + per-tool files.
 * Run: node apps/web/scripts/split-tool-renderers.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src/features/session/tool/tool-renderers.tsx');
const TOOL_DIR = path.join(ROOT, 'src/features/session/tool');
const SHARED_DIR = path.join(TOOL_DIR, 'shared');
const TOOLS_DIR = path.join(TOOL_DIR, 'tools');

const source = fs.readFileSync(SRC, 'utf8');
const lines = source.split('\n');

function toolNameToFile(name) {
  const base = name.replace(/Tool$/, '');
  const kebab = base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
  return `${kebab}-tool.tsx`;
}

// Find import block (through first blank after 'use client' imports)
let importEnd = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith("import { isShowContentUnavailable")) {
    importEnd = i;
    break;
  }
}
const originalImports = lines.slice(0, importEnd + 2).join('\n');

// Find tool function starts
const toolStarts = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^function (\w+Tool)\(/);
  if (m) toolStarts.push({ line: i, name: m[1] });
}

// Find end of registrations after each tool (last consecutive ToolRegistry or forEach register line)
function findBlockEnd(startLine) {
  let i = startLine;
  // advance through function body
  let braceDepth = 0;
  let started = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') {
        braceDepth++;
        started = true;
      } else if (ch === '}') braceDepth--;
    }
    if (started && braceDepth === 0) {
      i++;
      break;
    }
  }
  // consume registrations
  while (i < lines.length) {
    const line = lines[i].trim();
    if (
      line.startsWith('ToolRegistry.register') ||
      line.startsWith('].forEach') ||
      (line.startsWith('[') && line.includes('integration'))
    ) {
      // multi-line forEach array
      if (line.startsWith('[')) {
        while (i < lines.length && !lines[i].includes('].forEach')) i++;
        i++;
        continue;
      }
      i++;
      continue;
    }
    break;
  }
  return i;
}

const blocks = [];
for (let t = 0; t < toolStarts.length; t++) {
  const start = toolStarts[t].line;
  const end = findBlockEnd(start);
  const nextStart = t + 1 < toolStarts.length ? toolStarts[t + 1].line : null;

  // Include helpers between registrations and next tool
  let blockEnd = end;
  if (nextStart !== null && nextStart > end) {
    // helpers before next tool belong to current block if they're before next tool function
    blockEnd = nextStart;
  } else if (t === toolStarts.length - 1) {
    // last tool - go until parseErrorContent or export function ToolError
    for (let j = end; j < lines.length; j++) {
      if (lines[j].startsWith('export function ToolError')) {
        blockEnd = j;
        break;
      }
    }
  }

  blocks.push({
    name: toolStarts[t].name,
    start,
    end: blockEnd,
    content: lines.slice(start, blockEnd).join('\n'),
  });
}

// Shared infrastructure: from MD_FLUSH_CLASSES through StructuredOutput end (before first tool)
let sharedStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('const MD_FLUSH_CLASSES')) {
    sharedStart = i;
    break;
  }
}
const sharedEnd = toolStarts[0]?.line ?? 1462;
const sharedContent = lines.slice(sharedStart, sharedEnd).join('\n');

// Tail: ToolError through end (but extract parseErrorContent from question/executor section)
let tailStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('export function ToolError')) {
    tailStart = i;
    break;
  }
}
const tailContent = lines.slice(tailStart).join('\n');

// Executor helpers + parseErrorContent (between QuestionTool registrations and ToolError)
let midStart = -1;
let midEnd = tailStart;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('interface ValidationIssue')) {
    midStart = i;
    break;
  }
}
const midSharedContent = midStart >= 0 ? lines.slice(midStart, midEnd).join('\n') : '';

// Standard shared import header for tool files
const SHARED_IMPORTS = `'use client';

import { BasicTool } from '@/features/session/tool/shared/basic-tool';
import {
  BoundActivateContext,
  ToolDurationContext,
  ToolRunningContext,
  ToolSurfaceContext,
} from '@/features/session/tool/shared/contexts';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  ToolEmptyState,
  ToolOutputFallback,
} from '@/features/session/tool/shared/tool-output';
import {
  firstMeaningfulLine,
  getAgentCardLabel,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/part-utils';
import { useToolNavigation } from '@/features/session/tool/shared/navigation';
import { StatusIcon } from '@/features/session/tool/shared/status-icon';
import { DiagnosticsDisplay, getToolDiagnostics } from '@/features/session/tool/shared/diagnostics';
import { DiffChanges, InlineDiffView } from '@/features/session/tool/shared/diff';
import { StructuredOutput } from '@/features/session/tool/shared/structured-output';
import { ToolCode } from '@/features/session/tool/shared/tool-code';
import { InlineServicePreview } from '@/features/session/tool/shared/service-preview';
import { SubAgentActivity, SubAgentStatusBanner } from '@/features/session/tool/shared/sub-agent';
import {
  InlineFileList,
  InlineGrepResults,
  ToolListRow,
  parseFilePaths,
  parseGrepOutput,
} from '@/features/session/tool/shared/file-list';
import {
  SessionMetadataList,
  SessionTimeLabel,
  InlineSessionMessagesList,
  parseSessionMetadataOutput,
  parseSessionMessagesOutput,
  formatBashOutput,
} from '@/features/session/tool/shared/session-helpers';
import { ToolError } from '@/features/session/tool/tool-error';
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
import { GenericTool } from '@/features/session/tool/generic-tool';
`;

// We'll use original imports adapted per file - for now copy full imports from source
const toolImportHeader = originalImports.replace(
  /from '\.\.\/show-availability'/,
  "from '@/features/session/show-availability'",
);

fs.mkdirSync(SHARED_DIR, { recursive: true });
fs.mkdirSync(TOOLS_DIR, { recursive: true });

// Write shared files - we'll split shared content into logical modules via a second pass
// For now write monolithic shared chunks that we'll refine

console.log(`Found ${blocks.length} tool blocks`);
console.log(`Shared lines: ${sharedStart}-${sharedEnd}`);
console.log(`Tail starts at line ${tailStart}`);

// Write tool files
const toolExports = [];
for (const block of blocks) {
  const fileName = toolNameToFile(block.name);
  const filePath = path.join(TOOLS_DIR, fileName);

  // Export the main tool function
  let content = block.content.replace(
    new RegExp(`^function ${block.name}\\(`, 'm'),
    `export function ${block.name}(`,
  );

  // Export other tool functions in same block (e.g. TaskUpdateTool in task-list block)
  content = content.replace(/^function (\w+Tool)\(/gm, (match, name) => {
    if (name === block.name) return match.replace('function', 'export function');
    return `export ${match}`;
  });

  const fileContent = `${toolImportHeader}

${content}
`;

  fs.writeFileSync(filePath, fileContent);
  toolExports.push({ name: block.name, file: fileName });
  console.log(`Wrote ${fileName} (${block.end - block.start} lines)`);
}

// Write tools/index.ts
const indexContent = `/**
 * Side-effect imports register all session tool renderers with ToolRegistry.
 */
${toolExports.map((t) => `import './${t.file.replace('.tsx', '')}';`).join('\n')}
`;
fs.writeFileSync(path.join(TOOLS_DIR, 'index.ts'), indexContent);

// Save metadata for manual shared extraction
fs.writeFileSync(
  path.join(TOOL_DIR, '.split-meta.json'),
  JSON.stringify(
    {
      sharedStart,
      sharedEnd,
      tailStart,
      midStart,
      blocks: blocks.map((b) => ({ name: b.name, file: toolNameToFile(b.name), ...b })),
    },
    null,
    2,
  ),
);

console.log('Done. Next: extract shared modules and wire barrel exports.');
