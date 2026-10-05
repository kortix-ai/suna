'use client';

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalContentInner,
  ModalDescription,
  ModalHeader,
  ModalOverlay,
  ModalPortal,
  ModalTitle,
  ModalTrigger,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { dialogContentZ, dialogOverlayZ, useDialogDepth } from '@/lib/z-stack';

/**
 * /debug/modal-stack
 *
 * Opening a modal while another is open must put the new overlay ABOVE the open
 * card. Depth used to come only from React context, so a modal that is not
 * nested in the open one's JSX (a global host, a store-driven modal) resolved
 * depth 1 and its overlay rendered under the card it should dim.
 * `lib/z-stack.tsx` now stacks by open order.
 *
 * Every scenario below opens several layers. The inspector (bottom right) reads
 * the computed z-index of each open dialog and its overlay from the DOM and
 * reports a conflict when a layer does not sit above the one opened before it.
 * "Pre-fix stacking" pins the demo modal cards to their old tree-depth
 * z-index, so the bug can be reproduced on the same page.
 *
 * Not linked from anywhere; just hit /debug/modal-stack.
 */

const LegacyStackingContext = createContext(false);

// Wider card at the bottom of a stack, so each lower card stays visible.
const WIDTH_BY_LEVEL = ['lg:max-w-xl', 'lg:max-w-md', 'lg:max-w-sm'];

function DepthReadout({ legacyDepth }: { legacyDepth: number | null }) {
  const stackDepth = useDialogDepth();
  const depth = legacyDepth ?? stackDepth;
  return (
    <p className="text-muted-foreground text-xs tabular-nums">
      {legacyDepth === null ? 'Layer' : 'Pre-fix layer'} {depth} · overlay z {dialogOverlayZ(depth)}{' '}
      · card z {dialogContentZ(depth)}
    </p>
  );
}

function DemoModalContent({
  title,
  description,
  treeDepth,
  widthLevel,
  children,
}: {
  title: string;
  description: string;
  /** Depth the pre-fix code derived from JSX nesting alone. */
  treeDepth: number;
  widthLevel: number;
  children?: ReactNode;
}) {
  const legacy = useContext(LegacyStackingContext);
  const width = WIDTH_BY_LEVEL[Math.min(widthLevel, WIDTH_BY_LEVEL.length - 1)];
  const inner = (
    <>
      <ModalHeader>
        <ModalTitle>{title}</ModalTitle>
        <ModalDescription>{description}</ModalDescription>
      </ModalHeader>
      <ModalBody className="space-y-4">
        <DepthReadout legacyDepth={legacy ? treeDepth : null} />
        {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
      </ModalBody>
    </>
  );

  if (!legacy) return <ModalContent className={width}>{inner}</ModalContent>;

  return (
    <ModalPortal>
      <ModalOverlay style={{ zIndex: dialogOverlayZ(treeDepth) }} />
      <ModalContentInner className={width} style={{ zIndex: dialogContentZ(treeDepth) }}>
        {inner}
      </ModalContentInner>
    </ModalPortal>
  );
}

// ─── Layer inspector ────────────────────────────────────────────────────────

type InspectedLayer = { title: string; overlayZ: number | null; contentZ: number };

function subscribeToBody(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-state', 'style'],
  });
  return () => observer.disconnect();
}

/** Serialized so an unchanged DOM yields an identical snapshot. */
function readOpenLayers(): string {
  const layers: InspectedLayer[] = [];
  // Document order is open order: each Radix portal appends to `body`.
  const dialogs = document.querySelectorAll<HTMLElement>(
    '[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"],[role="dialog"][aria-modal="true"]',
  );
  for (const dialog of dialogs) {
    // Popovers also carry role="dialog" but live inside a popper wrapper.
    if (dialog.parentElement !== document.body) continue;
    const titleId = dialog.getAttribute('aria-labelledby');
    const title =
      (titleId ? document.getElementById(titleId)?.textContent : null) ||
      dialog.getAttribute('aria-label') ||
      'Untitled layer';
    const previous = dialog.previousElementSibling;
    const overlay =
      previous instanceof HTMLElement &&
      !previous.hasAttribute('role') &&
      getComputedStyle(previous).position === 'fixed'
        ? previous
        : null;
    layers.push({
      title,
      overlayZ: overlay ? Number(getComputedStyle(overlay).zIndex) : null,
      contentZ: Number(getComputedStyle(dialog).zIndex),
    });
  }
  return JSON.stringify(layers);
}

