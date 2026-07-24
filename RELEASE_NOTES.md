Session provisioning, sandbox runtime, and release reliability

- Use shared Daytona and Platinum runtime images for normal session boots.
- Disable automatic per-project commit-specific warm image builds.
- Fix snapshot collision recovery, warm archive handling, and repository Git metadata.
- Preserve sandbox URLs and reset readiness clocks across session restarts.
- Add responsive Cmd+J loading feedback and clearer runtime versus accelerator status.
- Remove the missing MACHINE.md failure and legacy migration eligibility request noise.
- Refactor release session fixtures to reuse managed repositories, bound SESS-2 to one session, and enforce teardown.
- Retry transient runtime-readiness failures without leaving failed sessions.
- Enforce account concurrent-session overrides consistently across API tasks.
- Correct compute pricing calculations and billing copy.
- Promote verified staging source d4f665abe258513bb1f48a6606f59c48dbfac835; staging RUN-8 and SESS-2 passed 2/2.
