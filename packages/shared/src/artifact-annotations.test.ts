import { expect, test } from "bun:test";
import {
  parseArtifactAnnotationFrameMessage,
  parseArtifactAnnotationHostMessage,
} from "./artifact-annotations";

const envelope = { kortix: "annotate", v: 1 } as const;
const viewport = { width: 1440, height: 900, scroll: { x: 0, y: 200 } };
const rect = { x: 20, y: 240, width: 300, height: 40 };
const layout = {
  ...envelope,
  type: "layout" as const,
  revision: 1,
  chunk: 0,
  final: true,
  complete: true,
  viewport,
  elements: [{ n: 0, selector: "#forecast", snippet: "Forecast", rect }],
  texts: [{ n: 0, offset: 0, text: "Forecast is final." }],
};
const textAnchor = {
  type: "text" as const,
  quote: "Forecast",
  prefix: "",
  suffix: " is final.",
};
const pointAnchor = {
  type: "point" as const,
  selector: "#forecast",
  snippet: "Forecast",
  viewport_width: 1440,
  scroll: { x: 0, y: 200 },
  offset: { x: 0.25, y: 0.5 },
};

test("frame protocol accepts page-owned layout, selection candidates, and numeric focus", () => {
  expect(
    parseArtifactAnnotationFrameMessage({ ...envelope, type: "ready" }),
  ).toEqual({
    ...envelope,
    type: "ready",
  });
  expect(parseArtifactAnnotationFrameMessage(layout)).toEqual(layout);
  for (const anchor of [
    textAnchor,
    pointAnchor,
    {
      ...pointAnchor,
      type: "region" as const,
      offset: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    },
  ]) {
    const message = {
      ...envelope,
      type: "candidate" as const,
      revision: 1,
      anchor,
    };
    expect(parseArtifactAnnotationFrameMessage(message)).toEqual(message);
  }
  expect(
    parseArtifactAnnotationFrameMessage({ ...envelope, type: "focus", n: 3 }),
  ).toEqual({
    ...envelope,
    type: "focus",
    n: 3,
  });
});

test("frame protocol rejects unknown versions, types, keys, and page-supplied Files versions", () => {
  for (const value of [
    null,
    [],
    "ready",
    { ...envelope, v: 2, type: "ready" },
    { ...envelope, type: "send" },
    {
      ...envelope,
      type: "candidate",
      revision: 1,
      anchor: { ...textAnchor, version: "vc_forged" },
    },
    {
      ...envelope,
      type: "candidate",
      revision: 1,
      anchor: textAnchor,
      body: "Forged comment",
    },
    { ...envelope, type: "candidate", revision: 1, anchor: { type: "none" } },
    { ...envelope, type: "ready", token: "not-a-real-token" },
  ]) {
    expect(parseArtifactAnnotationFrameMessage(value)).toBeNull();
  }
});

test("candidate validation preserves the server Unicode and bounded-anchor contract", () => {
  for (const anchor of [
    { ...textAnchor, quote: "x".repeat(33) },
    { ...textAnchor, quote: "\ud800" },
    { ...textAnchor, prefix: "\0" },
    { ...pointAnchor, viewport_width: Infinity },
    { ...pointAnchor, offset: { x: -1, y: 0 } },
    {
      ...pointAnchor,
      type: "region",
      offset: { x: 0.8, y: 0.2, width: 0.3, height: 0.4 },
    },
  ]) {
    expect(
      parseArtifactAnnotationFrameMessage({
        ...envelope,
        type: "candidate",
        revision: 1,
        anchor,
      }),
    ).toBeNull();
  }
  const valid = {
    ...envelope,
    type: "candidate" as const,
    revision: 1,
    anchor: { ...textAnchor, quote: "🚀".repeat(16) },
  };
  expect(parseArtifactAnnotationFrameMessage(valid)).toEqual(valid);
});

test("layout chunks distinguish a truncated inventory from a complete inventory", () => {
  const partial = { ...layout, final: true, complete: false };
  expect(parseArtifactAnnotationFrameMessage(partial)).toEqual(partial);
  for (const value of [
    { ...layout, revision: -1 },
    { ...layout, chunk: 256 },
    {
      ...layout,
      elements: Array.from({ length: 65 }, (_, n) => ({
        ...layout.elements[0],
        n,
      })),
    },
    { ...layout, texts: [{ n: 0, offset: 0, text: "x".repeat(4097) }] },
    { ...layout, viewport: { ...viewport, width: 0 } },
    {
      ...layout,
      elements: [
        { ...layout.elements[0], rect: { ...rect, width: Number.NaN } },
      ],
    },
  ]) {
    expect(parseArtifactAnnotationFrameMessage(value)).toBeNull();
  }
});

