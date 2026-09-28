---
recorded: 2026-09-15T14:45:21Z
incident_date: 2026-09-15
commit: 82dd96e754
---
# Exclude unavailable Vercel instrumentation from self-host admin console errors

**When:** asserting the admin console's own network and console errors on a self-host origin. Filter the two `/_vercel/.../script.js` 404s and their strict-MIME console messages together. *Near-miss:* v0.13.15 preview admin retry rendered Overview but failed on instrumentation served as `text/plain`. *Enforcer:* `09-admin-console.spec.ts` excludes only those exact script paths and MIME error.
