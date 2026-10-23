Every new session runs pi, shareable responses, and a weekly changelog

### New
- **Every new session runs pi.** The `pi_harness` flag and `runtime: opencode` no longer select OpenCode. A session that already runs OpenCode keeps it. OpenCode is deprecated. (#10786)
- **Share one response.** **Share response**, beside **Copy response**, publishes one finished assistant response through a public link: the response only, or the prompt and the response. Turning the link off ends anonymous access. (#10816)
- **Weekly changelog.** `/changelog` groups what went live in production by week, and each week has its own page with every change. (#10823)
- **Agent marks.** Every agent has a pixel mark on Agents cards and in agent pickers. (#10826)
- **Shopify with your own app.** **Connect** on Shopify opens a Kortix form that takes the store and the Client ID and secret of your Shopify Dev Dashboard app. Shopify no longer issues the custom app tokens the old flow asked for. (#10825)

### Improved
- **Compaction.** pi compacts early enough to leave room for the model's full answer, still compacts after it retries a failed model call, and honours a project's `compaction.reserveTokens` again; the context meter counts reasoning tokens once. (#10835, #10845)
- **Session history.** Messages that only the old transcript store held move into the session log; the daemon keeps every batch the API refuses and sends it again; capture waits for memory and runs one session at a time; the usage panel counts the whole thread. (#10827, #10837, #10829, #10793, #10791, #10783)
- **Deleted sessions are fully gone after 30 days**: the conversation, every copy (model requests and responses, prompt commands, questions, notifications, share links), the stored files and the session's branch. Sessions purged before this release lose their remaining copies too. (#10831)
- **Branch cleanup.** A session branch that fails to delete no longer stalls the sweep. (#10833)
- **Status page.** Upstream capacity errors that a fallback model absorbs no longer open an incident. (#10795)
- **Parked sandboxes.** An open tab stops polling the transcript of a sandbox that is parked. (#10820)

### Fixed
- **pi permissions.** A path rule holds for `./`, `..`, `@` and absolute paths. (#10787)
- **Web addresses.** `/dashboard` opens projects; `/login` and `/signup` open sign-in; a trailing slash or another letter case redirects to the page; an unknown path answers 404 and a malformed one 400; `/privacy`, `/terms`, `/imprint` and `/subprocessors` open the legal pages; crawlers can fetch the static assets pages need; each localized page declares its locale; the Apple app-site-association file is served as JSON; the docs touch icon loads. (#10812, #10815, #10814, #10807, #10810, #10818, #10806, #10805, #10817, #10804, #10803, #10808)
- **Sandbox versions.** The version feed caches one GitHub read, never names a prerelease as the latest stable version, and still answers when GitHub rejects the token. (#10809, #10811)
- **Marketplace.** Paging never skips or repeats an item. (#10802)
- **Scoped tokens** resolve the current project. (#10819)
- **Files.** A download with a range the file cannot satisfy answers 416 with the file size, not "storage unavailable". (#10790)
- **Agent page.** The dev-only layout switcher is gone. (#10813)

### Security
- Unexpected server errors no longer return internal details to the client. (#10785)
- Shared caches never store an authenticated API response. (#10828)
- The API and gateway serve `security.txt`, `robots.txt` and `sitemap.xml`. (#10824)
- Malformed tunnel IDs, fractional gateway day windows and invalid billing pagination are refused. (#10800, #10784, #10781)
- CodeQL and the security scan run on every push to production. (#10796)

### Internal
- Stateless sandboxes behind an operator-only flag that is off everywhere. (#10846)
- Session-log groundwork for removing the old transcript tables, CLI installation-proof refactor, local hot-reload connection leak, quieter config-release logs, log lines that keep ids out of format strings, release and incident runbooks, and test upkeep. (#10782, #10822, #10821, #10839, #10847, #10792, #10794, #10798, #10830, #10832, #10834, #10836, #10838, #10840, #10849, #10851)
