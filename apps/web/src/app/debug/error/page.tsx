'use client';

import { useState } from 'react';

type CrashMode = 'reference' | 'type' | 'custom' | 'long' | 'nostack';

function triggerCrash(mode: CrashMode): never {
  switch (mode) {
    case 'reference': {
      // @ts-expect-error — intentional ReferenceError
      return y + 1;
    }
    case 'type': {
      const obj: { foo?: { bar: string } } = {};
      // @ts-expect-error — intentional TypeError
      return obj.foo.bar;
    }
    case 'long': {
      throw new Error(
        'A very long synthetic error message used to verify truncation and wrapping behavior in the global error boundary. '.repeat(
          6,
        ),
      );
    }
    case 'nostack': {
      const err = new Error('Error with cleared stack');
      err.stack = '';
      throw err;
    }
    case 'custom':
    default: {
      const err = new Error("Cannot access 'y' before initialization");
      (err as Error & { digest?: string }).digest = 'debug-digest-0000';
      throw err;
    }
  }
}

export default function DebugErrorPage() {
  const [mode, setMode] = useState<CrashMode | null>(null);

  if (mode) {
    triggerCrash(mode);
  }

  const buttons: Array<{ key: CrashMode; label: string }> = [
    { key: 'custom', label: "Throw: Cannot access 'y' before initialization" },
    { key: 'reference', label: 'Throw: ReferenceError (undeclared var)' },
    { key: 'type', label: 'Throw: TypeError (undefined property)' },
    { key: 'long', label: 'Throw: very long message' },
    { key: 'nostack', label: 'Throw: Error with empty stack' },
  ];

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
      }}
    >
      <div style={{ maxWidth: 520, width: '100%' }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Global error boundary preview</h1>
        <p style={{ fontSize: 13, opacity: 0.7, lineHeight: 1.6, marginTop: 0 }}>
          Click a button to trigger a render-time crash. In production this renders
          <code> app/global-error.tsx</code>. In <code>next dev</code> the Next.js dev overlay
          appears first — dismiss it (Esc / the <b>×</b>) to see the real boundary underneath.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
          {buttons.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setMode(b.key)}
              style={{
                padding: '10px 14px',
                borderRadius: 10,
                border: '1px solid rgba(127,127,127,0.3)',
                background: 'transparent',
                color: 'inherit',
                fontSize: 13,
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
