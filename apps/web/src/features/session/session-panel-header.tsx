'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SidebarToggle as PanelRight } from '@/features/icon/icons/sidebar-toggle';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { SessionPanelView } from '@/stores/session-browser-store';

/** The Advanced-mode side panel's header: the view tab strip, the "Back to
 *  Easy" button, and the detail-panel toggle. Moved verbatim out of
 *  `session-layout.tsx` (KRTX-459). */
export function PanelHeaderSwitcher({
  view,
  onChangeView,
  isSidePanelOpen,
  onTogglePanel,
  auditBadge = 0,
  onToggleMode,
}: {
  view: SessionPanelView;
  onChangeView: (next: SessionPanelView) => void;
  isSidePanelOpen: boolean;
  onTogglePanel: () => void;
  /** Pending-approval count shown on the "Audit" tab; 0 hides the badge. */
  auditBadge?: number;
  /** Flips `preferences.panelMode` back to 'easy'. Advanced-only — Easy mode
   *  renders no header at all, so it has no button to switch with. */
  onToggleMode: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <div className="flex shrink-0 items-center justify-between border-b p-2">
      <Tabs
        value={view}
        onValueChange={(next) => onChangeView(next as SessionPanelView)}
        className="gap-0 p-0"
      >
        <TabsList
          animate="none"
          size="sm"
          className="h-7"
          aria-label={tHardcodedUi.raw(
            'componentsSessionSessionLayout.line348JsxAttrAriaLabelSidePanelView',
          )}
        >
          <TabsTrigger size="xs" value="actions" className="w-fit">
            {tHardcodedUi.raw('i18nComplete.textff8059dc6752')}
          </TabsTrigger>
          <TabsTrigger size="xs" value="browser" className="w-fit">
            {tHardcodedUi.raw('i18nComplete.textd31de1a5c5c8')}
          </TabsTrigger>
          <TabsTrigger size="xs" value="explorer" className="hit-area-2 w-fit">
            {tHardcodedUi.raw('i18nComplete.textabc7e9892806')}
          </TabsTrigger>
          <TabsTrigger size="xs" value="terminal" className="hit-area-2 w-fit">
            {tHardcodedUi.raw('i18nComplete.texte0926fdac700')}
          </TabsTrigger>
          <TabsTrigger size="xs" value="audit" className="hit-area-2 w-fit gap-1.5">
            {tHardcodedUi.raw('i18nComplete.textbb6aea287396')}
            {auditBadge > 0 ? (
              <Badge variant="secondary" size="xs" className="tabular-nums">
                {auditBadge}
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleMode}
          className="text-muted-foreground hover:text-foreground hit-area-2 h-7 cursor-pointer text-xs"
        >
          {tHardcodedUi.raw('i18nComplete.textd6915875decb')}
        </Button>
        <PanelToggleHint isSidePanelOpen={isSidePanelOpen} onTogglePanel={onTogglePanel} />
      </div>
    </div>
  );
}

function PanelToggleHint({
  isSidePanelOpen,
  onTogglePanel,
}: {
  isSidePanelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <Hint
      side="bottom"
      sideOffset={4}
      delayDuration={300}
      // No ⌘I hint here: that shortcut toggles the right side as a whole, and
      // this Advanced-mode button is a narrower thing — the detail panel only.
      label={
        <span className="flex items-center gap-1.5">
          {isSidePanelOpen ? 'Close' : 'Open'} {tHardcodedUi.raw('i18nComplete.text320e00e73a7d')}
        </span>
      }
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={onTogglePanel}
        className={cn(
          'h-7 cursor-pointer transition-colors',
          isSidePanelOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <PanelRight className="h-4 w-4" mirrored />
      </Button>
    </Hint>
  );
}
