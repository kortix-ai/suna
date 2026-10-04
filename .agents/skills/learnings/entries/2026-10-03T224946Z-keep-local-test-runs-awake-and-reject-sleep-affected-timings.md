---
recorded: 2026-10-03T22:49:46Z
incident_date: 2026-10-03
---
# Keep local test runs awake and reject sleep affected timings

**Rule:** Keep long local test runs awake. On macOS, use `caffeinate -i pnpm test` or attach `caffeinate -i -w <owned-runner-pid>` to a verified runner. Do not change another session's power settings or processes. Reject timings from runs interrupted by system sleep. Retain failed results and rerun affected checks after the environment is stable.

**Trigger surface:** Running the repository test gate or comparing local test performance on a laptop.

**Incident:** On 2026-10-03, a full local run on `99e35ca1cd` overlapped repeated macOS deep-idle sleep and wake events. Power logs confirmed maintenance sleep. Tests exceeded wall-clock deadlines, and some reported durations differed from elapsed time. The run also had assertion failures whose causes remain unclassified. A job-scoped keep-awake process was attached after the core failures. Those failures remain failures; the process does not establish a passing gate.

**Enforcement:** The existing test runner rejects failed or interrupted lanes, and the pre-push hook rejects a red attestation. No automatic sleep detector exists. Verify the owned `caffeinate` command and inspect `pmset -g log` when deadlines jump. A keep-awake process does not prevent an explicit sleep or a closed lid.
