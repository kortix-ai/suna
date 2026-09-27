---
recorded: 2026-09-15T07:20:26Z
incident_date: 2026-09-15
commit: c22035d0b3
---
# Budget a real cold image build before declaring session readiness broken

**When:** setting deployed session flow deadlines. Include the provider's measured cold image-build duration and subsequent runtime steps. *Near-miss:* the v0.13.15 preview built four Daytona images in 400–439 seconds, while `SESS-25`, `RUN-9`, `SESS-24`, and `SESS-10` stopped after 240–310 seconds. *Enforcer:* the two session flow helpers allow 540 seconds for readiness, and those flows declare a larger total budget.
