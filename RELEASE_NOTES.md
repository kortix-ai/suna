Project transfer, embedded sessions, directory-guest invites and security updates

### New
- **Move projects between accounts.** A project can be transferred to another organization or account. (#9918)
- **Default reasoning effort per project.** Set it once in project settings. (#9935)
- **Run a session on your own machine** with a ChatGPT subscription, through kortixd. (#9754)
- **Audit activity.** See who was active in a workspace and how often, in the API, CLI and SDK. (#10604)
- **Goals** page, a session Goal button and goal health, behind the `goals` flag. (#10600)
- **Embedded sessions.** Public transcript sharing is removed; existing transcript share links are revoked. Embed the real session page instead. (#10008)

### Improved
- **Billing.** Usage is metered on every plan; only charging is gated. (#9929)
- **Model routing.** A project's Routing chain now covers every model. (#8742)
- **Model limits.** Every model reports its real context window and output limit, including custom endpoints; Codex models get their 272k window. A custom-endpoint model reads images and reasons when the endpoint supports it. (#10757, #10768)
- **Session history.** A new session reads only the session log, and an old session being converted opens its history, not an empty log. (#10722, #10728)
- **Agents and connectors.** A cleaner agent page and connector modal, catalogue favicons that recover from broken images, and one design for role dialogs. (#10490, #9924, #10702, #10382)
- **Mobile.** Simpler session sheets and tool surfaces. (#10229)
- **Keep-alive.** An open page keeps its sandbox awake for the idle window, not 2 hours. (#10026)

### Fixed
- **Invites on self-hosted instances without email.** A person your identity provider adds through SCIM can join even when their address is outside the provider's domain. The invite page offers **Continue with single sign-on**, says to ask an admin when single sign-on is not set up, and **Resend** lets that person accept. (#10707)
- **Routine wakes are silent:** no waking notice, boot pill or boot screen. (#10716)
- **Reload keeps your project**, and a sidebar click no longer opens a session's hover card. (#10720, #10721)
- **Files.** Project owners can edit and commit repository text. (#10517)
- **Projects.** Rename a project from the switcher. (#10523)
- **Panels.** ⌘I brings back the panel it hid, also from inside the Browser preview. (#10725)
- **CLI.** Remote login without a callback (its poll and approve calls get their own rate limit), service-account keys, and `connectors call` resolves the project like `connectors ls`. (#10483, #10779, #10235)
- **Sessions.** Compacting a busy session no longer shows internal diagnostics; a US-region session boots where its drives live; a daemon restart drops its env-sync trust. (#10442, #10348, #10014)
- **Apps.** Existing Apps move from `ghcr.io/get-convex` to `ghcr.io/convex` images. (#10353)
- **Connectors.** A connector failure line is split in linear time. (#10736)
- **Desktop.** The Linux AppImage builds again with electron-builder 26. (#10743)

### Security
- Dependency updates for the advisories of 2026-10-22 (Next 16.4.2, DOMPurify, Sentry, undici, Astro, Electron 42, Vitest 4, KaTeX, Caddy, Hono and others). (#10738, #10739, #10732, #10726)
- Closed a path traversal in the presentations server. (#10729)
- The repo-wide deploy role no longer holds prod grants; prod uses its own role. (#9329)
- The gateway sends browser security headers, and its public health check no longer shows operational detail. (#10750, #10749)
- Public access requests are rate-limited, device-login polling denials are uniform, and SCIM and git spec routes declare their auth. (#10753, #10773, #10755, #10754)
- The sandbox web proxy guards egress on every port, and the web app restricts browser feature permissions. (#10752, #10751)
- Pentest hardening: the marketplace catalog is cached and rate-limited, request bodies are capped at 64 MiB, every 401 names its auth scheme, OAuth client registration honours the requested client authentication, tighter CSP, signed release artifacts, and storage buckets no longer list their objects to signed-out callers. (#10748)
- Session search rejects NUL bytes. (#10775)
- A private security reporting policy. (#10756)

### Internal
- Test, CI, scanner and runbook upkeep (#10713, #10723, #10727, #10731, #10737, #10740, #10741, #10744, #10747, #10758, #10759, #10761, #10762, #10763, #10765, #10767, #10769, #10770, #10772, #10760, #10776, #7956, #10689, dependency bumps).
