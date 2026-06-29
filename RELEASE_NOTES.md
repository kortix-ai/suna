Guided onboarding, a unified Slack panel, and tool-card fixes

**New**
- **Guided project onboarding** — new projects now open into a full-screen, step-by-step setup that walks you through connecting your tools and getting to your first run.
- **One `/kortix` Slack panel** — a single Slack command opens a unified panel with a real model picker and per-project default models.
- **Desktop auto-update** — the desktop app now updates itself, with a steadier always-on-top window.

**Fixed**
- Dead `show` tool cards no longer render a confusing "File not found" card — they're hidden when the artifact is gone.
- Stuck tool results now resolve themselves when a run finishes, instead of needing a page refresh.
- The in-sandbox terminal correctly replays your prompt again.
- AgentMail inbox-limit errors are handled gracefully instead of failing hard.
- Tighter, safer account-membership repair.

**Behind the scenes**
- Staging runs the full release gate behind Vercel SSO with the Slack identity gate enabled, and releases now go through promote only (the direct prod-hotfix path was removed).
