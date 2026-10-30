import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { buildArtifactCaptureSvg } from "../../../../apps/api/src/artifacts/annotation-capture";
const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});
function page(html: string) {
  const window = new Window({ url: "https://page.example.test/" });
  windows.push(window);
  window.document.body.innerHTML = html;
  return window;
}
test("capture serializes only page-owned visible content and clips without cloning an iframe", async () => {
  const window = page(
    '<p style="color:rgb(1,2,3)">Visible</p><input value="private form"><div data-kortix-annotation-overlay>private pins</div><script>private script</script>',
  );
  const result = await buildArtifactCaptureSvg(
    window.document as never,
    { x: 5, y: 10, width: 320, height: 180 },
    new AbortController().signal,
  );
  expect(result.width).toBe(320);
  expect(result.height).toBe(180);
  expect(result.svg).toContain("Visible");
  expect(result.svg).toContain("foreignObject");
  for (const privateText of [
    "private form",
    "private pins",
    "private script",
    "<iframe",
  ])
    expect(result.svg).not.toContain(privateText);
  expect(window.document.querySelectorAll("iframe")).toHaveLength(0);
});
test("capture aborts and refuses missing image bytes or unbounded markup instead of silently omitting assets", async () => {
  const window = page('<img src="https://other.example.test/no-cors.png">');
  await expect(
    buildArtifactCaptureSvg(
      window.document as never,
      { x: 0, y: 0, width: 100, height: 100 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "unavailable" });
  const signal = AbortSignal.abort();
  await expect(
    buildArtifactCaptureSvg(
      window.document as never,
      { x: 0, y: 0, width: 100, height: 100 },
      signal,
    ),
  ).rejects.toMatchObject({ reason: "cancelled" });
});

test("capture preserves local SVG references and refuses external paint references", async () => {
  const window = page(
    '<svg><defs><path id="shape" d="M0 0L10 10" /></defs><use href="#shape" /></svg>',
  );
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  const value = await buildArtifactCaptureSvg(
    window.document as never,
    rect,
    new AbortController().signal,
  );
  expect(value.svg).toContain('href="#shape"');
  window.document
    .querySelector("use")!
    .setAttribute("href", "https://other.example.test/icon.svg#shape");
  await expect(
    buildArtifactCaptureSvg(
      window.document as never,
      rect,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "unavailable" });
});

test("capture retains the document root background", async () => {
  const window = page("<p>Visible text</p>");
  window.document.documentElement.style.backgroundColor = "rgb(17, 34, 51)";
  const result = await buildArtifactCaptureSvg(
    window.document as never,
    { x: 0, y: 0, width: 100, height: 100 },
    new AbortController().signal,
  );
  expect(result.svg).toContain("rgb(17, 34, 51)");
});

test("only fixed or sticky content painted inside the capture refuses an inaccurate image", async () => {
  for (const position of ["fixed", "sticky"]) {
    const window = page(
      `<header style="position:${position};height:20px">Pinned text</header><p>Body text</p>`,
    );
    const header = window.document.querySelector("header")!;
    header.getBoundingClientRect = () => new window.DOMRect(0, 0, 100, 20);
    const signal = new AbortController().signal;
    await expect(
      buildArtifactCaptureSvg(
        window.document as never,
        { x: 0, y: 0, width: 100, height: 100 },
        signal,
      ),
    ).rejects.toMatchObject({ reason: "unavailable" });
    const result = await buildArtifactCaptureSvg(
      window.document as never,
      { x: 0, y: 100, width: 100, height: 100 },
      signal,
    );
    expect(result.svg).toContain("Body text");
    expect(result.svg).not.toContain("Pinned text");
  }
});
