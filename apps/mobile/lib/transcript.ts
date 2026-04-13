/**
 * Session transcript formatter — converts session messages into Markdown.
 * Ported from apps/web/src/lib/transcript.ts
 */

export interface TranscriptOptions {
  thinking: boolean;
  toolDetails: boolean;
  assistantMetadata: boolean;
}

export const DEFAULT_TRANSCRIPT_OPTIONS: TranscriptOptions = {
  thinking: false,
  toolDetails: true,
  assistantMetadata: true,
};

function titleCase(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function fmtDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining.toFixed(0)}s`;
}

function formatPart(part: any, options: TranscriptOptions): string {
  if (part.type === 'text' && !part.synthetic) {
    return `${part.text || ''}\n\n`;
  }

  if (part.type === 'reasoning') {
    if (options.thinking) {
      return `> _Thinking:_\n>\n> ${(part.text || '').replace(/\n/g, '\n> ')}\n\n`;
    }
    return '';
  }

  if (part.type === 'tool') {
    let result = `**Tool: ${part.tool}**\n`;

    if (options.toolDetails && part.state?.input) {
      try {
        const inputStr = typeof part.state.input === 'string'
          ? part.state.input
          : JSON.stringify(part.state.input, null, 2);
        result += `\n<details>\n<summary>Input</summary>\n\n\`\`\`json\n${inputStr}\n\`\`\`\n\n</details>\n`;
      } catch {}
    }

    if (options.toolDetails && part.state?.status === 'completed' && part.state?.output) {
      const output = part.state.output;
      const truncated = output.length > 2000 ? output.slice(0, 2000) + '\n... (truncated)' : output;
      result += `\n<details>\n<summary>Output</summary>\n\n\`\`\`\n${truncated}\n\`\`\`\n\n</details>\n`;
    }

    if (options.toolDetails && part.state?.status === 'error' && part.state?.error) {
      result += `\n**Error:**\n\`\`\`\n${part.state.error}\n\`\`\`\n`;
    }

    result += '\n';
    return result;
  }

  return '';
}

function formatAssistantHeader(msg: any, includeMetadata: boolean): string {
  if (!includeMetadata) return `## Assistant\n\n`;

  const agent = msg.agent ? titleCase(msg.agent) : 'Assistant';
  const model = msg.modelID || '';
  let duration = '';
  if (msg.time?.completed && msg.time?.created) {
    duration = fmtDuration(msg.time.completed - msg.time.created);
  }

  const meta = [model, duration].filter(Boolean).join(' · ');
  return meta ? `## ${agent} (${meta})\n\n` : `## ${agent}\n\n`;
}

function formatMessage(msg: any, parts: any[], options: TranscriptOptions): string {
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

export interface SessionInfo {
  id: string;
  title: string;
  time: { created: number; updated: number };
}

export interface MessageWithParts {
  info: any;
  parts: any[];
}

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

export function getTranscriptFilename(sessionId: string, title?: string): string {
  const slug = title
    ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    : sessionId.slice(0, 8);
  return `session-${slug}.md`;
}
