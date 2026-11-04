import { afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const win = new Window();
const dom = win as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "KeyboardEvent",
  "PointerEvent",
  "MutationObserver",
  "CustomEvent",
  "NodeFilter",
  "DocumentFragment",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "customElements",
  "matchMedia",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  const value = dom[key];
  Object.defineProperty(globalThis, key, {
    value:
      typeof value === "function" && /^[a-z]/.test(key)
        ? value.bind(win)
        : value,
    configurable: true,
  });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  configurable: true,
});

const { DetailLayer } = await import("./detail-view");
const { Modal, ModalContent, ModalTitle } =
  await import("../../../primitives/modal");
const {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} = await import("../../../primitives/dropdown-menu");

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function mountDetail(body: ReactNode = <div />, isMobile = false) {
  const onBack = mock(() => undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <DetailLayer
        detail={{ key: "k", title: "image.png", body }}
        onBack={onBack}
        isMobile={isMobile}
      >
        <div>home</div>
      </DetailLayer>,
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { onBack, host };
}

describe("detail layer Escape", () => {
  /**
   * The page-wide triple-ESC-to-stop (`session-chat.tsx`) skips an Escape
   * another control marked consumed. Closing three full-screen images in a
   * row used to stop the running turn because this close left the press
   * unmarked.
   */
  test("closing the detail marks the press consumed", () => {
    const { onBack } = mountDetail();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

async function escape(target: EventTarget = document.body, prevented = false) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  if (prevented) event.preventDefault();
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

function DiscussionModal({ withMenu = false }: { withMenu?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <Modal open={open} onOpenChange={setOpen}>
      <ModalContent aria-describedby={undefined}>
        <ModalTitle>Comments</ModalTitle>
        {withMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button">Comment actions</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Resolve</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <button type="button">Reply</button>
        )}
      </ModalContent>
    </Modal>
  );
}

test("Escape dismisses the real child Comments modal before closing the embedded detail", async () => {
  const { onBack } = mountDetail(<DiscussionModal />);
  expect(
    document.querySelector('[role="dialog"][data-state="open"]'),
  ).not.toBeNull();
  const reply = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Reply",
  )!;
  await escape(reply);
  expect(
    document.querySelector('[role="dialog"][data-state="open"]'),
  ).toBeNull();
  expect(onBack).not.toHaveBeenCalled();
  const next = await escape();
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(next.defaultPrevented).toBe(true);
});

test("an already-consumed Escape does not close the detail", async () => {
  const { onBack } = mountDetail();
  await escape(document.body, true);
  expect(onBack).not.toHaveBeenCalled();
});

test("Escape closes the floating comment menu, then Comments, then the embedded detail", async () => {
  const { onBack } = mountDetail(<DiscussionModal withMenu />);
  const trigger = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Comment actions",
  )!;
  await act(async () =>
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    ),
  );
  const menu = document.querySelector('[role="menu"]');
  expect(menu).not.toBeNull();
  await escape(menu!);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(
    document.querySelector('[role="dialog"][data-state="open"]'),
  ).not.toBeNull();
  expect(onBack).not.toHaveBeenCalled();
  await escape(document.querySelector('[role="dialog"][data-state="open"]')!);
  expect(
    document.querySelector('[role="dialog"][data-state="open"]'),
  ).toBeNull();
  expect(onBack).not.toHaveBeenCalled();
  await escape();
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("the native mobile drawer remains the sole owner of its Escape dismissal", async () => {
  const { onBack } = mountDetail(
    <button type="button">Mobile detail</button>,
    true,
  );
  const drawer = document.querySelector('[data-slot="drawer-content"]');
  expect(drawer).not.toBeNull();
  await escape(drawer!);
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("an open portaled confirmation owns Escape before any listener marks the press consumed", async () => {
  const { onBack } = mountDetail();
  const confirmation = document.createElement("div");
  confirmation.setAttribute("role", "alertdialog");
  confirmation.setAttribute("data-state", "open");
  document.body.append(confirmation);
  cleanups.push(() => confirmation.remove());
  const event = await escape();
  expect(event.defaultPrevented).toBe(false);
  expect(onBack).not.toHaveBeenCalled();
  confirmation.remove();
  await escape();
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("an open floating menu owns an unconsumed Escape without dismissing the detail", async () => {
  const { onBack } = mountDetail();
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("data-state", "open");
  document.body.append(menu);
  cleanups.push(() => menu.remove());
  const event = await escape();
  expect(event.defaultPrevented).toBe(false);
  expect(onBack).not.toHaveBeenCalled();
  menu.remove();
  await escape();
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("an ancestor dialog does not block the detail from handling its own Escape", async () => {
  const { onBack, host } = mountDetail();
  const ancestor = document.createElement("div");
  ancestor.setAttribute("role", "dialog");
  ancestor.setAttribute("data-state", "open");
  document.body.append(ancestor);
  ancestor.append(host);
  cleanups.push(() => ancestor.remove());
  await escape();
  expect(onBack).toHaveBeenCalledTimes(1);
});
