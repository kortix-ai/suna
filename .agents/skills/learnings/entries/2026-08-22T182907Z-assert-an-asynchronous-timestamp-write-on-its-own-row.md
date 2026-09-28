---
recorded: 2026-08-22T18:29:07Z
incident_date: 2026-08-22
commit: ba1ab9c581
---
# Assert an asynchronous timestamp write on its own row

**When:** proving that one request advances a row timestamp while asynchronous
lifecycle work can update sibling rows. Compare the target row before and after,
or compare two fields written by the same statement. Do not infer the write from
relative list order. *Near-miss:* release gate run 32588846407 failed `SESS-18`
twice after a later sandbox transition advanced the older session's `updated_at`.
*Enforcer:* `SESS-18` requires adoption `updated_at == last_activity_at` and
`updated_at > created_at` on the adopted row.
