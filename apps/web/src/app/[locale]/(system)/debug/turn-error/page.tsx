'use client';

/**
 * /debug/turn-error — the failed-turn row, case by case, with a verdict.
 *
 * Each case is a synthetic stored error, in the shape OpenCode persists on an
 * assistant message. The page runs it through the same SDK calls the
 * transcript uses (`getTurnError`, `getTurnErrorDetails`,
 * `getTurnErrorRawText`), checks the result against the expected sentence, and
 * renders the real `TurnErrorDisplay` beneath it. No network, no session.
 * Theme: the /debug toggle, or press `D`.
 */

import { TurnErrorDisplay } from '@/features/session/session-error-banner';
import { cn } from '@/lib/utils';
import {
  getTurnError,
  getTurnErrorDetails,
  getTurnErrorRawText,
  type TurnLike,
} from '@kortix/sdk';
import { CheckCircleIcon, XCircleIcon } from '@phosphor-icons/react';

function streamChunk(content: string) {
  return JSON.stringify({
    id: 'chatcmpl-00000000-0000-4000-8000-000000000000',
    choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
    created: 1700000000,
    model: 'glm-5.3-flash',
    object: 'chat.completion.chunk',
  });
}

interface DebugCase {
  title: string;
  /** The value stored as `AssistantMessage.error`. */
  error: unknown;
  /** The sentence the row must show. */
  sentence: string;
  /** Whether the SDK must return raw text for the Details section. The
   *  billing cards never render it; the generic row does. */
  hasRaw: boolean;
}

const CASES: DebugCase[] = [
  {
    title: 'Stream chunks that did not parse (the reported error)',
    error: {
      name: 'UnknownError',
      data: {
        message:
          `JSON parsing failed: Text: ${streamChunk('58')} ${streamChunk('90 USD')} ` +
          `${streamChunk('USD).')}. Error message: JSON Parse error: Unable to parse JSON string`,
      },
    },
    sentence: 'The response from glm-5.3-flash could not be read.',
    hasRaw: true,
  },
  {
    title: 'Stream parse failure that names no model',
    error: {
      name: 'UnknownError',
      data: {
        message:
          'AI_JSONParseError: JSON parsing failed: Text: {"choices":[. ' +
          'Error message: Unexpected end of JSON input',
      },
    },
    sentence: 'The model response could not be read.',
    hasRaw: true,
  },
  {
    title: 'Gateway error behind an HTTP status',
    error: {
      name: 'APIError',
      data: {
        message: 'Bad Request',
        statusCode: 400,
        isRetryable: false,
        responseBody: JSON.stringify({
          message: 'No upstream configured for model "openai/gpt-4.1"',
          code: 'provider_not_connected',
          provider: 'openai',
          request_id: 'req_debug_0001',
          suggestion: 'Add an openai API key in project settings, then retry.',
        }),
      },
    },
    sentence: 'No upstream configured for model "openai/gpt-4.1"',
    hasRaw: true,
  },
  {
    title: 'Provider body serialized into the message',
    error: {
      name: 'UnknownError',
      data: { message: '{"message":"Provided authentication token is expired.","code":401}' },
    },
    sentence: 'Provided authentication token is expired.',
    hasRaw: true,
  },
  {
    title: 'Plain sentence (nothing to fold)',
    error: { name: 'UnknownError', data: { message: 'Connection reset by peer' } },
    sentence: 'Connection reset by peer',
    hasRaw: false,
  },
  {
    title: 'Usage limit (keeps the boxed upgrade card)',
    error: {
      name: 'UnknownError',
      data: { message: '{"message":"The usage limit has been reached","code":429}' },
    },
    sentence: 'The usage limit has been reached',
    hasRaw: true,
  },
];

function turnWithError(error: unknown): TurnLike {
  return {
    userMessage: { info: { id: 'msg_debug_user' }, parts: [] },
    assistantMessages: [{ info: { id: 'msg_debug_assistant', error }, parts: [] }],
  } as unknown as TurnLike;
}

function evaluate(debugCase: DebugCase) {
  const turn = turnWithError(debugCase.error);
  const text = getTurnError(turn);
  const details = getTurnErrorDetails(turn);
  const raw = getTurnErrorRawText(turn);
  const checks = [
    { label: 'Sentence', pass: text === debugCase.sentence, got: text ?? '(none)' },
    {
      label: 'Raw text',
      pass: Boolean(raw) === debugCase.hasRaw,
      got: raw ? 'present' : 'absent',
    },
  ];
  return { text, details, raw, checks, pass: checks.every((check) => check.pass) };
}

function Verdict({ pass, className }: { pass: boolean; className?: string }) {
  const Glyph = pass ? CheckCircleIcon : XCircleIcon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        pass ? 'text-kortix-green' : 'text-kortix-red',
        className,
      )}
    >
      <Glyph weight="fill" className="size-4 shrink-0" />
      {pass ? 'Pass' : 'Fail'}
    </span>
  );
}

export default function DebugTurnErrorPage() {
  const results = CASES.map((debugCase) => ({ debugCase, ...evaluate(debugCase) }));
  const failed = results.filter((result) => !result.pass).length;

  return (
    <main className="bg-background min-h-dvh">
      <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-10 pb-20">
        <header className="space-y-1.5">
          <h1 className="text-foreground text-xl font-medium">Turn error row</h1>
          <p className="text-muted-foreground text-xs">
            Each case runs a stored error through the transcript&apos;s SDK calls and renders the
            real row.
          </p>
          <div data-testid="turn-error-verdict">
            {failed === 0 ? (
              <Verdict pass className="text-sm" />
            ) : (
              <span className="text-kortix-red text-sm font-medium">
                {failed} of {results.length} cases fail
              </span>
            )}
          </div>
        </header>

        <ol className="space-y-4">
          {results.map(({ debugCase, text, details, raw, checks, pass }) => (
            <li
              key={debugCase.title}
              data-pass={pass}
              className="bg-popover border-border space-y-3 rounded-md border px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-foreground text-sm font-medium">{debugCase.title}</h2>
                <Verdict pass={pass} />
              </div>
              <ul className="space-y-1">
                {checks.map((check) => (
                  <li key={check.label} className="text-muted-foreground text-xs wrap-anywhere">
                    <span
                      className={cn(
                        'font-medium',
                        check.pass ? 'text-kortix-green' : 'text-kortix-red',
                      )}
                    >
                      {check.label}
                    </span>
                    : {check.got}
                  </li>
                ))}
              </ul>
              <div className="border-border border-t pt-3">
                <TurnErrorDisplay errorText={text} errorDetails={details} errorRaw={raw} />
              </div>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}