const serverLayers = () => null;

// Above every product layer, including toasts.
const INSPECTOR_Z = 2147483000;

function LayerInspector() {
  const snapshot = useSyncExternalStore(subscribeToBody, readOpenLayers, serverLayers);
  if (snapshot === null) return null;

  const layers = JSON.parse(snapshot) as InspectedLayer[];
  const results = layers.map((layer, index) => {
    const below = layers[index - 1];
    if (!below) return true;
    const overlayAbove = layer.overlayZ === null || layer.overlayZ > below.contentZ;
    return overlayAbove && layer.contentZ > below.contentZ;
  });
  const conflict = results.includes(false);

  return createPortal(
    <div
      aria-hidden
      data-testid="modal-stack-inspector"
      className="bg-popover pointer-events-none fixed right-4 bottom-4 w-72 space-y-2 rounded-md border px-4 py-3 shadow-xl"
      style={{ zIndex: INSPECTOR_Z }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Layer inspector</span>
        {layers.length > 1 ? (
          <Badge variant={conflict ? 'destructive' : 'success'} size="sm">
            {conflict ? 'Conflict' : 'Stacked'}
          </Badge>
        ) : null}
      </div>
      {layers.length === 0 ? (
        <p className="text-muted-foreground text-xs">No layer open.</p>
      ) : (
        <ol className="space-y-1.5">
          {layers.map((layer, index) => (
            <li key={`${layer.title}-${index}`} className="flex items-center gap-2 text-xs">
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  results[index] ? 'bg-kortix-green' : 'bg-kortix-red',
                )}
              />
              <span className="min-w-0 flex-1 truncate">{layer.title}</span>
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {layer.overlayZ ?? '—'} / {layer.contentZ}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="text-muted-foreground text-xs">Opened first at the top · overlay z / card z</p>
    </div>,
    document.body,
  );
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

const SIBLING_NAMES = ['Modal 1', 'Modal 2', 'Modal 3'];

/** The reported bug: modals that share no React ancestor. */
function SiblingScenario() {
  const [open, setOpen] = useState([false, false, false]);
  const setOne = (index: number, next: boolean) =>
    setOpen((current) => current.map((value, i) => (i === index ? next : value)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sibling modals</CardTitle>
        <CardDescription>
          Three modals mounted side by side at the page root, like a global host or a store-driven
          modal. Open one from another, close the one below, reopen it: the most recently opened
          modal must always be on top with its overlay dimming the rest.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setOne(0, true)}>
          Open modal 1
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen([true, true, true])}>
          Open all three at once
        </Button>
      </CardContent>

      {SIBLING_NAMES.map((name, index) => (
        <Modal key={name} open={open[index]} onOpenChange={(next) => setOne(index, next)}>
          <DemoModalContent
            title={name}
            description="A sibling of the other two. None is rendered inside another's JSX."
            treeDepth={1}
            widthLevel={index}
          >
            {SIBLING_NAMES.map((otherName, otherIndex) =>
              otherIndex === index ? null : (
                <Button
                  key={otherName}
                  size="sm"
                  variant={open[otherIndex] ? 'outline' : 'secondary'}
                  onClick={() => setOne(otherIndex, !open[otherIndex])}
                >
                  {open[otherIndex]
                    ? `Close ${otherName.toLowerCase()}`
                    : `Open ${otherName.toLowerCase()}`}
                </Button>
              ),
            )}
            {index === 2 ? (
              <Select defaultValue="eu">
                <SelectTrigger className="w-40" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="eu">Europe</SelectItem>
                  <SelectItem value="us">United States</SelectItem>
                  <SelectItem value="ap">Asia Pacific</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
          </DemoModalContent>
        </Modal>
      ))}
    </Card>
  );
}

/** Modals nested in each other's JSX — the case context depth always handled. */
function NestedScenario() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nested modals</CardTitle>
        <CardDescription>
          Each modal is rendered inside the previous one. The third is uncontrolled. Opening the
          outer and middle modal in the same click registers the child before its parent; the child
          must still land on top.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setOuter(true)}>
          Open outer modal
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setOuter(true);
            setInner(true);
          }}
        >
          Open outer and middle together
        </Button>
      </CardContent>

      <Modal open={outer} onOpenChange={setOuter}>
        <DemoModalContent
          title="Outer modal"
          description="Contains the middle modal in its JSX."
          treeDepth={1}
          widthLevel={0}
        >
          <Button size="sm" variant="secondary" onClick={() => setInner(true)}>
            Open middle modal
          </Button>
          <Modal open={inner} onOpenChange={setInner}>
            <DemoModalContent
              title="Middle modal"
              description="Contains an uncontrolled modal with its own trigger."
              treeDepth={2}
              widthLevel={1}
            >
              <Modal>
                <ModalTrigger asChild>
                  <Button size="sm" variant="secondary">
                    Open inner modal
                  </Button>
                </ModalTrigger>
                <DemoModalContent
                  title="Inner modal"
                  description="Uncontrolled: Radix owns no state here, the stack still sees it."
                  treeDepth={3}
                  widthLevel={2}
                />
              </Modal>
            </DemoModalContent>
          </Modal>
        </DemoModalContent>
      </Modal>
    </Card>
  );
}

/** A modal that opens a sheet and a confirm, both rendered as siblings. */
function MixedScenario() {
  const [modal, setModal] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [confirm, setConfirm] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Modal, sheet, and confirm</CardTitle>
        <CardDescription>
          The sheet and the confirm are siblings of the modal. Open the sheet from the modal, then
          the confirm from the sheet: three different primitives, one stack.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setModal(true)}>
          Open project settings
        </Button>
      </CardContent>

      <Modal open={modal} onOpenChange={setModal}>
        <DemoModalContent
          title="Project settings"
          description="The sheet and confirm below are not inside this modal's JSX."
          treeDepth={1}
          widthLevel={0}
        >
          <Button size="sm" variant="secondary" onClick={() => setSheet(true)}>
            Open details sheet
          </Button>
          <Button size="sm" variant="destructive" onClick={() => setConfirm(true)}>
            Delete project
          </Button>
        </DemoModalContent>
      </Modal>

      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Project details</SheetTitle>
            <SheetDescription>A sheet opened over a sibling modal.</SheetDescription>
          </SheetHeader>
          <SheetBody>
            <DepthReadout legacyDepth={null} />
            <Button size="sm" variant="destructive" onClick={() => setConfirm(true)}>
              Delete project
            </Button>
          </SheetBody>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete project?"
        description="Demo only. Nothing is deleted."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => setConfirm(false)}
      />
    </Card>
  );
}

export default function DebugModalStackPage() {
  const [legacy, setLegacy] = useState(false);

  return (
    <LegacyStackingContext.Provider value={legacy}>
      <div className="bg-background min-h-screen">
        <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-10 pb-20 lg:py-20">
          <header className="space-y-1">
            <h1 className="text-foreground text-xl font-medium">Modal stack</h1>
            <p className="text-muted-foreground text-sm text-balance">
              Every modal opened while another is open must sit above it, with its overlay dimming
              the card below. The inspector in the bottom right checks the real z-index of every
              open layer.
            </p>
          </header>

          <Card>
            <CardContent className="flex items-center justify-between gap-4 pt-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">Pre-fix stacking</p>
                <p className="text-muted-foreground text-xs">
                  Pins the demo modal cards to the z-index JSX nesting alone gave them. Open two
                  sibling modals to reproduce the conflict.
                </p>
              </div>
              <Switch checked={legacy} onCheckedChange={setLegacy} />
            </CardContent>
          </Card>

          <SiblingScenario />
          <NestedScenario />
          <MixedScenario />
        </div>
      </div>
      <LayerInspector />
    </LegacyStackingContext.Provider>
  );
}
