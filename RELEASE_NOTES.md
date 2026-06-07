Editable connectors, hibernating sandboxes, and sandbox-preview auth fixes

**New**
- Connectors: edit a connection's configuration after setup, plus a broad connectors UX overhaul.
- Sandboxes now hibernate instead of being destroyed, and resume in place — faster to pick work back up.
- New MDX blog, launching with the flagship Kortix article.
- The CLI now tells you when a newer release is available.

**Improved**
- Cleaner project tab bar and a modernized share dialog.
- The collapsed project sidebar rail now expands when you click the logo or Sessions.
- Refreshed landing-page SEO metadata.

**Fixed**
- Browser auth now works in sandbox previews (same-origin /supabase proxy; relative BACKEND_URL handled correctly).
- Sandbox previews are now transparent to upstream framing and CSRF checks.
- Resolved a migration heartbeat index ordering bug and version collisions.
