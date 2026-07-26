import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { EASE, color, font } from './theme';

/** Fade + rise, the default entrance for everything in these films. */
function useRise(delay = 0, distance = 28) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 24 });
  return { opacity: s, transform: `translateY(${(1 - s) * distance}px)` };
}

/**
 * Title card — text types on against flat paper, the way the reference film
 * opens. Cursor blinks while typing, then clears.
 */
export function TitleCard({ text, subtitle }: { text: string; subtitle?: string }) {
  const frame = useCurrentFrame();
  const chars = Math.min(text.length, Math.max(0, Math.floor((frame - 8) / 1.6)));
  const typed = text.slice(0, chars);
  const done = chars >= text.length;
  const sub = useRise(text.length * 1.6 + 18);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: color.paper,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 120,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1
          style={{
            fontFamily: font.sans,
            fontWeight: 500,
            fontSize: 104,
            letterSpacing: '-0.035em',
            color: color.ink,
            margin: 0,
            lineHeight: 1.05,
          }}
        >
          {typed}
          {!done && (
            <span
              style={{
                display: 'inline-block',
                width: 6,
                height: '0.9em',
                marginLeft: 8,
                backgroundColor: color.ink,
                verticalAlign: 'text-bottom',
                opacity: Math.floor(frame / 8) % 2 === 0 ? 1 : 0,
              }}
            />
          )}
        </h1>
        {subtitle ? (
          <p
            style={{
              ...sub,
              fontFamily: font.sans,
              fontSize: 38,
              color: color.muted,
              marginTop: 28,
              letterSpacing: '-0.02em',
            }}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
    </AbsoluteFill>
  );
}

/** Full-bleed typographic transition slide, as used between product beats. */
export function StatementCard({ text }: { text: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const rise = useRise(4, 34);
  // Ease back out at the tail so the cut never feels abrupt.
  const out = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: color.paper,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 160,
      }}
    >
      <h2
        style={{
          ...rise,
          opacity: Number(rise.opacity) * out,
          fontFamily: font.sans,
          fontWeight: 500,
          fontSize: 88,
          lineHeight: 1.1,
          letterSpacing: '-0.035em',
          color: color.ink,
          textAlign: 'center',
          margin: 0,
          maxWidth: 1400,
        }}
      >
        {text}
      </h2>
    </AbsoluteFill>
  );
}

/**
 * Product beat — a real screenshot on the brand backdrop, drifting slowly with
 * a caption pinned bottom-left. The slow push is what makes a still read as
 * footage rather than a slideshow.
 */
export function ProductShot({
  shot,
  caption,
  align = 'center',
}: {
  shot: string;
  caption: string;
  align?: 'center' | 'left';
}) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const enter = useRise(0, 40);
  const scale = interpolate(frame, [0, durationInFrames], [1.04, 1.12]);
  const drift = interpolate(frame, [0, durationInFrames], [0, align === 'left' ? -60 : 0]);
  const cap = useRise(14, 22);

  return (
    <AbsoluteFill style={{ backgroundColor: color.ink, overflow: 'hidden' }}>
      {/* Full-bleed product UI with a slow push, so a still reads as footage. */}
      <AbsoluteFill style={{ ...enter, overflow: 'hidden' }}>
        <Img
          src={staticFile(`shots/${shot}`)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: align === 'left' ? 'left top' : 'center top',
            transform: `scale(${scale}) translateX(${drift}px)`,
          }}
        />
      </AbsoluteFill>

      {/* Scrim keeps the caption legible without covering the interface. */}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(to top, rgba(10,10,10,0.92) 0%, rgba(10,10,10,0.55) 18%, rgba(10,10,10,0) 42%)',
        }}
      />

      <div style={{ position: 'absolute', left: 96, right: 96, bottom: 84, ...cap }}>
        <p
          style={{
            fontFamily: font.sans,
            fontWeight: 500,
            fontSize: 52,
            letterSpacing: '-0.03em',
            color: color.paper,
            margin: 0,
            maxWidth: 1200,
          }}
        >
          {caption}
        </p>
      </div>
    </AbsoluteFill>
  );
}

