'use client';

/**
 * /debug/image-gen — one turn's run of `image_gen` calls, drawn by the real
 * transcript (`TurnViewport` + `SessionTurn`), so `transcript.tsx` groups the
 * calls into one grid exactly as in a session.
 *
 * The default run copies the shape of a prod turn whose grid was several
 * screens tall: a `codemode` call, then six `image_gen` calls at 9:16 — four
 * done (3 + 2 + 3 + 2 images, 941×1672 each) and two that hit the turn's image
 * limit (3 + 2 prompts). The prompts and images are synthetic: each image is
 * drawn on a canvas and seeded into the blob cache under its sandbox path.
 *
 * No network: queries are disabled and no runtime is connected. Theme: the
 * /debug toggle, or press `D`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import '@kortix/ui/session/tool/tools/register';

import { sessionLogOfV1Rows, sessionLogTurns } from '@kortix/sdk';
import { binaryBlobKeys, useRuntimeStore, useSessionStateStore } from '@kortix/sdk/react';
import { SessionTurn, TurnViewport } from '@kortix/ui/session';
import { SESSION_TRANSCRIPT_CLASS } from '@kortix/ui/session/thread/session-body';

const SESSION_ID = 'ses_DebugImageGenRun';
const USER_ID = 'msg_DebugImageGenUser';
const ASSISTANT_ID = 'msg_DebugImageGenAssistant';
const IDLE = { type: 'idle' } as const;
const NOOP = () => {};
const noopAsync = async () => {};
const NO_OUTCOME = {};

const SHAPES = {
  '9:16': { size: '941x1672', width: 941, height: 1672 },
  '16:9': { size: '1672x941', width: 1672, height: 941 },
  '1:1': { size: '1024x1024', width: 1024, height: 1024 },
} as const;
type Shape = keyof typeof SHAPES;

/** The prod run: images per call, and whether the call hit the image limit. */
const RUN = [
  { n: 3, failed: false },
  { n: 2, failed: false },
  { n: 3, failed: false },
  { n: 2, failed: false },
  { n: 3, failed: true },
  { n: 2, failed: true },
] as const;

const pathOf = (call: number, i: number) => `/workspace/output/images/debug-run-${call}-${i}.png`;

function runMessages(shape: Shape) {
  const { size } = SHAPES[shape];
  const time = { created: Date.now() - 120_000, completed: Date.now() - 60_000 };
  let used = 0;
  const imageGen = RUN.map(({ n, failed }, call) => {
    const prompts = Array.from({ length: n }, (_, i) => `Frame ${call * 3 + i + 1} of a space explainer`);
    const input = { action: 'generate', model: 'codex/gpt-image-2', aspect_ratio: shape, quality: 'high', prompts };
    const state = failed
      ? { status: 'error', input, error: `Image limit for this turn reached (10 images; ${used} used, ${n} asked).`, time: { start: time.created, end: time.created + 1 } }
      : {
          status: 'completed',
          input,
          output: JSON.stringify({
            action: 'generate',
            model: 'codex/gpt-image-2',
            provider: 'openai-codex',
            images: prompts.map((prompt, i) => ({ path: pathOf(call, i), size, prompt })),
          }),
          title: '',
          metadata: {},
          time: { start: time.created, end: time.created + 40_000 },
        };
    if (!failed) used += n;
    return { id: `prt_DebugImageGen${call}`, sessionID: SESSION_ID, messageID: ASSISTANT_ID, type: 'tool', callID: `call_DebugImageGen${call}`, tool: 'image_gen', state };
  });
  return [
    {
      info: { id: USER_ID, sessionID: SESSION_ID, role: 'user', time: { created: time.created } },
      parts: [{ id: 'prt_DebugImageGenAsk', sessionID: SESSION_ID, messageID: USER_ID, type: 'text', text: 'Make the frames for three short videos.' }],
    },
    {
      info: {
        id: ASSISTANT_ID,
        sessionID: SESSION_ID,
        role: 'assistant',
        time,
        parentID: USER_ID,
        modelID: 'claude-opus-5-5',
        providerID: 'kortix',
        mode: 'kortix',
        agent: 'kortix',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: 'stop',
      },
      parts: [
        {
          id: 'prt_DebugImageGenCode',
          sessionID: SESSION_ID,
          messageID: ASSISTANT_ID,
          type: 'tool',
          callID: 'call_DebugImageGenCode',
          tool: 'codemode',
          state: { status: 'completed', input: { code: 'plan()' }, output: 'ok', title: '', metadata: {}, time: { start: time.created, end: time.created + 1 } },
        },
        ...imageGen,
        { id: 'prt_DebugImageGenDone', sessionID: SESSION_ID, messageID: ASSISTANT_ID, type: 'text', text: 'Here are the frames.' },
      ],
    },
  ];
}

