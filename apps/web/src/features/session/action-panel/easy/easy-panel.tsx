'use client';

/**
 * `EasyPanel` — the non-technical home for a session: the promise cards
 * (Outputs / Context / Preview) over the same tool-call data the Advanced
 * stepper renders one-at-a-time.
 *
 * It is the FLOATING panel's whole content. It renders over the chat, anchored
 * top right, and it is nothing but the cards — no header, no tab strip, no
 * border, no wrapper of any kind. The cards carry their own borders, so a
 * container around them would only box a box.
 *
 * It owns almost no state — everything it reads (the derived outputs, the
 * context groups, the running apps, the callback that opens any of them)
 * comes from `SessionPanelProvider`, which sits above both this and the
 * detail panel because a row clicked HERE opens a detail THERE. Before the
 * split those were one component in one panel; see the provider's header for
 * why they no longer can be. The one exception is `connectAppsOpen` below —
 * purely local UI toggle state, nothing the provider or any other surface
 * needs to read.
 *
 * The cards expand in place and never navigate away from each other. Opening
 * something is not navigation either — it fills the detail panel on the other
 * side of the screen, and these cards stay exactly as they were.
 *
 * `connectAppsOpen` (Task 5) is the one piece of state this component DOES
 * own: whether the empty Context card's "Connect apps" toggle has
 * `ConnectAppsStrip` open. It lives here rather than as local `useState`
 * inside `ContextCard` so that card stays hook-free — see its own header
 * comment for why that matters to its tests.
 */

import { useState } from 'react';
import { useSessionComposerPrefillStore } from '@/stores/session-composer-prefill-store';
import { useOptionalSessionPanel } from '../session-panel-provider';
import { AppsCard } from './apps-card';
import { ContextCard } from './context-card';
import { pathOutput } from './easy-panel-logic';
import { OutputsCard } from './outputs-card';

export function EasyPanel() {
  const panel = useOptionalSessionPanel();
  const [connectAppsOpen, setConnectAppsOpen] = useState(false);
  // Null outside a `SessionPanelProvider` — `SessionChat` also renders
  // read-only inside `sub-session-modal.tsx`, which has no panel at all.
  if (!panel) return null;

  const {
    files,
    context,
    apps,
    outputsDefaultOpen,
    sessionId,
    projectId,
    handleOpenOutput,
    openDetail,
  } = panel;

  return (
    // A fill-and-scroll column, not a scrolling stack.
    //
    // The stack used to scroll as one: Outputs, Context and Preview sat at
    // their natural heights and the column scrolled past all three. Expanding
    // Outputs to two hundred files therefore pushed Context and Preview
    // entirely below the fold — present, but unreachable without scrolling
    // through everything above them.
    //
    // Now the column owns the height (`h-full`) and hands the leftover to
    // exactly one card. Outputs is the one that yields (`fill`); Context and
    // Preview keep `shrink-0` and stay on screen at their full height, always.
    // `min-h-0` is what lets this shrink at all — a flex container defaults to
    // its content's minimum height and would otherwise refuse.
    <div className="flex h-full min-h-0 flex-col gap-3">
      <OutputsCard
        outputs={files}
        defaultExpanded={outputsDefaultOpen}
        onOpenOutput={(o) => handleOpenOutput(o, files)}
      />
      <ContextCard
        files={context.files}
        web={context.web}
        tools={context.tools}
        sessionId={sessionId}
        onOpenDetail={openDetail}
        onOpenFile={(path, allPaths) =>
          handleOpenOutput(pathOutput(path), allPaths.map(pathOutput))
        }
        onAddContext={() => useSessionComposerPrefillStore.getState().requestAttach(sessionId)}
        projectId={projectId}
        connectAppsOpen={connectAppsOpen}
        onToggleConnectApps={() => setConnectAppsOpen((open) => !open)}
      />
      {apps.length > 0 && <AppsCard apps={apps} onOpenApp={(a) => handleOpenOutput(a, apps)} />}
    </div>
  );
}
