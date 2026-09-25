'use client';

import dynamic from 'next/dynamic';

/**
 * /debug/stream
 *
 * Replays an assistant message through the transcript's real markdown path —
 * `ThrottledMarkdown` → `UnifiedMarkdown` → Streamdown, inside the transcript
 * column — a few characters at a time. The states a reader sees only while a
 * turn streams are otherwise gone in a second: a link whose URL is still
 * arriving, a setup link held as a pending card, a list's last item, and the
 * moment the turn ends and the message settles.
 *
 * Deep-linkable for screenshots and browser checks:
 * `?scenario=setup-link&at=120&working=1` freezes one state. `at` is a
 * character count or `end`; `until=<text>` stops just after that text;
 * `working=0` renders the settled message. `32-streaming-setup-link.spec.ts`
 * drives it.
 *
 * Nothing here talks to a sandbox. A setup card's modal asks the local API
 * about a made-up token, so it opens on the invalid-link state.
 */
const DebugStreamHarness = dynamic(() => import('./harness').then((m) => m.DebugStreamHarness), {
  ssr: false,
});

export default function DebugStreamPage() {
  return <DebugStreamHarness />;
}
