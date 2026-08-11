'use client';

/**
 * The voice room page.
 *
 * A human opens this link directly in their own browser — `voice_spawn` mints
 * the token and hands out the URL, nothing renders it on their behalf. It used
 * to be a raw WebSocket pipe that hand-rolled PCM framing, a ring buffer and
 * reconnect logic; all of that is gone now that the room itself is a LiveKit
 * room. This page's only job is to join it: publish the mic, play whatever the
 * agent publishes back, and render the call — live transcript, who's in the
 * room, who's talking, and real controls. Jitter buffering, packet-loss
 * concealment, Opus encode/decode and reconnects are LiveKit's problem now,
 * not ours.
 *
 * The STT/LLM/TTS pipeline lives server-side (the LiveKit agent worker); this
 * page only *subscribes* to what it publishes — the transcription stream and
 * the audio track — because this code runs in a browser with its token
 * visible in the URL. That token is a room-scoped LiveKit access token and
 * nothing else — it authorises joining one room as one participant, not
 * calling the dosco API.
 *
 * TWO SOURCES FEED THE TRANSCRIPT, and which one is authoritative matters:
 *
 *   - `kortix.voice_call_turns`, polled from
 *     `/v1/public/voice-join/:token/transcript`, IS the transcript. It holds
 *     every spoken turn on both sides, everything the KORTIX agent put into
 *     the call from outside it (`send_prompt`, a finished turn's result, an
 *     error), and every MCP tool call the voice made (`ask_kortix`,
 *     `run_command`).
 *   - LiveKit's client-side `TranscriptionReceived` is a LIVE TAIL on the end
 *     of it, nothing more.
 *
 * This page used to render only the second one, which is why it showed a call
 * with holes in it: that stream carries the two voices in this room and
 * nothing else, so the dosco agent's own lines and every tool call were
 * missing entirely — they are written server-side and never reach the
 * browser's LiveKit connection at all. The tail is still worth having, but
 * only for latency: it shows a sentence the instant it is spoken, and drops
 * out again as soon as the same words land in the durable record
 * (`unrecordedLive`), so nothing is ever shown twice or silently lost.
 *
 * The record endpoint is authorised by the join link itself — the same
 * capability, the same revocation-on-`endCall`, scoped server-side to the one
 * call the link was minted for. No logged-in user, and nothing project- or
 * session-wide is reachable from it.
 *
 * The URL's last path segment is now one of TWO shapes, and this page tells
 * them apart by prefix (`isJoinLinkToken`) before doing anything else:
 *   - `vjl_...` — a short, ungessable, server-resolved join-link token
 *     (join-links.ts). This page exchanges it for a freshly-minted LiveKit
 *     access token + server URL via `getPublicVoiceJoin` (the public,
 *     unauthenticated `GET /v1/public/voice-join/:token`) and never sees the
 *     `?url=` query param at all.
 *   - anything else — the LEGACY shape: the raw LiveKit access token itself,
 *     with the server URL riding in `?url=`. `voice_spawn` stopped minting
 *     these (a ~300-char JWT in a URL is fragile in transit — one corrupted
 *     character breaks the signature with no way to retry), but a link
 *     already handed out under the old scheme still has to open, so this
 *     path is kept rather than removed.
 *
 * Live-tested 2026-07-25 in a real Google Meet-adjacent call (this page open in
 * its own tab, no third-party meeting bot involved): no audible self-echo and
 * barge-in worked, with no explicit echoCancellation/noiseSuppression/
 * autoGainControl constraints set — see the plain `setMicrophoneEnabled(true)`
 * call below. If a browser/OS combination ever does produce audible self-echo,
 * this is where a half-duplex mute or explicit AEC constraints would go.
 *
 * Audio only — the agent never publishes a video track, so this page never
 * renders one either. Presence is shown as avatar tiles, not blank camera
 * rects standing in for a video call that isn't happening.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
  type TranscriptionSegment,
} from 'livekit-client';
import { getPublicVoiceJoin, getPublicVoiceTranscript, PublicVoiceJoinError } from '@kortix/sdk';

import { AudioGestureOverlay, ConnectingScreen, EndedScreen, ReconnectingBanner } from './_components/connection-states';
import { CallControls } from './_components/call-controls';
import { mergeCallRecord, toCallRecordEntries, unrecordedLive } from './_components/call-record';
import { PresenceRail } from './_components/presence-rail';
import { RoomHeader } from './_components/room-header';
import { TranscriptFeed } from './_components/transcript-feed';
import type { CallRecordEntry, ConnectionPhase, LiveUtterance, PresenceEntry } from './_components/types';

const JOIN_LINK_TOKEN_PREFIX = 'vjl_';

/**
 * How often to pull new lines of the durable call record.
 *
 * A poll, not a stream: the record is append-only with a monotonic cursor, so
 * an idle poll costs one indexed range scan that returns nothing, and a
 * dropped one self-heals on the next tick — neither of which is true of an SSE
 * connection this page would then have to reconnect by hand on every network
 * blip. Two seconds is under the latency of a spoken sentence, and the LIVE
 * tail (below) covers the gap in the meantime, so nothing here is what the
 * reader waits on.
 */
