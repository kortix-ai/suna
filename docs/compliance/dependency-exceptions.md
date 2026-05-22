# Dependency Vulnerability Exceptions

> Maps to SOC 2 **CC7.1** (vulnerability management). This file is the documented
> risk-acceptance register for known dependency vulnerabilities that **cannot be
> patched immediately**, with the rationale and remediation plan for each. Everything
> with a safe patch has already been fixed via scoped `pnpm.overrides`
> (see `package.json` / `pnpm-workspace.yaml`), Dependabot PRs, or `cargo update`.

_Last reviewed: 2026-05-22._

## Status summary

- **Fixed** (scoped same-major overrides): axios, fast-xml-parser, protobufjs, postcss,
  undici, fast-uri, flatted, follow-redirects, @protobufjs/utf8, @xmldom/xmldom,
  @hono/node-server, @opentelemetry/*, mermaid, next-intl, socket.io-parser, uuid,
  html2pdf.js, icu-minify, hono, next, esbuild, dompurify, tar, picomatch, minimatch,
  brace-expansion, markdown-it, ajv, diff, file-type, yaml. **+ tauri** (rust).
- **Exceptions** (below): no upstream fix, breaking-only fix, transitively pinned, or
  legacy code not on the active trunk.

## Exceptions

| Package | Eco | Severity | Why not patched | Plan / mitigation |
|---|---|---|---|---|
| **jspdf** | npm | critical/high | Fix is a 3→4 **major** bump; jspdf is transitive behind `html2pdf.js`, which may not support v4 — forcing it risks breaking PDF export (unverifiable without runtime test). | Bump `html2pdf.js` + `jspdf` together once html2pdf supports jspdf 4, with a manual PDF-export smoke test. Practical exposure is low (client-side PDF generation of the user's own content). |
| **lodash**, **lodash-es** | npm | high/med | GitHub advisory lists first-patched `4.18.0`, which **does not exist** on npm (no upstream fix in the 4.x line). | Avoid passing untrusted input to the affected functions; monitor for an upstream release; longer-term migrate off lodash. |
| **node-forge** | npm | high | Advisory first-patched `1.4.0` **does not exist** (latest is 1.3.x). | Monitor upstream; evaluate replacement. |
| **xlsx** (SheetJS) | npm | high | No patched version on the **npm** registry — SheetJS ships fixes via their own CDN, not npm. | Switch to the SheetJS CDN distribution (`cdn.sheetjs.com`) or replace the library. |
| **time** | rust | med | Transitively **pinned to `=0.3.41`** by a dependency of the desktop app; cannot bump in isolation. | Update the constraining crate, then bump `time`. |
| **glib** | rust | med | Locked to 0.18 by `gtk 0.18 → tauri 2.x`; 0.20 requires a newer gtk/tauri. | Revisit on the next tauri/gtk upgrade. |
| **pillow**, **lxml**, **PyPDF2** | pip | high/med | Live in `core/kortix-master/opencode/...` (a vendored skill) that is **not present on the `newer-kortix` trunk** — main-only legacy layout. | Reconcile at the `newer-kortix → main` merge. If retained: bump pillow/lxml; migrate **PyPDF2 → pypdf** (PyPDF2 is deprecated, no patch). |

## Cross-major residuals (lower priority)

For a few packages, only the **same-major** vulnerable window was overridden (to avoid
force-breaking consumers that legitimately need an older major). The older-major
vulnerable ranges remain and are left to Dependabot's per-package, individually-tested
PRs: `ajv` (7.x), `diff` (6/7.x), `file-type` (13–20.x), `markdown-it` (13.x),
`brace-expansion` (4.x).

## Notes

- GitHub's Dependabot **alert count is computed against the default branch (`main`)**,
  so it will not visibly drop until the `newer-kortix → main` bulk merge carries these
  lockfile changes to `main`. The active trunk no longer resolves the patched-away
  versions.
- Re-run review of this file whenever Dependabot opens new PRs or upstream fixes land.
