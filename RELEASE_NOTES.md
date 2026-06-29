Refreshed marketing site, new blog, and default-agent connector fixes

Improved
- Refreshed marketing site: a new Company-OS landing page with a Web / Slack / Teams / Mobile / CLI / SDK surface switcher and an interactive "your company, as files" explorer, a revamped enterprise hero, and a single "Request demo" flow across the site.
- New blog: rebuilt as data-driven React pages (replacing MDX) with branded post covers, plus comparison write-ups (Claude Cowork; OpenClaw + Hermes; ChatGPT / Claude / Grok) covering bring-your-own-model cost and shared-vs-siloed work.
- The mobile app download preview now shows real app screenshots instead of a placeholder mockup.
- Cleaned up page titles and metadata so the title bar no longer repeats "Kortix".

Fixed
- Default-agent sessions now see their connectors. Sessions running as the default agent were getting an empty connector grant, which hid shared Slack channel and computer connectors — they now resolve correctly.
- Install-based connectors (Slack channel, computer) no longer show "connector not found" in the dashboard connector settings; they fall back to the live connector record.
- The Agent Computer Tunnel is now a regular connector: a connected machine shows up as a connector automatically, without needing an experimental flag.
