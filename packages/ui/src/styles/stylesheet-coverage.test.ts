import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The package ships every rule its components need. A rule a component
// depends on that lives only in apps/web's globals.css works in Kortix's app
// and silently does nothing in every other host (the composer placeholder,
// the slash hint, the streamed-word fade, the print masthead all did).

const PKG = join(import.meta.dir, "..", "..");
const SRC = join(PKG, "src");
const WEB_GLOBALS = join(
  PKG,
  "..",
  "..",
  "apps",
  "web",
  "src",
  "app",
  "globals.css",
);

/** Classes apps/web styles on purpose: the desktop shell's window geometry
 *  (CLAUDE.md "Desktop parity"). A library host has no native title bar. */
const HOST_HOOKS = new Set([
  "kx-account-hub-header",
  "kx-auth-mobile-logo",
  "kx-below-titlebar",
  "kx-desktop-back",
  "kx-desktop-band-row",
  "kx-fullscreen-modal",
  "kx-overlay-sidebar-titlebar",
  "kx-project-sidebar-header",
  "kx-project-sidebar-titlebar",
  "kx-titlebar-band-height",
  "kx-titlebar-row",
  "kx-titlebar-safe-mt",
  "kx-titlebar-tabs",
]);

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, ext, out);
    else if (ext.test(name) && !name.includes(".test.")) out.push(path);
  }
  return out;
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const classSelectors = (css: string) =>
  new Set(
    [
      ...stripComments(css).matchAll(/\.((?:kx|kortix|composer)-[a-z0-9-]+)/g),
    ].map((m) => m[1]),
  );

const packageCss = walk(SRC, /\.css$/)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const packageRules = classSelectors(packageCss);
const componentSource = walk(SRC, /\.tsx?$/)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

describe("stylesheet coverage", () => {
  test("no class a component writes is styled only by apps/web", () => {
    const webOnly = [...classSelectors(readFileSync(WEB_GLOBALS, "utf8"))]
      .filter((name) => !HOST_HOOKS.has(name) && !packageRules.has(name))
      .filter((name) =>
        new RegExp(`["'\` ]${name}["'\` ]`).test(componentSource),
      );
    expect(webOnly).toEqual([]);
  });

  test("the prebuilt styles.css ships the print and component rules", () => {
    const dist = readFileSync(join(PKG, "dist", "styles.css"), "utf8");
    for (const marker of [
      "[data-print-header]",
      "[data-print-passthrough]",
      "is-editor-empty",
      "kortix-slash-trigger",
      "kx-stream-word-in",
      "katex-display",
    ]) {
      expect(dist).toContain(marker);
    }
  });

  test("the committed styles.css matches src (run: pnpm --filter @kortix/ui build:styles)", () => {
    const run = spawnSync(
      "node",
      [join(PKG, "scripts", "build-styles.mjs"), "--check"],
      {
        cwd: PKG,
        encoding: "utf8",
      },
    );
    if (run.status !== 0) throw new Error(`${run.stdout}${run.stderr}`);
    expect(run.stdout).toContain("build-styles: no drift");
  });
});
