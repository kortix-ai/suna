'use client';

import * as React from 'react';
import type { PowerPointViewerHandle } from 'pptx-react-viewer';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  Download01Icon,
  Gif01Icon,
  Image01Icon,
  Pdf01Icon,
  PlayIcon,
  Presentation01Icon,
  PrinterIcon,
  Video01Icon,
} from '@hugeicons/core-free-icons';

import { cn } from '@/lib/utils';
import { resolvePptxFileName } from './pptx-export-utils';
import { Button } from '@/components/ui/extend/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/extend/dropdown-menu';

/**
 * A read-only viewer can't reach the library's PDF/PNG/video/GIF/print exporters
 * through the public ref (it only exposes `getContent()` → .pptx bytes). Those
 * live behind the library's own "More actions" menu, so for everything except
 * .pptx we drive that menu programmatically: open it, click the matching action
 * (identified by its i18n-stable aria-label), done. `.pptx` uses `getContent()`
 * directly, which is fully supported and needs no menu.
 */
type ExportFormat = {
  key: string;
  label: string;
  icon: typeof PlayIcon;
  /** aria-label of the library's "More actions" item, or undefined for native .pptx. */
  action?: string;
};

const EXPORT_FORMATS: ExportFormat[] = [
  { key: 'pptx', label: 'PowerPoint (.pptx)', icon: Presentation01Icon },
  { key: 'pdf', label: 'PDF document', icon: Pdf01Icon, action: 'Export as PDF' },
  { key: 'png', label: 'Image (PNG)', icon: Image01Icon, action: 'Export as PNG' },
  { key: 'gif', label: 'Animated GIF', icon: Gif01Icon, action: 'Export as GIF' },
  { key: 'video', label: 'Video (MP4)', icon: Video01Icon, action: 'Export as Video' },
  { key: 'print', label: 'Print…', icon: PrinterIcon, action: 'Print' },
];

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function waitForElement(
  get: () => HTMLElement | null,
  timeoutMs: number,
): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      const el = get();
      if (el) return resolve(el);
      if (performance.now() - start > timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/**
 * Fully activate an element the way a real pointer would. The library's menus
 * open on `pointerdown`, so a bare `element.click()` (which only dispatches a
 * `click`) never opens them — we replay the whole pointer/mouse sequence.
 */
function pointerActivate(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const shared = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...shared, pointerId: 1, pointerType: 'mouse', buttons: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...shared, buttons: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup', { ...shared, pointerId: 1, pointerType: 'mouse', buttons: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { ...shared, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('click', { ...shared, buttons: 0 }));
}

/** Find a freshly-rendered menu button by its (trimmed) visible text. */
function findMenuItemByText(text: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('button, [role="menuitem"]');
  for (const el of candidates) {
    if ((el.textContent ?? '').trim() === text) return el;
  }
  return null;
}

/**
 * Trigger one of the library's "More actions" menu items by its visible label.
 * The items are plain buttons keyed on their text (no aria-label), and the menu
 * opens on pointer events — hence `pointerActivate` above.
 */
async function runViewerAction(root: HTMLElement, actionLabel: string): Promise<void> {
  const more = root.querySelector<HTMLElement>('[aria-label="More actions"]');
  if (!more) throw new Error('viewer actions menu is unavailable');
  pointerActivate(more);
  const item = await waitForElement(() => findMenuItemByText(actionLabel), 3000);
  if (!item) {
    throw new Error(`export action "${actionLabel}" was not found`);
  }
  pointerActivate(item);
}

async function downloadPptx(
  viewer: PowerPointViewerHandle | null,
  fileName: string,
): Promise<void> {
  if (!viewer) throw new Error('viewer is not ready');
  const bytes = await viewer.getContent();
  const name = resolvePptxFileName(fileName);
  // Copy into a fresh ArrayBuffer-backed view so it's a valid BlobPart.
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: PPTX_MIME }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface PptxViewerToolbarProps {
  fileName: string;
  viewerRef: React.RefObject<PowerPointViewerHandle | null>;
  /** The renderer shell, used to reach the library viewer root for exports. */
  shellRef: React.RefObject<HTMLDivElement | null>;
  className?: string;
}

export function PptxViewerToolbar({
  fileName,
  viewerRef,
  shellRef,
  className,
}: PptxViewerToolbarProps) {
  const [pending, setPending] = React.useState<string | null>(null);

  const handlePresent = React.useCallback(() => {
    viewerRef.current?.setMode('present');
  }, [viewerRef]);

  const handleExport = React.useCallback(
    async (format: ExportFormat) => {
      setPending(format.key);
      try {
        if (!format.action) {
          await downloadPptx(viewerRef.current, fileName);
        } else {
          const root = shellRef.current?.querySelector<HTMLElement>('[data-pptx-viewer]');
          if (!root) throw new Error('viewer is not ready');
          await runViewerAction(root, format.action);
        }
      } catch (err) {
        console.error('[PptxRenderer] export failed:', err);
      } finally {
        setPending(null);
      }
    },
    [fileName, shellRef, viewerRef],
  );

  return (
    <div
      className={cn(
        'flex h-11 shrink-0 items-center justify-between gap-2 border-b bg-background px-3',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{fileName}</span>
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          Read-only
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={handlePresent}>
          <HugeiconsIcon icon={PlayIcon} />
          Present
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={pending !== null}>
              <HugeiconsIcon icon={Download01Icon} />
              Download
              <HugeiconsIcon icon={ArrowDown01Icon} className="opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Export as</DropdownMenuLabel>
              {EXPORT_FORMATS.map((format) => (
                <DropdownMenuItem
                  key={format.key}
                  onClick={() => handleExport(format)}
                  disabled={pending !== null}
                >
                  <HugeiconsIcon icon={format.icon} />
                  {format.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
