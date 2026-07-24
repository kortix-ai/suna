Session provisioning and sandbox runtime reliability

- Use shared Daytona and Platinum runtime images for normal session boots.
- Disable automatic per-project commit-specific warm image builds.
- Fix snapshot collision recovery, warm archive handling, and warm repository Git metadata.
- Preserve sandbox URLs and reset readiness clocks across session restarts.
- Add responsive Cmd+J loading feedback and clearer sandbox runtime versus accelerator status.
- Remove the missing MACHINE.md failure and legacy migration eligibility request noise.
