/**
 * Session transcript formatter — converts session messages into Markdown.
 *
 * Ported from the OpenCode TUI:
 * packages/opencode/src/cli/cmd/tui/util/transcript.ts
 */

import type { Part, Message } from '@opencode-ai/sdk/v2/client';

// ============================================================================
// Types
// ============================================================================

export interface TranscriptOptions {
  /** Include reasoning / thinking blocks. */
  thinking: boolean;
  /** Include tool call input/output details. */
  toolDetails: boolean;
  /** Show assistant metadata (agent, model, duration). */
  assistantMetadata: boolean;
}

export interface SessionInfo {
  id: string;
  title: string;
  time: { created: number; updated: number };
}

export interface MessageWithParts {
  info: Message;
  parts: Part[];
}

export const DEFAULT_TRANSCRIPT_OPTIONS: TranscriptOptions = {
  thinking: false,
  toolDetails: true,
  assistantMetadata: true,
};

// ============================================================================
// Helpers
// ============================================================================

function titleCase(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining.toFixed(0)}s`;
}

// ============================================================================
// Format individual parts
// ============================================================================

function formatPart(part: Part, options: TranscriptOptions): string {
  if (part.type === 'text' && !('synthetic' in part && part.synthetic)) {
    return `${(part as any).text}\n\n`;
  }

  if (part.type === 'reasoning') {
    if (options.thinking) {
      return `> _Thinking:_\n>\n> ${((part as any).text || '').replace(/\n/g, '\n> ')}\n\n`;
    }
    return '';
  }

  if (part.type === 'tool') {
    const toolPart = part as any;
    let result = `**Tool: ${toolPart.tool}**\n`;

    if (options.toolDetails && toolPart.state?.input) {
      try {
        const inputStr = typeof toolPart.state.input === 'string'
          ? toolPart.state.input
          : JSON.stringify(toolPart.state.input, null, 2);
        result += `\n<details>\n<summary>Input</summary>\n\n\`\`\`json\n${inputStr}\n\`\`\`\n\n</details>\n`;
      } catch {
        // skip malformed input
      }
    }

    if (options.toolDetails && toolPart.state?.status === 'completed' && toolPart.state?.output) {
      const output = toolPart.state.output;
      const truncated = output.length > 2000 ? output.slice(0, 2000) + '\n... (truncated)' : output;
      result += `\n<details>\n<summary>Output</summary>\n\n\`\`\`\n${truncated}\n\`\`\`\n\n</details>\n`;
    }

    if (options.toolDetails && toolPart.state?.status === 'error' && toolPart.state?.error) {
      result += `\n**Error:**\n\`\`\`\n${toolPart.state.error}\n\`\`\`\n`;
    }

    result += '\n';
    return result;
  }

  // skip other part types (step-start, step-finish, snapshot, patch, agent, etc.)
  return '';
}

// ============================================================================
// Format a single message
// ============================================================================

function formatAssistantHeader(msg: any, includeMetadata: boolean): string {
  if (!includeMetadata) return `## Assistant\n\n`;

  const agent = msg.agent ? titleCase(msg.agent) : 'Assistant';
  const model = msg.modelID || '';
  let duration = '';
  if (msg.time?.completed && msg.time?.created) {
    duration = formatDuration(msg.time.completed - msg.time.created);
  }

  const meta = [model, duration].filter(Boolean).join(' · ');
  return meta
    ? `## ${agent} (${meta})\n\n`
    : `## ${agent}\n\n`;
}

function formatMessage(
  msg: Message,
  parts: Part[],
  options: TranscriptOptions,
): string {
  let result = '';

  if (msg.role === 'user') {
    result += `## User\n\n`;
  } else {
    result += formatAssistantHeader(msg, options.assistantMetadata);
  }

  for (const part of parts) {
    result += formatPart(part, options);
  }

  return result;
}

// ============================================================================
// Main export
// ============================================================================

/**
 * Format an entire session as a Markdown transcript.
 */
export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions = DEFAULT_TRANSCRIPT_OPTIONS,
): string {
  let transcript = `# ${session.title || 'Untitled Session'}\n\n`;
  transcript += `**Session ID:** \`${session.id}\`\n`;
  transcript += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`;
  transcript += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`;
  transcript += `---\n\n`;

  for (const msg of messages) {
    transcript += formatMessage(msg.info, msg.parts, options);
    transcript += `---\n\n`;
  }

  return transcript;
}

/**
 * Generate a default filename for the transcript.
 * Always keyed off the session id so the file is stable and unambiguous
 * (e.g. `session-<uuid>.md`) rather than a mutable, collision-prone title slug.
 */
export function getTranscriptFilename(sessionId: string, _title?: string): string {
  return `session-${sessionId}.md`;
}
