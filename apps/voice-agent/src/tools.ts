/**
 * The two agent-facing tools: `send_prompt` (fire-and-forget hand-off to the
 * Kortix session) and `run_command` (short, waited-on sandbox check). See
 * instructions.ts for how the model is told to use them, and
 * kortix-client.ts for the HTTP calls they wrap.
 */
import { type FunctionTool, tool } from '@livekit/agents';
import { z } from 'zod';
import { nextAckLine } from './ack';
import type { CallContext } from './call-context';
import { runCommandInSandbox, sendPromptToKortix } from './kortix-client';

const sendPromptParams = z.object({
  request: z
    .string()
    .min(1)
    .describe("What was asked, in the speaker's own words, plus who asked it."),
});

const runCommandParams = z.object({
  command: z
    .string()
    .min(1)
    .describe('The shell command to run, e.g. "cat package.json" or "ls -la".'),
  // `.nullable()` in addition to `.optional()`: OpenAI-family tool calling
  // routinely fills every declared property and represents "no value" for an
  // optional argument as an explicit JSON `null` rather than omitting the
  // key (this happens even with strictToolSchema off — it's a model habit,
  // not just a strict-schema requirement). A plain `.optional()` schema
  // accepts a missing key but REJECTS `cwd: null` with a zod validation
  // error — and that validation runs inside the framework's tool-call-stream
  // consumer, before `execute()` below is ever invoked. That is exactly how
  // this tool went silent: the model calls it, the framework logs the
  // attempt, argument parsing throws, a ToolError goes back to the model,
  // and `execute()` — and therefore the fetch in kortix-client.ts — never
  // runs. See generation.js's `performToolExecutions` in the installed
  // @livekit/agents package for the parse-then-execute ordering.
  cwd: z
    .string()
    .nullable()
    .optional()
    .describe('Working directory, relative to the project root. Defaults to the project root.'),
});

export interface VoiceTools {
  /**
   * `string | undefined` — and the `undefined` is the whole point. See
   * `send_prompt`'s execute below: returning nothing is what stops the model
   * speaking after a successful hand-off, because the ack has already been said
   * literally. A string comes back only when there is something the model
   * genuinely has to put into its own words (a refusal, or an unreachable API).
   */
  send_prompt: FunctionTool<{ request: string }, CallContext, string | undefined>;
  run_command: FunctionTool<{ command: string; cwd?: string | null }, CallContext, string>;
}

export function buildTools(): VoiceTools {
  // `tool()`'s type params (`UserData, Schema, Result`) must ALL be given
  // explicitly together: TypeScript disables contextual inference for the
  // rest of a generic call the moment any one type argument is written
  // explicitly, so `parameters`/`execute` would otherwise fall back to the
  // `Schema = undefined` default and fail to type-check against a real zod
  // schema.
  const send_prompt = tool<CallContext, typeof sendPromptParams, string | undefined>({
    name: 'send_prompt',
    description:
      'Hand a request to the Kortix agent for this project. Use for anything needing real ' +
      'information, project files, connectors, memory, or actions. Asynchronous: returns the ' +
      'instant the request is queued, not when Kortix has an answer. This tool SPEAKS the ' +
      '"let me check" line itself — say nothing after a successful hand-off, and do not answer ' +
      'the question yourself. The answer arrives later as something to speak.',
    parameters: sendPromptParams,
    execute: async ({ request }, { ctx }) => {
      const call = ctx.userData;
      const result = await sendPromptToKortix(call, request);

      if (!result.ok) {
        // Two genuinely different failures, and conflating them is how a
        // refusal ("you already asked — wait") got spoken as "I could not reach
        // Kortix", which is false and invites an immediate retry.
        //
        // Both return a STRING on purpose: a returned tool output is what makes
        // the framework generate a reply (see the success path below), and here
        // there is something real the room needs to be told. `kind: 'refused'`
        // text is written by apps/api to be relayed as-is; it is guidance for
        // this model, not an error string.
        if (result.kind === 'refused') return result.error;
        return `Could not reach Kortix (${result.error}). Tell the room you could not send that request right now.`;
      }

      // THE ACK IS SPOKEN HERE, LITERALLY — not returned as an instruction for
      // the model to compose. `session.say()` is TTS with no LLM step, so what
      // the room hears is exactly `nextAckLine()` and nothing else. When the
      // model wrote this sentence itself it appended invention to it (see
      // ack.ts's header for the utterance that started a paid ask-loop).
      //
      // `void` because a SpeechHandle nobody awaits is the intended usage for
      // in-tool speech, and awaiting playout here would hold the tool — and
      // therefore the turn — open for the length of the sentence.
      void ctx.session.say(nextAckLine());

      // RETURNING NOTHING IS LOAD-BEARING. @livekit/agents sets
      // `replyRequired: toolOutput !== undefined` (voice/generation.js), so an
      // undefined result still records a tool-call output in the model's chat
      // context — no dangling tool call — while suppressing the follow-up
      // generation entirely. There is therefore no second utterance for the
      // model to embellish, and nothing in history inviting it to answer early.
      return undefined;
    },
  });

  const run_command = tool<CallContext, typeof runCommandParams, string>({
    name: 'run_command',
    description:
      "Run a shell command in this project's sandbox and get its output back directly — for " +
      'quick checks only (reading a short file, listing a directory, checking something exists). ' +
      'Waits a few seconds and returns the result. Not a hand-off: never use this for anything ' +
      'that changes real state or needs judgement — use send_prompt for that instead.',
    parameters: runCommandParams,
    execute: async ({ command, cwd }, { ctx }) => {
      console.log('[voice-agent] run_command execute() called', { command, cwd });
      const call = ctx.userData;
      // Normalize the schema's `null` (see the param doc above) to
      // `undefined` for kortix-client.ts / apps/api, which only know `cwd`
      // as "present" or "absent", never `null`.
      const result = await runCommandInSandbox(call, command, cwd ?? undefined);
      console.log('[voice-agent] run_command execute() got result', result);

      if (!result.ok) {
        return `The command could not be run (${result.error}). Say briefly that the quick check failed and offer to hand it to send_prompt instead.`;
      }
      if (result.timedOut) {
        return "The command was still running after a few seconds so it was stopped. Say you're not sure and offer to hand it to send_prompt instead.";
      }

      const stdout = (result.stdout ?? '').trim();
      const stderr = (result.stderr ?? '').trim();
      const exitCode = result.exitCode;

      if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
        return `Command exited with code ${exitCode}. stderr: ${stderr.slice(0, 800) || '(empty)'}`;
      }
      if (stdout) return stdout.slice(0, 4000);
      if (stderr) return `(no stdout) stderr: ${stderr.slice(0, 800)}`;
      return '(no output)';
    },
  });

  return { send_prompt, run_command };
}
