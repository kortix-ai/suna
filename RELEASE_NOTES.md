One connector catalog, agent-led onboarding, and Apps that replace monitors

### New
- **One connector catalog.** **Customize → Connectors** is one catalog for every project, with no flag: Kortix's own apps, the MCP, OpenAPI and GraphQL servers of the integrations.sh registry, and the connectable Composio apps. Each app shows once, with every way to connect it, best first. Slack, Microsoft Teams, Email, Telegram and Computer are type **Kortix** and have their own **Channels** tab. Email runs on Resend. (#10866)
- **Agent-led onboarding.** A new account's first project opens on "Your first chat with Kortix" instead of the three-step setup wizard; the onboarding agent researches the company, asks "Is this you?", and sets up private memory and the company workspace. (#10878)
- **Kortix Drive on by default.** Every project that never turned Volumes off gets Files: a private folder per person and the shared Company folder. New sessions mount `/drives/me` and `/drives/company`. (#10878)
- **Apps replace the monitor box.** An App can start agents with events (`type: app` triggers), and a trigger can call an App path with no agent and no session. Schedules accept `every: 5m` (60 s minimum) and one-off runs an App schedules for itself. The Apps page lists background Apps in a **Background** list with an overview. A `type: monitor` trigger is refused with a pointer to `type: app`. (#10876, #10898)
- **Policy sets.** A connector profile keeps its base rules and gains named rule sets; `kortix.yaml` gives each agent a set per connector, so one sign-in serves read-only and sending agents. (#10888)
- **Join requests in one table.** Account owners approve or decline project join requests from the members table, with a "Needs approval · N" badge in **Settings → Projects** and an access-requests card on the project home. (#10907)
- **Change requests in the session panel.** A session lists its change requests below the side-panel cards; a row opens the request and jumps to its turn. (#10894)
- **Behind flags, off by default:** Artifacts, shared docs and HTML pages from Files with a gallery, history, links, a live card in the chat and PDF export (`artifacts`) (#10842, #10863, #10874, #10881, #10882, #10884, #10896, #10897, #10902, #10862); channels, DMs, private channels and shared memory (`project_channels`) (#10893); shared session folders in the sidebar (`session_groups`) (#10946).

### Improved
- **New projects start on kortix.yaml v3.** (#10931)
- **Review.** An output opens in a dialog with its files, and bulk approve works on outputs. (#11039)
- **Sidebar.** Apps and Customize hover cards open an App or a tab in one click. (#11051)
- **Sub-agents** run codemode scripts when their agent sets codemode. (#10986)
- **Email channel.** Web and mobile show an Email pill on an email channel message. (#11055)
- **Apps look clean by default.** The kortix-design skill gives every App a default UI, and `/` on the home screen lists Kortix skills. (#11040)
- **kortix.yaml is the source of truth** for everything it declares: App settings, connector auth secrets, template entrypoints and the project name commit to the file first, and a sync applies them back. Deleting an App removes its block from the file. (#10883, #10885)
- **Connectors.** Installing a way twice returns the existing profile; a failed MCP or GraphQL tool call answers `ok: false`; the connector page shows one status and its rule sets; read tools show as read; installing a way twice always answers its oldest profile. (#10901, #10906, #10972)
- **Connector sign-in** keeps the agent's open question open, and a connect link shows the Kortix connect card in the chat and on `/connect`. (#10886, #10891)
- **Telegram and Email** share one conversation core: `/new` followed by a message starts the session at once, the agent's questions reach the chat, a failed run or start tells the chat what to do, received mail survives a crash or an inbox move, an inbox allow-list reads the real sender, Telegram shows the agent's questions as buttons (posted only as the agent's own connector call would, and removed when the chat answers another way), a Telegram message shows in the user's bubble like Slack and Teams, and Telegram's allowed users show as cards with a Wants access list; agent questions in every chat run through one shared core, a question tap in Slack, Teams or Telegram answers through one path, Telegram's allowed users and access requests share one channel access model, and a deleted project's channels go silent and release the bot. (#10920, #10945, #10954, #10955, #10994, #10998, #11007, #11005, #11015, #11030, #11047, #11052, #11053, #11054)
- **Composio event triggers** are named Composio everywhere; connector events stay behind the `event_triggers` flag (on by default for a day, then off again). (#10904, #10880, #10903, #10905)
- **Marketing site** revamped and translated into every supported language and rebuilt on one layout; eight pages removed with permanent redirects; `/changelog` shows each week's written summary and links its pull requests; marketplace grids and project cards share one design. (#10912, #10919, #10892, #10995, #11016, #10931, #11027, #11058)
- **Session list.** A session you create or rename shows in the next list read, on every API replica. (#10948, #10951)
- **Mobile.** The switcher tab is called **Accounts**. (#10942)
- **Terms.** Kortix may list a signed-up customer's organization by name and logo. Every user with an email gets the Terms notice within about 41 hours of this release. (#11004, #11012, #11017)
- **Sessions.** A booting session shows the chat skeleton and real Terminal, Browser and Files cards. (#10985)
- **LLM gateway.** Every answer names the requested and the serving model; usage estimates are kept apart from charges. (#10988, #10977)

### Fixed
- **Session history.** The merge pass finishes on sessions over the capture cap, including sessions with hundreds of sub-agent runs, and restoring a session over the cap keeps the model's context. (#10928, #10957, #11013)
- **Sandbox boots.** A template build on one provider no longer stalls boots on another; a running sandbox reports its real image. (#10899, #10932)
- **Fix with agent** recovers changes in the session they came from. (#10895)
- **Files.** One header in the file preview; a raw directory read answers file-not-found; repository reads refuse NUL paths; a file write without a JSON body is refused. (#10875, #10855, #10854, #10869, #10958)
- **kortix.yaml** with a missing Git ref answers `409 git_ref_not_found` with recovery steps, never a permissive fallback. (#10940)
- **Sign-in.** The email code boxes show at once on the check-your-email step; "Connect your computer" keeps its project through the project choice; the CLI device login page spaces the code field and button. (#10868, #10944, #11046)
- **Account deletion** of a legacy personal account completes. (#10929)
- **Projects.** Artifacts move with a project transfer; project email search finds users first. (#10947, #10889)
- **API errors.** A validation 400 lists at most 20 issues; a database error never returns its query; list routes and the marketplace refuse an out-of-range limit or offset; rate-limit headers say when the bucket refills; a mistyped gateway stream or token cap is a 400 that names the field; a project delete answers `deleted: true`; the public AI index reads its limit as decimal digits only. (#10950, #10949, #10962, #10964, #10992, #10987, #10989, #11009)
- **Drive.** A transient storage read error is retried. (#11038)
- **Runtime recovery** skips a runtime that was removed on purpose. (#11035)
- **Connector sweep** downloads a repository again only when its default branch moved. (#11036)
- **Runtime.** Codemode-only output renders again; the agent tunnel survives a browser opener that fails to start. (#10850, #10873)
- **Artifacts.** Doc autosave never reports a conflict against your own saves. (#11056)
- **PDF viewer.** Copy handles a browser that denies clipboard access. (#10961)
- **Change requests.** A merge marks the open requests whose commits it carried. (#10991)
- **Stateless sandboxes.** An idle box with a volume stays until Platinum reports the volume saved. (#10978)
- **Display.** HEIC images decode under the strict CSP; diagram arrowheads stay visible in both themes; read-only permission checks retry at the edge. (#10981, #10976, #10983)

### Security
- The API connects to the database over TLS, and Wasabi is listed as a subprocessor. (#10934)
- Dependency advisories fixed: nodemailer, zod 4, node-forge, undici, body-parser, fast-uri, postcss-selector-parser, happy-dom, pypdf, chi, qs, golang.org/x/net and go-jose. (#10952, #10936, #10968, #10996, #11000, #11070). seroval, re2js, systeminformation and @hono/node-server are on patched versions.
- Link previews and inbound email text strip markup completely, so nested or double-escaped input cannot rebuild a tag. (#10968)
- A single-file read checks access on the exact path Git reads and refuses root aliases. (#10960, #10959)
- An agent cannot turn a revoked connector account back on. (#11001)
- The image tool's error parser runs in linear time, and the presentation index escapes names and titles. (#11049)
- The edge sends security headers by default and publishes `security.txt`; the Platinum webhook ingress answers 404 unless its signing secret is configured. (#10938, #10935, #10937)

### Internal
- Better Stack tracks sandbox boot and time to first token from an hourly canary and from real traffic. (#10927)
- Added and removed within this release, so not shipped: a native Shopify connector and a drone demo. (#10843, #10930, #10853, #10856)
- Print-ready brand files: playing cards, chips, flags, posters, mugs, mats, totes, tees, stickers and pins. (#10864, #10865, #10867)
- Refactors, gateway image build fixes, release-suite upkeep, docs and runbooks. (#10908, #10909, #10910, #10911, #10913, #10914, #10915, #10916, #10941, #10943, #10917, #10918, #10861, #10857, #10858, #10872, #10879, #10887, #10890, #10900, #10933, #10956, #10965, #10970, #10971, #10973, #10975, #10979, #10980, #10984, #10993, #11002, #11003, #11006, #11008, #11010, #10999, #11019, #11024, #11044, #11037, #11041, #11057, #11059, #11061, #11064, #11067, #11073, #11074, #11077)