const RECORD_POLL_INTERVAL_MS = 2_000;

/** Whether a URL path segment is a short, server-resolved join-link token
 *  (`vjl_...`) rather than a legacy raw LiveKit access token embedded
 *  directly in the URL — see the file header. */
export function isJoinLinkToken(pathSegment: string): boolean {
  return pathSegment.startsWith(JOIN_LINK_TOKEN_PREFIX);
}

export default function VoiceBridgePage() {
  const [phase, setPhase] = useState<ConnectionPhase>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const [roster, setRoster] = useState<PresenceEntry[]>([]);
  /** The durable call record — the transcript. */
  const [record, setRecord] = useState<CallRecordEntry[]>([]);
  /** LiveKit's client-side transcription, which is only a tail on the end of
   *  the record (see the file header). */
  const [live, setLive] = useState<LiveUtterance[]>([]);

  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  const roomRef = useRef<Room | null>(null);
  const liveMapRef = useRef<Map<string, LiveUtterance>>(new Map());

  useEffect(() => {
    const pathToken = window.location.pathname.split('/').filter(Boolean).pop() ?? '';
    // LEGACY shape only: the server URL riding in `?url=` (or the build-time
    // fallback), for a raw-JWT link `voice_spawn` already handed out before it
    // switched to short join-link tokens. A `vjl_...` token ignores this
    // entirely — `getPublicVoiceJoin` below returns the server URL instead,
    // since a query param on a short link would be one more thing to keep in
    // sync with whichever LiveKit deployment actually issued the token.
    const legacyLivekitUrl = (
      new URLSearchParams(window.location.search).get('url') ||
      process.env.NEXT_PUBLIC_LIVEKIT_URL ||
      ''
    ).trim();

    let cancelled = false;
    let unblockListener: (() => void) | null = null;
    const room = new Room();
    roomRef.current = room;
    // Elements handed back by `track.attach()` are plain DOM nodes LiveKit does
    // not track for us — we own removing them on unmount/unsubscribe.
    const attachedEls: HTMLMediaElement[] = [];

    const syncRoster = () => {
      if (cancelled || room.state !== ConnectionState.Connected) return;
      const local = room.localParticipant;
      const list: PresenceEntry[] = [
        {
          identity: local.identity,
          name: 'You',
          isLocal: true,
          isAgent: false,
          micEnabled: local.isMicrophoneEnabled,
          speaking: local.isSpeaking,
        },
        ...Array.from(room.remoteParticipants.values()).map((p) => ({
          identity: p.identity,
          name: p.isAgent ? p.name || 'dosco' : p.name || p.identity,
          isLocal: false,
          isAgent: p.isAgent,
          micEnabled: p.isMicrophoneEnabled,
          speaking: p.isSpeaking,
        })),
      ];
      setRoster(list);
      setMicEnabled(local.isMicrophoneEnabled);
    };

    const upsertLive = (
      segments: TranscriptionSegment[],
      participant: Participant | undefined,
    ) => {
      if (cancelled) return;
      const isLocal = participant ? participant.identity === room.localParticipant.identity : false;
      const isAgent = participant?.isAgent ?? false;
      const name = isLocal ? 'You' : isAgent ? participant?.name || 'dosco' : participant?.name || participant?.identity || 'Guest';
      for (const segment of segments) {
        // Keyed by segment id, which is stable across the interim revisions of
        // one utterance — so a sentence being revised updates in place instead
        // of stuttering down the feed.
        liveMapRef.current.set(segment.id, {
          id: segment.id,
          name,
          isLocal,
          text: segment.text,
          final: segment.final,
          firstReceivedTime: segment.firstReceivedTime,
        });
      }
      setLive(
        Array.from(liveMapRef.current.values()).sort(
          (a, b) => a.firstReceivedTime - b.firstReceivedTime,
        ),
      );
    };

    async function join(): Promise<void> {
      if (!pathToken) {
        throw new Error('missing LiveKit room token or server URL');
      }

      // Short join-link token → resolve it server-side for a fresh LiveKit
      // access token + the server URL that issued it. Anything else is a
      // legacy link: the path segment IS already the LiveKit access token,
      // and the server URL came from the `?url=` query param above.
      let liveKitToken = pathToken;
      let liveKitUrl = legacyLivekitUrl;
      if (isJoinLinkToken(pathToken)) {
        const resolved = await getPublicVoiceJoin(pathToken);
        if (cancelled) return;
        liveKitToken = resolved.token;
        liveKitUrl = resolved.url;
      }

      if (!liveKitToken || !liveKitUrl) {
        throw new Error('missing LiveKit room token or server URL');
      }

      room
        .on(RoomEvent.Connected, () => {
          if (cancelled) return;
          setPhase('connected');
          syncRoster();
        })
        .on(RoomEvent.Reconnecting, () => {
          if (!cancelled) setPhase('reconnecting');
        })
        .on(RoomEvent.Reconnected, () => {
          if (cancelled) return;
          setPhase('connected');
          syncRoster();
        })
        .on(RoomEvent.Disconnected, (reason) => {
          if (cancelled) return;
          if (reason === DisconnectReason.CLIENT_INITIATED) {
            setPhase('left');
          } else {
            setPhase('failed');
            setError('lost connection to dosco');
          }
        })
        .on(RoomEvent.ParticipantConnected, syncRoster)
        .on(RoomEvent.ParticipantDisconnected, syncRoster)
        .on(RoomEvent.ParticipantNameChanged, syncRoster)
        .on(RoomEvent.TrackMuted, syncRoster)
        .on(RoomEvent.TrackUnmuted, syncRoster)
        // LiveKit already computes per-participant speech activity for us on
        // every audio-level tick — no hand-rolled peak meter over raw samples
        // needed, unlike the old bridge's capture worklet. `isSpeaking` on
        // each Participant is kept in lockstep with this event, so a single
        // roster resync picks up who's talking right now.
        .on(RoomEvent.ActiveSpeakersChanged, syncRoster)
        // The LIVE tail, and only the tail. Both voices arrive here as the
        // LiveKit Agents SDK publishes them, attributed to whichever
        // participant produced them — but this stream carries the two VOICES
        // and nothing else, which is exactly why it cannot be the transcript
        // (see the file header). It is here for latency: a sentence shows up
        // the moment it is spoken, and drops out again as soon as the durable
        // record catches up with it (`unrecordedLive`).
        .on(RoomEvent.TranscriptionReceived, upsertLive)
        // Output Media just needs a real <audio>/<video> element playing in the
        // DOM to produce sound. `track.attach()` gives us that element with
        // LiveKit's jitter buffer, PLC and Opus decode already wired behind it —
        // there is nothing left here for us to buffer or schedule by hand.
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
          if (track.kind !== Track.Kind.Audio) return;
          const el = track.attach();
          el.style.display = 'none';
          audioContainerRef.current?.appendChild(el);
          attachedEls.push(el);
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          for (const el of track.detach()) el.remove();
        });

      room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
        // Browsers refuse programmatic audio until a user gesture. Without this
        // the agent speaks, LiveKit delivers it, and the page plays NOTHING —
        // which looks exactly like a dead agent. Surface it instead of hiding it.
        if (!cancelled) setNeedsGesture(!room.canPlaybackAudio);
      });

      await room.connect(liveKitUrl, liveKitToken);

      // Succeeds outright in some browsers; most need the click handler below
      // (autoplay policies block programmatic audio until a user gesture).
      try {
        await room.startAudio();
      } catch {
        if (!cancelled) setNeedsGesture(true);
      }
      const unblock = () => {
        void room.startAudio().then(() => !cancelled && setNeedsGesture(false)).catch(() => {});
      };
      window.addEventListener('click', unblock);
      window.addEventListener('keydown', unblock);
      unblockListener = unblock;
      // No echoCancellation/noiseSuppression/autoGainControl flags to fight with
      // here — LiveKit's default capture settings are what its own client-side
      // processing expects, and live-testing (see file header) found no audible
      // self-echo to cancel in the first place.
      await room.localParticipant.setMicrophoneEnabled(true);
      syncRoster();
    }

    join().catch((e) => {
      if (cancelled) return;
      setPhase('failed');
      setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      cancelled = true;
      if (unblockListener) {
        window.removeEventListener('click', unblockListener);
        window.removeEventListener('keydown', unblockListener);
      }
      for (const el of attachedEls) el.remove();
      void room.disconnect();
      roomRef.current = null;
    };
  }, []);

  // ── The durable call record ──────────────────────────────────────────────
  //
  // Runs independently of the LiveKit connection above, on purpose: this is
  // the transcript, and it must keep filling in even while the room is
  // reconnecting or the browser is still refusing to play audio.
  //
  // Authorized by the join-link token in the URL and nothing else — the same
  // capability that got this page its LiveKit token, scoped by the server to
  // the one call that token was minted for (there is no call/session/project
  // id in this request for anyone to swap). A legacy raw-JWT link has no such
  // token, so it gets no durable record and falls back to the LiveKit stream
  // alone; that is the old, lossy behaviour, kept working rather than broken.
  useEffect(() => {
    const pathToken = window.location.pathname.split('/').filter(Boolean).pop() ?? '';
    if (!isJoinLinkToken(pathToken)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cursor = 0;

    const poll = async () => {
      try {
        const page = await getPublicVoiceTranscript(pathToken, cursor);
        if (cancelled) return;
        cursor = page.cursor;
        if (page.turns.length > 0) {
          const incoming = toCallRecordEntries(page.turns);
          setRecord((prev) => mergeCallRecord(prev, incoming));
        }
      } catch (err) {
        // 404/410 is the link itself being gone — unknown, expired, or revoked
        // because the call ended. Retrying cannot fix any of those, and the
        // page keeps whatever it already read, so stop rather than hammer a
        // dead link every two seconds for as long as the tab stays open.
        if (err instanceof PublicVoiceJoinError && (err.status === 404 || err.status === 410)) {
          return;
        }
        // Anything else is silent and deliberately still scheduled below. A
        // failed poll is a gap in the record, not a broken call — the human is
        // still talking to the agent, and the next tick re-reads from the same
        // cursor and fills the gap in. Tearing the page down over it, or
        // giving up on the record for the rest of the call, would both be
        // worse than a two-second delay.
      }
      if (!cancelled) timer = setTimeout(poll, RECORD_POLL_INTERVAL_MS);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const toggleMic = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    void room.localParticipant
      .setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled)
      .then(() => setMicEnabled(room.localParticipant.isMicrophoneEnabled))
      .catch(() => {});
  }, []);

  const leave = useCallback(() => {
    void roomRef.current?.disconnect();
  }, []);

  if (phase === 'connecting') return <ConnectingScreen />;
  if (phase === 'failed' || phase === 'left') {
    return <EndedScreen reason={phase} message={error} />;
  }

  return (
    <div className="bg-background flex h-dvh min-h-screen flex-col">
      <RoomHeader phase={phase} />
      {/* Remote audio plays through elements parked here — invisible, audio-only. */}
      <div ref={audioContainerRef} style={{ display: 'none' }} />
      <div className="mx-auto flex w-full min-h-0 max-w-2xl flex-1 flex-col gap-4 overflow-hidden px-4 py-4 sm:py-6">
        {phase === 'reconnecting' && <ReconnectingBanner />}
        <PresenceRail roster={roster} />
        <TranscriptFeed
          entries={record}
          live={unrecordedLive(live, record)}
          className="min-h-0 flex-1"
        />
      </div>
      <CallControls micEnabled={micEnabled} onToggleMic={toggleMic} onLeave={leave} />
      {needsGesture && <AudioGestureOverlay />}
    </div>
  );
}
