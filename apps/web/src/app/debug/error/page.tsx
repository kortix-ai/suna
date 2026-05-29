'use client';

import { useState } from 'react';
import { SystemFaultView } from '@/components/common/system-fault';

type CrashMode = 'reference' | 'type' | 'custom' | 'long' | 'nostack';

const PRESETS: Array<{ key: CrashMode; label: string; make: () => Error }> = [
  {
    key: 'custom',
    label: "Cannot access 'y' before initialization",
    make: () => {
      const err = new Error("Cannot access 'y' before initialization");
      (err as Error & { digest?: string }).digest = 'debug-digest-0000';
      return err;
    },
  },
  {
    key: 'reference',
    label: 'ReferenceError (undeclared var)',
    make: () => new ReferenceError('y is not defined'),
  },
  {
    key: 'type',
    label: 'TypeError (undefined property)',
    make: () => new TypeError("Cannot read properties of undefined (reading 'bar')"),
  },
  {
    key: 'long',
    label: 'Very long message',
    make: () =>
      new Error(
        'A very long synthetic error message used to verify truncation and wrapping behavior in the global error boundary. '.repeat(
          6,
        ),
      ),
  },
  {
    key: 'nostack',
    label: 'Error with empty stack',
    make: () => {
      const err = new Error('Error with cleared stack');
      err.stack = '';
      return err;
    },
  },
];

function triggerRealCrash(mode: CrashMode): never {
  const preset = PRESETS.find((p) => p.key === mode) ?? PRESETS[0];
  throw preset.make();
}

export default function DebugErrorPage() {
  const [mode, setMode] = useState<CrashMode>('custom');
  const [crash, setCrash] = useState<CrashMode | null>(null);

  // Throw on render so the real `global-error` boundary catches it (prod-like).
  if (crash) {
    triggerRealCrash(crash);
  }

  const previewError = (PRESETS.find((p) => p.key === mode) ?? PRESETS[0]).make();

  return (
    <div style={{ position: 'relative', minHeight: '100dvh' }}>
      {/* Live preview of the System fault view — renders inline, no real crash,
          no Sentry capture, so it shows even under the Next dev overlay. */}
      <SystemFaultView key={mode} error={previewError} report={false} />

      {/* Floating control panel to switch variants / trigger the real boundary. */}
      <div
        style={{
          position: 'fixed',
          top: 12,
          left: 12,
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          maxWidth: 260,
          padding: 12,
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(20,20,20,0.92)',
          backdropFilter: 'blur(8px)',
          color: '#e5e5e5',
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
          fontSize: 12,
        }}
      >
        <div style={{ fontSize: 10, opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Preview variant
        </div>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setMode(p.key)}
            style={{
              padding: '7px 10px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.14)',
              background: mode === p.key ? 'rgba(255,255,255,0.92)' : 'transparent',
              color: mode === p.key ? '#111' : 'inherit',
              fontSize: 11,
              textAlign: 'left',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCrash(mode)}
          style={{
            marginTop: 4,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid rgba(255,80,80,0.4)',
            background: 'rgba(255,60,60,0.12)',
            color: '#ff8a8a',
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          ⚠ Throw for real (hit the boundary)
        </button>
        <div style={{ fontSize: 9.5, opacity: 0.4, lineHeight: 1.5, marginTop: 2 }}>
          In <code>next dev</code> the Next overlay appears first — dismiss it
          with <b>×</b> to see the real boundary underneath. In prod it shows directly.
        </div>
      </div>
    </div>
  );
}
