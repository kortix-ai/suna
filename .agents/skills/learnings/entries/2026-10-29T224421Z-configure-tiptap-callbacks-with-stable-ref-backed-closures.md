---
recorded: 2026-10-29T22:44:21Z
incident_date: 2026-10-29
---
# Configure Tiptap callbacks with stable ref-backed closures

**Rule:** Configure callback closures when creating each Tiptap extension. Read the latest handler through a component-owned ref. Do not assign to `extension.options`: its getter returns a new object. Test the mounted consumer and actual DOM events, not only a directly constructed plugin.

**Trigger surface:** Wiring React callbacks or keyboard handlers into a Tiptap extension that survives prop changes.

**Incident:** Section 5 Chromium verification found that clicking a comment highlight did not focus its thread. DocEditor assigned `extension.options.onFocus` in an effect, but that changed a temporary object. The same pattern discarded the slash-menu keyboard handler. Direct plugin tests passed because they supplied callbacks without mounting DocEditor.

**Enforcement:** `doc-editor.wiring.test.tsx` mounts actual React DocEditor and Tiptap instances. It verifies read-only pointer and keyboard activation, refreshed callback props, two-editor isolation, no Markdown writes, and actual slash-menu keyboard navigation. Both cases fail with the discarded options assignments.
