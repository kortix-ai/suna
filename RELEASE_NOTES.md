Connector-aware sessions, project icons, and sandbox reliability

**New**
- Sessions can require connectors up front: select a connector for a session before it is connected, and when a prompt needs a connector that is not connected yet, the session pauses with a connect card instead of failing.
- Project icons: pick an emoji or a named glyph for each project.
- When an app preview stops or fails to load, you can send it straight to the agent to fix.
- Markdown files with frontmatter now render their metadata.

**Improved**
- The project session list was rebuilt as a cleaner everyday list.
- Model management shows which models are enabled for a project, and the Manage models tab counts them correctly.
- Error screens include one-click copy so you can report exactly what went wrong.
- The sidebar merges the Kortix mark and project switcher into one control, with layout and hover fixes.
- Sandbox capacity problems surface clear retry diagnostics instead of failing silently.

**Fixed**
- New signups land directly in their project instead of the project list.
- E2B sandboxes: template builds route through the self-host domain, concurrent builds settle correctly, build uploads stream reliably, and permanent sandbox removal is bounded.
- The file viewer no longer errors when a file is missing from the repo.
- Self-hosted installs can configure the API memory ceiling.
- Console noise from Android WebView is filtered out of session logs.
- Release pipeline: a stalled dark-region replica can no longer hold back a release, which had left recent releases without their published notes.