/** A synthetic image at `shape`: a gradient with its number, as a PNG blob. */
async function drawImage(shape: Shape, index: number): Promise<Blob> {
  const { width, height } = SHAPES[shape];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const hue = (index * 37) % 360;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${hue} 60% 22%)`);
  gradient.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 55%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = `hsl(${hue} 20% 96%)`;
  ctx.font = `600 ${Math.round(Math.min(width, height) / 4)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(index + 1), width / 2, height / 2);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'));
}

function ShapeButton({ shape, active, onClick }: { shape: Shape; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="border-border text-muted-foreground hover:text-foreground aria-pressed:text-foreground aria-pressed:bg-muted rounded-md border px-3 py-1.5 text-xs"
    >
      {shape}
    </button>
  );
}

export default function ImageGenRunPage() {
  const [shape, setShape] = useState<Shape>('9:16');
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } }));
  const [ready, setReady] = useState(false);
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());

  useEffect(() => {
    let live = true;
    setReady(false);
    const store = useSessionStateStore.getState();
    store.clearSession(SESSION_ID);
    store.hydrate(SESSION_ID, runMessages(shape) as never);
    store.setStatus(SESSION_ID, IDLE);
    void Promise.all(
      RUN.flatMap(({ n, failed }, call) => (failed ? [] : Array.from({ length: n }, (_, i) => ({ call, i })))).map(async ({ call, i }, index) => {
        queryClient.setQueryData(binaryBlobKeys.file(serverUrl, pathOf(call, i)), await drawImage(shape, index));
      }),
    ).then(() => live && setReady(true));
    return () => {
      live = false;
      useSessionStateStore.getState().clearSession(SESSION_ID);
    };
  }, [shape, queryClient, serverUrl]);

  const turns = useMemo(
    () => (ready ? sessionLogTurns(sessionLogOfV1Rows(SESSION_ID, SESSION_ID, runMessages(shape) as never).threads[0]!) : []),
    [ready, shape],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <div className="bg-background min-h-dvh">
        <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col">
          <header className="border-border bg-background sticky top-0 z-10 flex items-center gap-2 border-b px-4 py-3">
            <p className="mr-auto text-sm font-medium">Image run</p>
            {(Object.keys(SHAPES) as Shape[]).map((one) => (
              <ShapeButton key={one} shape={one} active={one === shape} onClick={() => setShape(one)} />
            ))}
          </header>
          <div role="log" data-testid="image-gen-run" className={SESSION_TRANSCRIPT_CLASS}>
            {turns.map((turn, turnIndex) => (
              <TurnViewport key={`${shape}:${turn.id}`} turnId={turn.id}>
                <SessionTurn
                  turn={turn}
                  turnOutcome={NO_OUTCOME}
                  isLast={turnIndex === turns.length - 1}
                  ownsPlan={turn.plan}
                  isFirstTurn={turnIndex === 0}
                  sessionId={SESSION_ID}
                  sessionStatus={IDLE}
                  sessionWorking={false}
                  isWorkingTurn={false}
                  suppressBusyIndicator={false}
                  awaitingUser={false}
                  pending={false}
                  interruptedBeforeRun={false}
                  isCompaction={false}
                  permissions={[]}
                  questions={[]}
                  agentNames={[]}
                  onPermissionReply={noopAsync}
                  onRewind={NOOP}
                  rewindDisabled
                />
              </TurnViewport>
            ))}
          </div>
        </div>
      </div>
    </QueryClientProvider>
  );
}
