---
recorded: 2026-09-14T20:51:55Z
incident_date: 2026-09-14
commit: 1d22b21abf
---
# A least-privilege S3 grant that checks "does this key exist?" needs `s3:ListBucket` — MinIO root credentials never show the gap

**When:** writing an IAM policy for code that calls HeadObject/GetObject and
treats `404`/`NoSuchKey` as "not there yet". Without `s3:ListBucket` on the
bucket ARN, AWS answers a missing key with `403 AccessDenied`, so the caller
reads a normal miss as a denial. A local MinIO root user or an admin laptop
key has every permission and passes. Test IAM against the real role before
calling it verified. *Incident:* #7221 on dev; the project-snapshot producer
failed every build with `not authorized to perform: s3:ListBucket` on
`kortix-dev-project-snapshots`, so no snapshot was ever published. Sessions
stayed on Git, so there was no user impact. *Automation:* none — the dev
post-deploy check (`GET …/project-snapshot` → 200) caught it.
