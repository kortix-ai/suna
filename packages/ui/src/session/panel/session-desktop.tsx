"use client";

/**
 * `SessionDesktop` — the session computer's screen, live.
 *
 * Every session image runs an XFCE desktop that voxl streams on port 6901
 * (`packages/shared/src/sandbox/desktop.ts`). This frames voxl's own web
 * client through the sandbox proxy, the same way `AppPreview` frames a port.
 *
 * The frame starts view-only: a transparent shield takes every pointer and
 * key, so a user who scrolls or clicks past the panel never moves the agent's
 * mouse by accident. "Take control" (or a click on the screen) drops the
 * shield and focuses the frame; "Release" puts it back.
 */

import { Button } from "../../primitives/button";
import { ButtonGroup } from "../../primitives/button-group";
import Loading from "../../primitives/loading";
import { useSandboxProxy } from "../../internal/hooks/use-sandbox-proxy";
import { usePreviewFrameUrl } from "../../internal/hooks/use-preview-frame-url";
import { useIsMobile } from "../../internal/hooks";
import { framePolicy } from "../../files/viewer/preview-policy";
import { PanelWidthButton } from "../../files/viewer/viewer-actions";
import {
  CloseButton,
  DetailSidebarToggle,
} from "../../files/viewer/viewer-chrome";
import { probePreviewPort } from "@kortix/sdk";
import {
  ArrowSquareOutIcon,
  CursorClickIcon,
  MonitorIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

export const DESKTOP_URL = "http://localhost:6901/";

export function SessionDesktop({
  projectId,
  projectSessionId,
  onClose,
}: {
  projectId?: string;
  projectSessionId?: string;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const { proxyUrl } = useSandboxProxy();
  const src = usePreviewFrameUrl(
    DESKTOP_URL,
    proxyUrl(DESKTOP_URL) ?? DESKTOP_URL,
    {
      projectId,
      sessionId: projectSessionId,
    },
  ).url;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [control, setControl] = useState(false);
  // 'off' = the proxy answered 502/503/504: nothing listens on 6901.
  const [state, setState] = useState<"probing" | "on" | "off">("probing");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!src) return;
    const abort = new AbortController();
    void probePreviewPort(src, { signal: abort.signal }).then((probe) => {
      if (!abort.signal.aborted)
        setState(probe === "unreachable" ? "off" : "on");
    });
    return () => abort.abort();
  }, [src, attempt]);

  const takeControl = () => {
    setControl(true);
    frameRef.current?.focus();
  };

  return (
    <div className="bg-background flex h-full min-h-0 min-w-0 flex-col">
      <div className="border-border flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <DetailSidebarToggle className="size-7" />
        <MonitorIcon className="text-muted-foreground ml-1 size-3.5 shrink-0" />
        <span className="truncate text-sm font-medium">Desktop</span>
        <span className="text-muted-foreground truncate text-xs">
          {control ? "You have control" : "View only"}
        </span>
        <div className="flex-1" />
        <Button
          variant={control ? "secondary" : "default"}
          size="sm"
          className="h-7 shrink-0"
          disabled={state !== "on"}
          aria-pressed={control}
          onClick={control ? () => setControl(false) : takeControl}
        >
          <CursorClickIcon className="size-3.5" />
          {control ? "Release" : "Take control"}
        </Button>
        <ButtonGroup className="shrink-0">
          <Button
            variant="secondary"
            size="icon"
            className="size-7"
            disabled={!src || state !== "on"}
            aria-label="Open in new tab"
            onClick={() =>
              src && window.open(src, "_blank", "noopener,noreferrer")
            }
          >
            <ArrowSquareOutIcon className="size-3.5" />
          </Button>
          <PanelWidthButton isMobile={isMobile} />
          <CloseButton onClose={onClose} />
        </ButtonGroup>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        {state === "off" ? (
          <div className="bg-background text-muted-foreground flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm">
            <MonitorIcon className="size-10 opacity-20" />
            <p>The desktop is not running on this computer.</p>
            <p className="text-xs">
              Ask the agent to run <code>kortix-desktop start</code>.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setState("probing");
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </Button>
          </div>
        ) : !src || state === "probing" ? (
          <div className="flex h-full items-center justify-center">
            <Loading className="size-4" />
          </div>
        ) : (
          <>
            <iframe
              ref={frameRef}
              src={src}
              title="Desktop"
              className="h-full w-full border-0"
              sandbox={framePolicy("app", src).sandbox}
              allow="clipboard-read; clipboard-write; autoplay; fullscreen"
              tabIndex={control ? 0 : -1}
            />
            {!control && (
              <button
                type="button"
                aria-label="Take control"
                data-slot="desktop-shield"
                className="absolute inset-0 cursor-pointer"
                onClick={takeControl}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
