import { afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  ARTIFACT_ANNOTATION_LIMITS as limits,
  parseArtifactAnnotationFrameMessage,
  type ArtifactAnnotationLayout,
} from "@kortix/shared/artifact-annotations";

let script = "";
const windows: Window[] = [];
const envelope = { kortix: "annotate", v: 1 };

beforeAll(() => {
  const compiled = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    const build = await Bun.build({ entrypoints: ['src/artifacts/annotation-bridge.ts'], target: 'browser', format: 'iife', minify: true });
    if (!build.success) throw new Error(String(build.logs));
    process.stdout.write(await build.outputs[0].text());
  `,
    ],
    {
      cwd: new URL("../../../../apps/api/", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString());
  script = compiled.stdout.toString();
  expect(script.length).toBeGreaterThan(0);
});

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

function frame(
  html = '<p id="forecast">Forecast 🚀 moves forward.</p>',
  configure?: (window: Window) => void,
) {
  const window = new Window({
    url: "https://content.example.test/view",
    width: 800,
    height: 600,
  });
  windows.push(window);
  window.document.body.innerHTML = html;
  const sent: unknown[] = [];
  const parent = { postMessage: (message: unknown) => sent.push(message) };
  const delays: number[] = [];
  Object.defineProperty(window, "parent", {
    configurable: true,
    value: parent,
  });
  for (const element of window.document.body.querySelectorAll("*")) {
    element.getBoundingClientRect = () => new window.DOMRect(10, 30, 400, 100);
  }
  configure?.(window);
  new Function(
    "window",
    "document",
    "Element",
    "MutationObserver",
    "requestAnimationFrame",
    "setTimeout",
    script,
  )(
    window,
    window.document,
    window.Element,
    window.MutationObserver,
    (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 1),
    (callback: () => void, delay: number) => {
      delays.push(delay);
      return window.setTimeout(callback, 1);
    },
  );
  const send = (message: object, source: unknown = parent) =>
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { ...envelope, ...message },
        source: source as never,
      }),
    );
  const flush = async () => {
    await window.happyDOM.waitUntilComplete();
  };
  const messages = (type: string) =>
    sent.filter((value: any) => value.type === type) as any[];
  return { window, sent, send, flush, messages, delays };
}

test("compiled bridge emits only validated page-owned inventory and excludes hidden or form values", async () => {
  const page = frame(
    '<p id="forecast">Visible forecast</p><div hidden>hidden secret</div><input value="typed secret"><textarea>textarea secret</textarea><script>script secret</script><style>style secret</style>',
  );
  await page.flush();
  expect(page.messages("ready")).toHaveLength(1);
  const layouts = page.messages("layout");
  expect(layouts.at(-1).final).toBe(true);
  expect(layouts.at(-1).complete).toBe(true);
  expect(
    layouts
      .flatMap((message) => message.texts)
      .map((text) => text.text)
      .join(""),
  ).toBe("Visible forecast");
  expect(
    layouts
      .flatMap((message) => message.elements)
      .some((element) => element.selector === "#forecast"),
  ).toBe(true);
  for (const message of page.sent)
    expect(parseArtifactAnnotationFrameMessage(message)).not.toBeNull();
});

test("mode defaults off, rejects other windows, and native text selection emits a bounded candidate", async () => {
  const page = frame(`<p>${"🚀".repeat(20)} selected passage follows</p>`);
  await page.flush();
  const text = page.window.document.querySelector("p")!.firstChild!;
  const range = page.window.document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 55);
  page.window.getSelection()!.addRange(range);
  const select = () =>
    page.window.document.dispatchEvent(
      new page.window.MouseEvent("mouseup", { bubbles: true }),
    );
  select();
  expect(page.messages("candidate")).toHaveLength(0);
  page.send({ type: "mode", mode: "text" }, {});
  select();
  expect(page.messages("candidate")).toHaveLength(0);
  page.send({ type: "mode", mode: "text" });
  select();
  const candidate = page.messages("candidate").at(-1);
  expect(candidate.anchor).toEqual({
    type: "text",
    quote: "🚀".repeat(16),
    prefix: "",
    suffix: `${"🚀".repeat(4)} selected passage follow`,
  });
  expect(candidate.anchor.version).toBeUndefined();
  expect(parseArtifactAnnotationFrameMessage(candidate)).not.toBeNull();
});

test("point and clipped region candidates retain fractional geometry and page selector", async () => {
  const page = frame();
  await page.flush();
  page.send({ type: "mode", mode: "comment" });
  const target = page.window.document.querySelector("p")!;
  const pointer = (type: string, x: number, y: number) =>
    target.dispatchEvent(
      new page.window.PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 1,
      }),
    );
  pointer("pointerdown", 110, 80);
  pointer("pointerup", 110, 80);
  expect(page.messages("candidate").at(-1).anchor.offset).toEqual({
    x: 0.25,
    y: 0.5,
  });
  pointer("pointerdown", 110, 80);
  pointer("pointermove", 800, 600);
  pointer("pointerup", 800, 600);
  const candidate = page.messages("candidate").at(-1);
  expect(candidate.anchor.type).toBe("region");
  expect(candidate.anchor.selector).toBe("#forecast");
  expect(candidate.anchor.offset).toEqual({
    x: 0.25,
    y: 0.5,
    width: 0.75,
    height: 0.5,
  });
  expect(parseArtifactAnnotationFrameMessage(candidate)).not.toBeNull();
});

test("only current validated parent draws render numeric pins and keyboard focus messages", async () => {
  const page = frame();
  await page.flush();
  const revision = page.messages("layout").at(-1).revision;
  const pin = {
    n: 7,
    rects: [{ x: 10, y: 30, width: 100, height: 20 }],
    ranges: [],
  };
  page.send({
    type: "draw",
    revision: revision - 1,
    pins: [pin],
    active: null,
    focus: false,
  });
  const overlay = page.window.document.querySelector(
    "[data-kortix-annotation-overlay]",
  )!;
  expect(overlay.shadowRoot!.querySelector("button")).toBeNull();
  page.send(
    { type: "draw", revision, pins: [pin], active: null, focus: false },
    {},
  );
  expect(overlay.shadowRoot!.querySelector("button")).toBeNull();
  page.send({ type: "draw", revision, pins: [pin], active: 7, focus: false });
  const button = overlay.shadowRoot!.querySelector("button")!;
  expect(button.textContent).toBe("7");
  button.dispatchEvent(
    new page.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(page.messages("focus")).toEqual([
    { ...envelope, type: "focus", n: 7 },
  ]);
  page.send({
    type: "draw",
    revision,
    pins: [{ ...pin, body: "private sentinel" }],
    active: null,
    focus: false,
  });
  expect(overlay.shadowRoot!.textContent).not.toContain("private sentinel");
});

test("inventory packs actual UTF-8 bytes, keeps long text offsets, and marks truncation", async () => {
  const page = frame(`<p>${"字".repeat(30000)}</p>`);
  await page.flush();
  const layouts = page.messages("layout");
  expect(layouts.length).toBeGreaterThan(1);
  for (const message of layouts)
    expect(
      new TextEncoder().encode(JSON.stringify(message)).byteLength,
    ).toBeLessThanOrEqual(limits.messageBytes);
  const texts = layouts.flatMap((message) => message.texts);
  expect(texts.map((text) => text.text).join("")).toBe("字".repeat(30000));
  expect(texts.map((text) => text.offset)).toEqual([
    0, 4096, 8192, 12288, 16384, 20480, 24576, 28672,
  ]);
  expect(
    layouts.every((message) => parseArtifactAnnotationFrameMessage(message)),
  ).toBe(true);
  const truncated = frame(`<p>${"x".repeat(limits.textUnits + 1)}</p>`);
  await truncated.flush();
  expect(truncated.messages("layout").at(-1).complete).toBe(false);
  expect(
    truncated
      .messages("layout")
      .flatMap((message) => message.texts)
      .reduce((sum, text) => sum + text.text.length, 0),
  ).toBe(limits.textUnits);
  truncated.send({ type: "mode", mode: "text" });
  const range = truncated.window.document.createRange();
  range.selectNodeContents(truncated.window.document.querySelector("p")!);
  truncated.window.getSelection()!.addRange(range);
  truncated.window.document.dispatchEvent(
    new truncated.window.MouseEvent("mouseup", { bubbles: true }),
  );
  expect(truncated.messages("candidate")).toHaveLength(0);
});

test("compiled bridge coalesces mutations and never observes its own overlay drawings", async () => {
  const page = frame();
  await page.flush();
  const revision = page.messages("layout").at(-1).revision;
  const text = page.window.document.querySelector("p")!.firstChild!;
  for (let n = 0; n < 20; n++) text.textContent = `Forecast revision ${n}`;
  await page.flush();
  expect(page.messages("layout")).toHaveLength(2);
  expect(page.messages("layout").at(-1).revision).toBe(revision + 1);
  expect(page.delays).toEqual([100]);
  const current = page.messages("layout").at(-1);
  page.send({
    type: "draw",
    revision: current.revision,
    pins: [{ n: 1, rects: [{ x: 1, y: 2, width: 3, height: 4 }], ranges: [] }],
    active: null,
    focus: false,
  });
  await page.flush();
  expect(page.messages("layout")).toHaveLength(2);
});

test("DOM helpers keep escaped selectors, raw text offsets, and clipped reversed regions exact", async () => {
  const helpers =
    await import("../../../../apps/api/src/artifacts/annotation-dom");
  const page = frame('<div><p id="1:quote[ ]">first</p><p>second</p></div>');
  await page.flush();
  const element = page.window.document.querySelector("p")!;
  const selector = helpers.annotationSelector(element as unknown as Element)!;
  expect(page.window.document.querySelector(selector)).toBe(element);
  expect(helpers.safeAnnotationSlice("a🚀b", 0, 2)).toBe("a");
  expect(helpers.safeAnnotationSlice("a🚀b", 2, 4)).toBe("b");
  expect(
    helpers.annotationRect({ x: Number.NaN, y: 0, width: 1, height: 1 }),
  ).toBeNull();
  expect(
    helpers.annotationRect({ x: 10, y: 20, width: 30, height: 40 }, 50, 60),
  ).toEqual({ x: 60, y: 80, width: 30, height: 40 });
  const candidate = helpers.annotationPoint(
    {
      n: 0,
      selector: "#a",
      snippet: "a",
      rect: { x: 10, y: 20, width: 100, height: 100 },
    },
    { x: 200, y: 200 },
    { x: -10, y: -10 },
    800,
    { x: 0, y: 0 },
  );
  expect(candidate).toMatchObject({
    type: "region",
    offset: { x: 0, y: 0, width: 1, height: 1 },
  });
});

test("cross-node and adjacent-block selection uses the same raw rope reported to the host", async () => {
  const page = frame("<p>First <b>bold</b></p><p>next</p>");
  await page.flush();
  const texts = page.messages("layout").flatMap((message) => message.texts);
  expect(texts.map((text) => text.text).join("")).toBe("First boldnext");
  const range = page.window.document.createRange();
  range.setStart(page.window.document.querySelector("p")!.firstChild!, 3);
  range.setEnd(page.window.document.querySelectorAll("p")[1]!.firstChild!, 2);
  page.window.getSelection()!.addRange(range);
  page.send({ type: "mode", mode: "text" });
  page.window.document.dispatchEvent(
    new page.window.MouseEvent("mouseup", { bubbles: true }),
  );
  expect(page.messages("candidate").at(-1).anchor).toEqual({
    type: "text",
    quote: "st boldne",
    prefix: "Fir",
    suffix: "xt",
  });
  page.send({ type: "mode", mode: "off" });
  page.window.document.dispatchEvent(
    new page.window.MouseEvent("mouseup", { bubbles: true }),
  );
  expect(page.messages("candidate")).toHaveLength(1);
});

test("text-range drawings read current indexed DOM geometry without changing page text", async () => {
  const page = frame();
  await page.flush();
  const calls: { start: number; end: number }[] = [];
  Object.defineProperty(page.window.Range.prototype, "getClientRects", {
    value: function (this: Range) {
      calls.push({ start: this.startOffset, end: this.endOffset });
      return [new page.window.DOMRect(20, 40, 80, 18)];
    },
  });
  const before = page.window.document.body.innerHTML;
  page.send({
    type: "draw",
    revision: page.messages("layout").at(-1).revision,
    pins: [{ n: 2, rects: [], ranges: [{ n: 0, start: 0, end: 8 }] }],
    active: 2,
    focus: false,
  });
  expect(calls).toEqual([{ start: 0, end: 8 }]);
  expect(
    page.window.document
      .querySelector("[data-kortix-annotation-overlay]")!
      .shadowRoot!.querySelector("button")!.textContent,
  ).toBe("2");
  expect(page.window.document.body.innerHTML).toBe(before);
});

test("unknown or oversized host messages are ignored while explicit layout requests advance revision", async () => {
  const page = frame();
  await page.flush();
  for (const value of [
    { type: "request_layout", v: 2 },
    { type: "request_layout", body: "x" },
    { type: "mode", mode: "comment", token: "x".repeat(70000) },
  ])
    page.send(value);
  page.send({ type: "request_layout" }, {});
  await page.flush();
  expect(page.messages("layout")).toHaveLength(1);
  page.send({ type: "request_layout" });
  await page.flush();
  expect(page.messages("layout")).toHaveLength(2);
  expect(page.messages("layout")[1].revision).toBe(
    page.messages("layout")[0].revision + 1,
  );
});

test("late non-bubbling image loads remeasure geometry and coalesce without overlay load loops", async () => {
  const page = frame(
    '<img id="late-image"><p id="forecast">Forecast moves after an image loads.</p>',
  );
  await page.flush();
  const previous = page.messages("layout").at(-1).revision;
  const forecast = page.window.document.querySelector("#forecast")!;
  forecast.getBoundingClientRect = () =>
    new page.window.DOMRect(10, 240, 400, 100);
  const image = page.window.document.querySelector("#late-image")!;
  for (let n = 0; n < 20; n++)
    image.dispatchEvent(new page.window.Event("load", { bubbles: false }));
  await page.flush();
  const layouts = page.messages("layout");
  expect(layouts).toHaveLength(2);
  expect(layouts.at(-1).revision).toBe(previous + 1);
  expect(
    layouts
      .at(-1)
      .elements.find(
        (element: ArtifactAnnotationLayout["elements"][number]) =>
          element.selector === "#forecast",
      ).rect.y,
  ).toBe(240);
  expect(page.delays).toEqual([100]);
  const overlay = page.window.document.querySelector(
    "[data-kortix-annotation-overlay]",
  )!;
  overlay.dispatchEvent(
    new page.window.Event("load", { bubbles: false, composed: true }),
  );
  await page.flush();
  expect(page.messages("layout")).toHaveLength(2);
});

test("late document font completion remeasures text geometry without DOM mutations or window resize", async () => {
  let fontLoaded: () => void = () => {};
  const page = frame(
    '<p id="forecast">Forecast uses a late font.</p>',
    (window) => {
      const fonts = new window.EventTarget();
      Object.defineProperty(window.document, "fonts", {
        configurable: true,
        value: fonts,
      });
      fontLoaded = () => fonts.dispatchEvent(new window.Event("loadingdone"));
    },
  );
  await page.flush();
  const previous = page.messages("layout").at(-1).revision;
  page.window.document.querySelector("#forecast")!.getBoundingClientRect = () =>
    new page.window.DOMRect(10, 30, 520, 140);
  fontLoaded();
  await page.flush();
  const latest = page.messages("layout").at(-1);
  expect(latest.revision).toBe(previous + 1);
  expect(
    latest.elements.find(
      (element: ArtifactAnnotationLayout["elements"][number]) =>
        element.selector === "#forecast",
    ).rect,
  ).toEqual({ x: 10, y: 30, width: 520, height: 140 });
  expect(page.delays).toEqual([100]);
});

test("compiled bridge refuses stale capture and never accepts capture from another window", async () => {
  const page = frame();
  await page.flush();
  const revision = page.messages("layout").at(-1).revision;
  const request = {
    type: "capture",
    request: 31,
    revision,
    rect: { x: 0, y: 0, width: 100, height: 100 },
  };
  page.send(request, {});
  await page.flush();
  expect(page.messages("capture_error")).toHaveLength(0);
  page.send({ ...request, revision: revision - 1 });
  await page.flush();
  expect(page.messages("capture_error").at(-1)).toMatchObject({
    request: 31,
    reason: "stale",
  });
  expect(page.messages("capture_chunk")).toHaveLength(0);
});

test("page inventory includes bounded document geometry for a whole-area drawing region", async () => {
  const page = frame("<p>Small child.</p>");
  await page.flush();
  const root = page
    .messages("layout")
    .flatMap((chunk) => chunk.elements)
    .find((item) => item.selector === "html");
  expect(root).toMatchObject({
    rect: { x: 0, y: 0, width: 800, height: 600 },
    snippet: "Small child.",
  });
});
