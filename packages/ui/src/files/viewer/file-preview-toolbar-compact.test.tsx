/**
 * The viewer toolbar keeps the file name readable in a narrow side panel.
 *
 * The regression: at a 367px session side panel the name measured 1px wide.
 * The row never overflowed, because the name column (`min-w-0 flex-1`) shrank
 * first, so the compact toolbar (no previous/next pair, status chip, Save as PDF,
 * Copy link or Download label) never switched on. happy-dom has no layout, so the widths the browser
 * measured are stubbed on the two elements the toolbar measures.
 */
import { afterAll, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

import { FilePreviewModal } from "./file-preview-modal";
import type { FileSource } from "./file-source";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  configurable: true,
});

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as unknown as Record<string, unknown>;
const saved = {
  window: globals.window,
  document: globals.document,
  navigator: globals.navigator,
};
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
afterAll(() => Object.assign(globals, saved));

const FILE = "quarterly-report.md";

// Stable across renders, as a real query result is: the viewer derives state from identity.
const content = {
  data: { type: "text" as const, content: "# hello" },
  isLoading: false,
  error: null,
  refetch: async () => undefined,
};
const blob = { blobUrl: null, blob: null, isLoading: false, error: null };
const source: FileSource = {
  id: "toolbar-compact",
  useFileContent: () => content,
  useBinaryBlob: () => blob,
  download: async () => undefined,
  upload: async () => undefined,
};

type Box = { client: number; scroll: number };

/** Stub the widths the browser would measure for the name span and the toolbar row. */
function stubLayout(name: Box, row: Box) {
  const proto = win.HTMLElement.prototype as unknown as object;
  const isName = (el: Element) =>
    el.tagName === "SPAN" && el.textContent === FILE;
  const isRow = (el: Element) =>
    !!el.firstElementChild?.firstElementChild &&
    isName(el.firstElementChild.firstElementChild);
  const width = (key: keyof Box) =>
    function (this: Element) {
      return isName(this) ? name[key] : isRow(this) ? row[key] : 0;
    };
  Object.defineProperty(proto, "clientWidth", {
    get: width("client"),
    configurable: true,
  });
  Object.defineProperty(proto, "scrollWidth", {
    get: width("scroll"),
    configurable: true,
  });
}

async function renderToolbar(): Promise<{
  labels: string[];
  chip: boolean;
  unmount: () => void;
}> {
  const host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <FilePreviewModal
        selectedFilePath={`/workspace/${FILE}`}
        panelMode="viewer"
        filePathList={[`/workspace/${FILE}`, "/workspace/b.md"]}
        currentFileIndex={0}
        onClose={() => {}}
        onNext={() => {}}
        onPrev={() => {}}
        source={source}
        HistoryContent={() => null}
        renderFileIcon={() => null}
        statusSlot={<span data-chip>modified</span>}
        embedded
      />,
    );
  });
  const labels = Array.from(host.querySelectorAll("button")).map(
    (b) => b.getAttribute("aria-label") ?? "",
  );
  const chip = !!host.querySelector("[data-chip]");
  return { labels, chip, unmount: () => act(() => root.unmount()) };
}

const hasStepButtons = (labels: string[]) =>
  labels.some((l) => /previous/i.test(l)) &&
  labels.some((l) => /next/i.test(l));

describe("file viewer toolbar in a narrow panel", () => {
  test("a name squeezed below its readable width switches the toolbar to compact", async () => {
    // 367px side panel: the row fits, the name is 1px of its 130px.
    stubLayout({ client: 1, scroll: 130 }, { client: 343, scroll: 343 });
    const { labels, chip, unmount } = await renderToolbar();
    expect(hasStepButtons(labels)).toBe(false);
    // The status chip gives its width to the name; the Changes tab carries it.
    expect(chip).toBe(false);
    unmount();
  });

  test("a wide row with the name at its max width keeps previous/next", async () => {
    // Full screen: a long name truncates at its 300px cap, which is readable.
    stubLayout({ client: 300, scroll: 640 }, { client: 1400, scroll: 1400 });
    const { labels, chip, unmount } = await renderToolbar();
    expect(hasStepButtons(labels)).toBe(true);
    expect(chip).toBe(true);
    unmount();
  });

  test("a short name shown in full keeps previous/next", async () => {
    stubLayout({ client: 40, scroll: 40 }, { client: 600, scroll: 600 });
    const { labels, unmount } = await renderToolbar();
    expect(hasStepButtons(labels)).toBe(true);
    unmount();
  });
});
