/**
 * Session transcript formatter — converts session messages into Markdown.
 * Pure (no DOM deps) so any host — web, mobile, CLI — can export a transcript.
 *
 * Ported from the Runtime TUI:
 * packages/opencode/src/cli/cmd/tui/util/transcript.ts
 *
 * @deprecated Part of the OpenCode-wire projection stack, superseded by the
 * ACP projection layer (`./acp/transcript.ts`'s `acpTranscriptMarkdown` /
 * `acpTranscriptHtml` / `acpTranscriptJsonl`, fed by `./acp/reduce.ts`). The
 * live conversation surface (`apps/web`'s `acp-session-chat`) already
 * renders exclusively from the ACP engine — this module today serves only
 * session-list previews, `?oc` deep-link exports, and `apps/mobile`. Kept
 * working, not removed: still exported, still covered by the golden parity
 * harness (`./transcript.golden.test.ts`). No new callers, please — reach
 * for the ACP projections above instead.
 */

import type { Message, Part } from "./runtime/wire-types";

// ============================================================================
// Types
// ============================================================================

/** @deprecated OpenCode-wire formatting options for {@link formatTranscript}.
 *  The ACP replacements (`acpTranscriptMarkdown`/`acpTranscriptHtml` in
 *  `./acp/transcript.ts`) take no options — they always render the full
 *  coalesced chat-item stream. */
export interface TranscriptOptions {
  /** Include reasoning / thinking blocks. */
  thinking: boolean;
  /** Include tool call input/output details. */
  toolDetails: boolean;
  /** Show assistant metadata (agent, model, duration). */
  assistantMetadata: boolean;
}

/** @deprecated OpenCode-wire session header shape for {@link formatTranscript}.
 *  ACP callers already have this from `client.transcript()`'s session
 *  metadata or the platform `ProjectSession` — no equivalent type is needed. */
export interface SessionInfo {
  id: string;
  title: string;
  time: { created: number; updated: number };
}

/** @deprecated OpenCode-wire message+parts shape for {@link formatTranscript}
 *  and `classifyTurn` (`./core/turns/classify.ts`). The ACP replacement is
 *  `AcpStoredEnvelope[]` (`./acp/transcript.ts`), fed to
 *  `acpTranscriptMarkdown`/`acpTranscriptHtml`/`projectAcpChatItems`. */
interface TranscriptMessageInfo {
  id: string;
  role: string;
  agent?: string;
  modelID?: string;
  time?: {
    created?: number;
    completed?: number;
  };
}

interface TranscriptPartState {
  status?: string;
  input?: unknown;
  output?: string;
  error?: string;
}

interface TranscriptPart {
  id: string;
  type: string;
  synthetic?: boolean;
  text?: string;
  tool?: string;
  state?: TranscriptPartState;
}
export interface MessageWithParts {
  info: Message;
  parts: Part[];
}

/** @deprecated Defaults for the deprecated {@link TranscriptOptions}. */
interface TranscriptMessage {
  info: TranscriptMessageInfo;
  parts: TranscriptPart[];
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

function formatPart(part: TranscriptPart, options: TranscriptOptions): string {
  if (part.type === "text" && !part.synthetic) {
    return `${part.text ?? ""}\n\n`;
  }

  if (part.type === "reasoning") {
    if (options.thinking) {
      return `> _Thinking:_\n>\n> ${(part.text ?? "").replace(/\n/g, "\n> ")}\n\n`;
    }
    return "";
  }

  if (part.type === "tool") {
    let result = `**Tool: ${part.tool ?? "unknown"}**\n`;

    if (options.toolDetails && part.state?.input) {
      try {
        const inputStr =
          typeof part.state.input === "string"
            ? part.state.input
            : JSON.stringify(part.state.input, null, 2);
        result += `\n<details>\n<summary>Input</summary>\n\n\`\`\`json\n${inputStr}\n\`\`\`\n\n</details>\n`;
      } catch {
        // skip malformed input
      }
    }

    if (
      options.toolDetails &&
      part.state?.status === "completed" &&
      part.state.output
    ) {
      const output = part.state.output;
      const truncated =
        output.length > 2000
          ? output.slice(0, 2000) + "\n... (truncated)"
          : output;
      result += `\n<details>\n<summary>Output</summary>\n\n\`\`\`\n${truncated}\n\`\`\`\n\n</details>\n`;
    }

    if (
      options.toolDetails &&
      part.state?.status === "error" &&
      part.state.error
    ) {
      result += `\n**Error:**\n\`\`\`\n${part.state.error}\n\`\`\`\n`;
    }

    result += "\n";
    return result;
  }

  // skip other part types (step-start, step-finish, snapshot, patch, agent, etc.)
  return "";
}

// ============================================================================
// Format a single message
// ============================================================================

function formatAssistantHeader(
  msg: TranscriptMessageInfo,
  includeMetadata: boolean,
): string {
  if (!includeMetadata) return `## Assistant\n\n`;

  const agent = msg.agent ? titleCase(msg.agent) : "Assistant";
  const model = msg.modelID || "";
  let duration = "";
  if (msg.time?.completed && msg.time?.created) {
    duration = formatDuration(msg.time.completed - msg.time.created);
  }

  const meta = [model, duration].filter(Boolean).join(" · ");
  return meta ? `## ${agent} (${meta})\n\n` : `## ${agent}\n\n`;
}

function formatMessage(
  msg: TranscriptMessageInfo,
  parts: TranscriptPart[],
  options: TranscriptOptions,
): string {
  let result = "";

  if (msg.role === "user") {
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
 *
 * @deprecated Part of the OpenCode-wire projection stack. Use
 * `acpTranscriptMarkdown`/`acpTranscriptHtml` (`./acp/transcript.ts`) with
 * `AcpStoredEnvelope[]` rows instead — same "one section per message/tool"
 * shape, sourced from the ACP engine that already owns the live conversation
 * surface. Frozen behavior, pinned by `./transcript.golden.test.ts`.
 */
export function formatTranscript(
  session: SessionInfo,
  messages: TranscriptMessage[],
  options: TranscriptOptions = DEFAULT_TRANSCRIPT_OPTIONS,
): string {
  let transcript = `# ${session.title || "Untitled Session"}\n\n`;
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
export function getTranscriptFilename(
  sessionId: string,
  _title?: string,
): string {
  return `session-${sessionId}.md`;
}