/** Close-up of a prompt being submitted — the "you just ask" beat. */
export function PromptShot({ prompt }: { prompt: string }) {
  const frame = useCurrentFrame();
  const chars = Math.min(prompt.length, Math.max(0, Math.floor((frame - 6) / 1.1)));
  const typed = prompt.slice(0, chars);
  const done = chars >= prompt.length;
  const card = useRise(0, 30);
  // The send button pulses once the prompt is fully typed.
  const send = spring({
    frame: frame - (prompt.length * 1.1 + 8),
    fps: 30,
    config: { damping: 12 },
    durationInFrames: 20,
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: color.paper,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 140,
      }}
    >
      <div
        style={{
          ...card,
          width: 1180,
          backgroundColor: '#fff',
          border: `1px solid ${color.hairline}`,
          borderRadius: 22,
          padding: '42px 46px',
          boxShadow: '0 40px 90px rgba(0,0,0,0.10)',
        }}
      >
        <p
          style={{
            fontFamily: font.sans,
            fontSize: 46,
            lineHeight: 1.35,
            letterSpacing: '-0.02em',
            color: color.ink,
            margin: 0,
            minHeight: 130,
          }}
        >
          {typed}
          {!done && (
            <span
              style={{
                display: 'inline-block',
                width: 4,
                height: '0.9em',
                marginLeft: 6,
                backgroundColor: color.ink,
                verticalAlign: 'text-bottom',
                opacity: Math.floor(frame / 7) % 2 === 0 ? 1 : 0,
              }}
            />
          )}
        </p>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 34,
          }}
        >
          <span style={{ fontFamily: font.mono, fontSize: 26, color: color.muted }}>
            claude-opus-5
          </span>
          <span
            style={{
              width: 62,
              height: 62,
              borderRadius: 999,
              backgroundColor: color.ink,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transform: `scale(${done ? 1 + send * 0.06 : 1})`,
            }}
          >
            <svg width="26" height="26" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 13V3.5M8 3.5 3.75 7.75M8 3.5l4.25 4.25"
                stroke={color.paper}
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
}

/** Progress checklist ticking through — the "it did the work" beat. */
export function ProgressShot({ steps }: { steps: readonly string[] }) {
  const frame = useCurrentFrame();
  const card = useRise(0, 26);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: color.paper,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 140,
      }}
    >
      <div style={{ ...card, width: 1080 }}>
        {steps.map((step, i) => {
          const at = 14 + i * 18;
          const on = frame > at;
          const s = spring({ frame: frame - at, fps: 30, config: { damping: 200 }, durationInFrames: 16 });
          return (
            <div
              key={step}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 26,
                padding: '22px 0',
                borderBottom: `1px solid ${color.hairline}`,
                opacity: on ? 1 : 0.25,
              }}
            >
              <span
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 999,
                  backgroundColor: on ? color.green : 'transparent',
                  border: on ? 'none' : `2px solid ${color.hairline}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transform: `scale(${on ? 0.85 + s * 0.15 : 1})`,
                }}
              >
                {on ? (
                  <svg width="20" height="20" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                      d="M2.5 6.2l2.3 2.3 4.7-4.7"
                      stroke="#fff"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </span>
              <span
                style={{
                  fontFamily: font.sans,
                  fontSize: 38,
                  letterSpacing: '-0.02em',
                  color: on ? color.ink : color.muted,
                }}
              >
                {step}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

/** Closing mark — wordmark and one line, on paper. */
export function EndCard({ line, cta }: { line: string; cta: string }) {
  const a = useRise(2, 24);
  const b = useRise(14, 20);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: color.paper,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h2
          style={{
            ...a,
            fontFamily: font.sans,
            fontWeight: 500,
            fontSize: 92,
            letterSpacing: '-0.035em',
            color: color.ink,
            margin: 0,
          }}
        >
          {line}
        </h2>
        <p
          style={{
            ...b,
            fontFamily: font.mono,
            fontSize: 30,
            color: color.muted,
            marginTop: 34,
            letterSpacing: '0.02em',
          }}
        >
          {cta}
        </p>
      </div>
    </AbsoluteFill>
  );
}
