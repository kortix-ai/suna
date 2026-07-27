/**
 * The LiveKit agent worker — the voice of a Kortix agent inside a live call.
 *
 * This is the ONLY part of voice that has to be a separate process. apps/api
 * talks to LiveKit's CONTROL plane (livekit-server-sdk: create a room, mint a
 * token, dispatch an agent, send a data message) which is plain stateless HTTP
 * and lives happily in a route handler. This file is the MEDIA plane: it joins
 * the room as a participant, receives audio frames, and runs STT -> LLM -> TTS.
 * `cli.runApp()` below takes over the process and forks a child per call, so it
 * cannot be called from an HTTP handler.
 *
 * It is deployed to LiveKit Cloud's managed agent hosting (`lk agent deploy`),
 * not to our own infrastructure — see README.md. LiveKit injects LIVEKIT_URL /
 * LIVEKIT_API_KEY / LIVEKIT_API_SECRET automatically, and every model below runs
 * through LiveKit Inference, so this worker needs NO third-party API keys and no
 * secrets of its own. Everything else it needs (project, session, call id, the
 * Kortix API URL and a per-call token) arrives in job metadata.
 *
 * Run locally with `bun run src/index.ts dev`.
 */
import { fileURLToPath } from 'node:url';
import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import { type CallContext, resolveCallContext } from './call-context';
import { wireInboundReplies } from './inbound-replies';
import { buildInstructions } from './instructions';
import { buildTools } from './tools';
import { postUserTurn, wireTranscripts } from './transcripts';

// No prewarm: there is no local model to load any more. Turn detection is
// hosted (see the AgentSession comment below), so nothing here has to keep up
// with realtime audio on whatever host the worker happens to land on.

export default defineAgent({
  entry: async (ctx) => {

    // Read public call context from the room and the worker bearer from private
    // dispatch metadata. Both values are available before `ctx.connect()`.
    const callContext: CallContext = resolveCallContext(
      ctx.job.room?.name,
      ctx.job.room?.metadata,
      ctx.job.metadata,
    );

    const { send_prompt, run_command } = buildTools();

    const session = new voice.AgentSession<CallContext>({
      // LiveKit Inference, not the OpenAI plugin. Two reasons, both learned the
      // hard way:
      //  - It needs NO extra vendor key; the LiveKit credential covers STT.
      //  - The OpenAI STT plugin never emitted user transcription events, so
      //    UserInputTranscribed never fired and the human half of every
      //    conversation was missing from voice_call_turns while the agent was
      //    demonstrably hearing and answering. Deepgram Flux does its own
      //    endpointing and emits transcripts server-side.
      stt: new inference.STT({ model: 'deepgram/flux-general-en' }),
      // LLM and TTS go through Inference too, for the same reason as STT: the
      // LiveKit credential covers them, so this worker carries no vendor keys.
      // That is what lets it deploy to LiveKit Cloud with an empty secret set.
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({ model: 'cartesia/sonic-2' }),
      // Turn detection is LiveKit's hosted VAD + TurnDetector, NOT a local
      // silero plugin. Running silero in-process was the original choice — one
      // less network hop — but its inference has to keep up with realtime, and
      // on a busy host it simply does not: 152 "VAD inference slower than
      // realtime" warnings and, more damningly, userTurnCompleted stayed at 0
      // across every run. The agent never heard a single word, while still
      // greeting on join, so it looked alive the whole time.
      //
      // A hosted detector cannot be starved by whatever else the machine is
      // doing, which matters far more here than saving a round trip.
      // AgentSession auto-provisions it when no vad/turnDetection is pinned.
      userData: callContext,
    });

    wireTranscripts(session, callContext);

    const agent = voice.Agent.create<CallContext>({
      instructions: buildInstructions(callContext.botName),
      // Array form, not an object map: both tools were created with an
      // explicit `name` (a named `FunctionTool`), and the object-map form is
      // only for anonymous tools whose name comes from the object key.
      tools: [send_prompt, run_command],
    });

    // This is the REAL user-side transcript capture, not diagnostic-only —
    // see transcripts.ts's file header for why this hook, and not
    // ConversationItemAdded/session.history/UserInputTranscribed, is the one
    // that actually fires for the user's side of a real conversation.
    const originalOnUserTurnCompleted = agent.onUserTurnCompleted.bind(agent);
    agent.onUserTurnCompleted = async (chatCtx, newMessage) => {
      postUserTurn(callContext, chatCtx, newMessage);
      return originalOnUserTurnCompleted(chatCtx, newMessage);
    };

    await session.start({ agent, room: ctx.room });
    await ctx.connect();


    // Only wireable once connected — needs the live rtc-node Room to listen
    // for data messages on.
    wireInboundReplies(ctx.room, session, callContext);

    // NOTE: a `session.on(AgentSessionEventTypes.Close, …)` listener was tried
    // here to shut the job down with its session (a closed session leaves the
    // process connected to the room as a participant that can no longer act on
    // `kortix` data messages). Adding it correlated with ConversationItemAdded
    // never firing again — the agent spoke, but nothing reached
    // voice_call_turns — which is the same failure mode this codebase has
    // already hit once from subscribing to AgentSessionEventTypes. Do not
    // re-add it without proving transcripts still land afterwards.
    //
    // The zombie it was meant to prevent is handled where it actually matters:
    // runtime.ts's `startCall` checks `roomHasAgent` before reusing a call, so
    // a room whose worker has gone is rebuilt and re-dispatched rather than
    // handed out as live.

    session.generateReply({
      instructions:
        'Greet the room in one short, natural sentence. Do not mention tools or being an AI.',
    });
  },
});

/**
 * `agentName` opts this worker OUT of LiveKit's automatic dispatch and into
 * EXPLICIT dispatch — the API names this worker when it starts a call (see
 * apps/api/src/channels/voice/livekit.ts `createRoom`). That trade is
 * deliberate. Automatic dispatch fires once, on room CREATION, and is
 * unobservable when it doesn't happen: `createRoom` no-ops on an existing
 * room, a room implicitly recreated by a rejoining participant gets no job,
 * and the only symptom is a registered worker that silently never receives
 * one. Explicit dispatch is a request with a response — it either returns a
 * dispatch id or throws, so a call that cannot get an agent fails loudly at
 * spawn time instead of handing the user a link to an empty room.
 *
 * This name is a contract with the API. Changing it on one side alone means
 * every dispatch targets a worker that does not exist.
 */
export const VOICE_AGENT_NAME = 'kortix-voice';

cli.runApp(
  new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: VOICE_AGENT_NAME }),
);
