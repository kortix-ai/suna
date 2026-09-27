'use client';

/**
 * /debug/turn-error — the failed-turn checkpoint row, case by case, with a
 * verdict.
 *
 * Each case is a synthetic stored error, in the shape OpenCode persists on an
 * assistant message. The page runs it through the same SDK calls the
 * transcript uses (`getTurnError`, `getTurnErrorDetails`,
 * `getTurnErrorRawText`), asks the banner which row that renders
 * (`describeTurnErrorRow`), checks both against the expectation, and renders
 * the real `TurnErrorDisplay` beneath. No network, no session. Click a row to
 * open it, or use "Open all rows". Theme: the /debug toggle, or press `D`.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { describeTurnErrorRow, TurnErrorDisplay } from '@/features/session/session-error-banner';
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

type RowExpectation = 'checkpoint, opens' | 'checkpoint, no caret' | 'billing card';

interface DebugCase {
  title: string;
  /** The value stored as `AssistantMessage.error`. */
  error: unknown;
  /** The sentence the row must show. */
  sentence: string;
  /** Which row renders, and whether it opens. */
  row: RowExpectation;
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
    row: 'checkpoint, opens',
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
    row: 'checkpoint, opens',
  },
  {
    title: 'Gateway error with a suggestion (suggestion stays visible)',
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
    row: 'checkpoint, opens',
  },
  {
    title: 'Every gateway attempt failed (attempt chain inside)',
    error: {
      name: 'UnknownError',
      data: {
        message: JSON.stringify({
          message: 'All upstream candidates failed',
          code: 'upstream_error',
          provider: 'openrouter',
          request_id: 'req_debug_0002',
          attempt_failures: [
            {
              attempt: 1,
              provider: 'openai-codex',
              route_model: 'codex/gpt-5.6-sol',
              resolved_model: 'gpt-5.6-sol',
              stage: 'stream_error',
              status: 400,
              code: 'context_length_exceeded',
              message: 'Your input exceeds the context window of this model.',
            },
            {
              attempt: 2,
              provider: 'openrouter',
              route_model: 'glm-5.3-flash',
              resolved_model: 'z-ai/glm-5.3-flash',
              stage: 'stream_probe',
              code: 'stream_probe_timeout',
              message: 'No bytes within 60 seconds.',
            },
          ],
        }),
      },
    },
    sentence: 'All upstream candidates failed',
    row: 'checkpoint, opens',
  },
  {
    title: 'Provider body serialized into the message',
    error: {
      name: 'UnknownError',
      data: { message: '{"message":"Provided authentication token is expired.","code":401}' },
    },
    sentence: 'Provided authentication token is expired.',
    row: 'checkpoint, opens',
  },
  {
    title: 'Plain sentence (nothing to open)',
    error: { name: 'UnknownError', data: { message: 'Connection reset by peer' } },
    sentence: 'Connection reset by peer',
    row: 'checkpoint, no caret',
  },
  {
    title: 'Usage limit (keeps the boxed upgrade card)',
    error: {
      name: 'UnknownError',
      data: { message: '{"message":"The usage limit has been reached","code":429}' },
    },
    sentence: 'The usage limit has been reached',
    row: 'billing card',
  },
];

function turnWithError(error: unknown): TurnLike {
  return {
    userMessage: { info: { id: 'msg_debug_user' }, parts: [] },
    assistantMessages: [{ info: { id: 'msg_debug_assistant', error }, parts: [] }],
  } as unknown as TurnLike;
}

function rowLabel({
  kind,
  expandable,
}: ReturnType<typeof describeTurnErrorRow>): RowExpectation {
  if (kind === 'billing-card') return 'billing card';
  return expandable ? 'checkpoint, opens' : 'checkpoint, no caret';
}

function evaluate(debugCase: DebugCase) {
  const turn = turnWithError(debugCase.error);
  const text = getTurnError(turn);
  const details = getTurnErrorDetails(turn);
  const raw = getTurnErrorRawText(turn);
  const row = text ? rowLabel(describeTurnErrorRow({ text, gateway: details, raw })) : undefined;
  const checks = [
    { label: 'Sentence', pass: text === debugCase.sentence, got: text ?? '(none)' },
    { label: 'Row', pass: row === debugCase.row, got: row ?? '(none)' },
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
  const [openAll, setOpenAll] = useState(false);
  const results = CASES.map((debugCase) => ({ debugCase, ...evaluate(debugCase) }));
  const failed = results.filter((result) => !result.pass).length;

  return (
    <main className="bg-background min-h-dvh">
      <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-10 pb-20">
        <header className="space-y-1.5">
          <h1 className="text-foreground text-xl font-medium">Turn error checkpoint row</h1>
          <p className="text-muted-foreground text-xs">
            Each case runs a stored error through the transcript&apos;s SDK calls and renders the
            real row. Click a row to open it.
          </p>
          <div className="flex items-center justify-between gap-3">
            <div data-testid="turn-error-verdict">
              {failed === 0 ? (
                <Verdict pass className="text-sm" />
              ) : (
                <span className="text-kortix-red text-sm font-medium">
                  {failed} of {results.length} cases fail
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={() => setOpenAll((value) => !value)}>
              {openAll ? 'Close all rows' : 'Open all rows'}
            </Button>
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
                {/* `key` remounts the row so "Open all rows" resets every disclosure. */}
                <TurnErrorDisplay
                  key={String(openAll)}
                  errorText={text}
                  errorDetails={details}
                  errorRaw={raw}
                  defaultDetailsOpen={openAll}
                />
              </div>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}
