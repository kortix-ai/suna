Release v0.14.13 — My Kortix teams, clearer session costs, and easier file feedback

My Kortix teams, clearer session costs, and easier file feedback

### New
- My Kortix runs agents, teams and workflows while you chat, remembers you and reuses its agents (#11240, #11255).
- Agent pages, Project administration, My Kortix, a unified Triggers list and Goals bring work into one place (#10877).
- Upload files of any size to Drive from the web, CLI and API (#11249).
- Add HTML comments and drawn feedback to artifacts, with more reliable document loading (#11196; drawing feedback commit bb8eba3).
- Session usage shows the cost of the session and the sessions it spawned (#11251).
- Background subagents report back to their parent session (#11230).

### Improved
- Mobile and desktop download pages show the shipped apps rather than mockups; mobile is prepared for its next 1.5.4 store build (#11209, #11244).
- Dev sessions and new Files use us-east, with safe file moves between regions (#11213).
- New sessions and prompts avoid refetching large repositories (#11234).
- One unversioned kortix.yaml supports older formats and deprecated keys (#11236).
- The CLI reads the session log directly and removes `sessions connect` (#11243).
- The SDK answers, compacts, runs commands and stops through session-log actions; box log reads return whole pages and show queued prompts (#11238, #11247).

### Fixed
- Escape in the chat input no longer stops a turn accidentally; press Escape three times to stop (#11210).
- Session usage lookups avoid timeouts, and model usage loads in roughly 0.1 seconds rather than up to 25 seconds on long sessions (#11197, #11219).
- Sign-in shows its welcome once; Terms change notices no longer email every user (#11217, #11220).
- A region move reports a drive deleted mid-run instead of stopping (#11222).
- Session-wide permission approval survives a closed tab, and compact no longer depends on OpenCode routes (#11221).
- The Desktop panel appears only on computers with a desktop; sleeping computers no longer add a notice above the composer (#11223, #11231).
- Reopening the session panel restores its artifact, with a centered header (#11227).
- Dev retains chunks from the last five web builds so open tabs survive deployments (#11228).
- My Kortix sessions no longer wait for a meta image build (#11241).
- CLI `chat --new` prints the reply that ends the first turn (#11245).
- Manifest healing preserves untouched lines, tool headers explain loading, and web/API edits preserve comments (#11253, #11254).
- Memory saves tolerate missing name, type or body; ask My Kortix about memory rather than opening a separate screen (#11256, #11258).

### Security
- Trivy carries the documented decode-uri-component exception consistently (commit 359828a).

### Internal
- Remove unused OpenCode daemon code and route session lifecycle, repair, question release and transcripts through Kortix routes (#11218, #11235, #11239).
- Serve session-log actions and live status from the box (#11232).
- Bake shared defaults into every Kortix image (#11233).
- Keep Telegram sequence expectations and CLI trigger help tests aligned with the product (#11191, #11226).
- Prove the kortix.yaml documentation guard detects stale documentation (#11252).
- Run dev gateway parity and :dev promotion when Terraform is skipped (#11248).
- Document retained Next.js chunks, last-ready image fallbacks and safe secret reads in zsh (#11229, #11242, #11246).
- Advance the dev version target after v0.14.12 (commit c513c05).
