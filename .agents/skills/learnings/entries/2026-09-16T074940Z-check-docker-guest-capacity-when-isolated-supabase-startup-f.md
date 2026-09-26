---
recorded: 2026-09-16T07:49:40Z
commit: c43597b049
---
# Check Docker guest capacity when isolated Supabase startup fails

**Incident (2026-09-16, PR #7295):** a new worktree exhausted Docker's disk
while downloading Supabase images. Ten stacks then exhausted the VM's 8 GB
memory. PostgreSQL reported `No space left on device`; Docker recorded OOM
kills. Host disk capacity did not describe the guest's available capacity.

**Rule:** inspect Docker disk usage and VM OOM logs before retrying startup.
Remove only verified unused, downloadable image caches. Preserve database
volumes. Stop the current task's optional Studio and metadata containers before
starting another stack. Obtain authorization before stopping other tasks.

**Enforcement:** Docker rejects removal of an image used by a container without
force. Use ordinary `docker image rm`, never forced removal or volume pruning.
The local runner requires working Supabase and real HTTP assertions before it
reports success; `SEC-30` passed after this recovery.