test("host messages carry only mode, numeric pins, rectangles, and text ranges", () => {
  const draw = {
    ...envelope,
    type: "draw" as const,
    revision: 1,
    pins: [{ n: 3, rects: [rect], ranges: [{ n: 0, start: 0, end: 8 }] }],
    active: 3,
    focus: true,
  };
  expect(parseArtifactAnnotationHostMessage(draw)).toEqual(draw);
  for (const mode of ["off", "text", "comment"] as const) {
    expect(
      parseArtifactAnnotationHostMessage({ ...envelope, type: "mode", mode }),
    ).toEqual({
      ...envelope,
      type: "mode",
      mode,
    });
  }
  expect(
    parseArtifactAnnotationHostMessage({ ...envelope, type: "request_layout" }),
  ).toEqual({
    ...envelope,
    type: "request_layout",
  });
  for (const field of [
    "body",
    "name",
    "thread_id",
    "comment_id",
    "token",
    "selector",
    "snippet",
    "version",
  ]) {
    expect(
      parseArtifactAnnotationHostMessage({
        ...draw,
        [field]: "private sentinel",
      }),
    ).toBeNull();
    expect(
      parseArtifactAnnotationHostMessage({
        ...draw,
        pins: [{ ...draw.pins[0], [field]: "private sentinel" }],
      }),
    ).toBeNull();
  }
});

test("host geometry and text ranges reject invalid or empty spans", () => {
  const draw = {
    ...envelope,
    type: "draw",
    revision: 1,
    active: null,
    focus: false,
  };
  for (const pin of [
    { n: 0, rects: [rect], ranges: [] },
    { n: 1, rects: [], ranges: [] },
    { n: 1, rects: [{ ...rect, x: Infinity }], ranges: [] },
    { n: 1, rects: [], ranges: [{ n: 0, start: 4, end: 4 }] },
    { n: 1, rects: [], ranges: [{ n: 0, start: 8, end: 4 }] },
  ]) {
    expect(
      parseArtifactAnnotationHostMessage({ ...draw, pins: [pin] }),
    ).toBeNull();
  }
});

test("bounded parsers reject large, circular, deep, and non-JSON payloads without throwing", () => {
  const circular: Record<string, unknown> = { ...envelope, type: "ready" };
  circular.self = circular;
  let deep: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) deep = { child: deep };
  const oversized = {
    ...layout,
    texts: Array.from({ length: 64 }, (_, n) => ({
      n,
      offset: 0,
      text: "x".repeat(2000),
    })),
  };
  for (const value of [
    circular,
    deep,
    oversized,
    new Date(),
    { ...envelope, type: "ready", value: BigInt(1) },
  ]) {
    expect(() => parseArtifactAnnotationFrameMessage(value)).not.toThrow();
    expect(parseArtifactAnnotationFrameMessage(value)).toBeNull();
    expect(parseArtifactAnnotationHostMessage(value)).toBeNull();
  }
});

test("layout accepts fractional scroll coordinates from browser zoom and rejects negative or unbounded scroll", () => {
  const zoomed = {
    ...layout,
    viewport: { ...viewport, scroll: { x: 0.8, y: 200.4 } },
  };
  expect(parseArtifactAnnotationFrameMessage(zoomed)).toEqual(zoomed);
  for (const y of [-0.1, Infinity, 10000001]) {
    expect(
      parseArtifactAnnotationFrameMessage({
        ...layout,
        viewport: { ...viewport, scroll: { x: 0, y } },
      }),
    ).toBeNull();
  }
});

test("capture envelopes are bounded and contain only correlation and geometry", () => {
  const request = {
    ...envelope,
    type: "capture" as const,
    request: 17,
    revision: 2,
    rect,
  };
  expect(parseArtifactAnnotationHostMessage(request)).toEqual(request);
  expect(
    parseArtifactAnnotationHostMessage({ ...request, marks: [] }),
  ).toBeNull();
  expect(
    parseArtifactAnnotationHostMessage({ ...request, request: 0 }),
  ).toBeNull();
  const chunk = {
    ...envelope,
    type: "capture_chunk" as const,
    request: 17,
    revision: 2,
    index: 0,
    data: "AAAA".repeat(12288),
  };
  expect(parseArtifactAnnotationFrameMessage(chunk)).toEqual(chunk);
  expect(
    parseArtifactAnnotationFrameMessage({
      ...chunk,
      data: chunk.data + "AAAA",
    }),
  ).toBeNull();
  expect(
    parseArtifactAnnotationFrameMessage({ ...chunk, index: 57 }),
  ).toBeNull();
  expect(
    parseArtifactAnnotationFrameMessage({ ...chunk, data: "bad!" }),
  ).toBeNull();
  const start = {
    ...envelope,
    type: "capture_start" as const,
    request: 17,
    revision: 2,
    mime: "image/png" as const,
    width: 200,
    height: 100,
    bytes: 10,
    chunks: 1,
  };
  expect(parseArtifactAnnotationFrameMessage(start)).toEqual(start);
  for (const invalid of [
    { bytes: 2097153 },
    { width: 2049 },
    { mime: "image/svg+xml" },
    { chunks: 58 },
    { token: "private" },
  ])
    expect(
      parseArtifactAnnotationFrameMessage({ ...start, ...invalid }),
    ).toBeNull();
});
