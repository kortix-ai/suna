Telegram question buttons, steerable agents in the terminal, and free-plan session fixes

### New
- Continue full-context sessions from a searchable record instead of a summary (#11428).
- Set up event-driven automations with filters, per-item sessions, caps, dry runs and review (#11430).
- Build event sources as watcher Apps, managed by My Kortix (#11440).
- Apply Files storage limits per project and account, with storage billed in credits (#11435).
- Answer agent questions with Telegram buttons, including several questions at once (#11469).
- See and steer agents, workflows and messages in the terminal interface (#11476).

### Improved
- Ask for a session's box up to 1.6 seconds sooner in large projects (#11419).
- Avoid re-sampling every cron trigger on each connector call (#11427).
- Show all sidebar navigation rows directly, without More or Customize sidebar (#11439).
- Help agents understand their microVM, desktop and persistent installs (#11443).
- Pause triggers that can never run and notify their owners (#11477).
- Limit model requests per credential at the LLM gateway, as the API already does (#11509).

### Fixed
- Restore even home-page pillars and keep the header switcher clear of Pricing (#11420).
- Stop Settings and Drive from showing a spurious “Not found” toast (#11423).
- Let sessions start when a Files folder cannot mount (#11421).
- Restore session logs when a box wakes before its session lease (#11434).
- Rename the mobile schedules page to Trigger (#11433).
- Hide unlaunched Chrome surfaces to prevent missing-route errors (#11436).
- Match the daemon's Bun version to lockfile v3 (#11437).
- Count every drive's real usage toward Files limits and explain refusals (#11459).
- Allow free-plan sessions to start and show failed-start errors (#11463).
- Enable My Kortix unless explicitly disabled in kortix.yaml (#11464).
- Prevent file listings from restarting the daemon on Bun 1.4 (#11467).
- Keep keyboard focus in terminal chat input and copy dragged text selections (#11470).

### Security
- Return consistent 400 responses for malformed gateway messages on every route (#11455).
- Pin sandbox-proxy authorization parity in regression coverage (#11471).
- Trim long session start errors in linear time (#11490).

### Internal
- Regenerate the learnings index without duplicate entries (#11424).
- Keep database script-private declarations local (#11429).
- Prepare the next development version, 0.14.15 (88b3618).
- Document boot-time lease-race retries (#11438).
- Mark Goals as work in progress in feature flags (#11441).
- Correct watcher App /tick guidance to use POST (#11442).
- Update session-log switch-gap coverage for context records (#11448).
- Restore summary fixtures in summary-context mode (#11447).
- Refresh the generated UI stylesheet (#11449).
- Monitor worker CPU with SNS alerts (#11452).
- Consolidate the Kortix skill list for Chrome grants (#11453).
- Remove five apps-api cleanup leftovers (#11454).
- Update nightly session-log expectations for context-record capabilities (#11457).
- Correct box-disk SQL, usage-audit labels, storage-charge classification and a file race in release checks (#11461).
- Align billing-tab tests, UI skill exports and the English UI catalog (#11465).
- Keep the GOLD-1 agent from committing before the host's commit-push step (#11472).
- Document generated-file refreshes on staging fixes and runner bind-failure handling (#11479).
- Make the goal wake-cap test independent of the UTC hour (#11515).
- Document cancelling runs still queued on the old runner label after a runner swap (#11512).
