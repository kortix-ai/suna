---
recorded: 2026-09-10T17:57:42Z
incident_date: 2026-09-10
commit: 798f8298b5
---
# Stop concurrent deployed suites when managed GitHub reports a secondary limit

**When:** preview and staging tests share a managed GitHub organization.
Stop content-creating runs, allow a quiet backoff interval, then retry unfinished
shards serially. A primary rate-limit budget does not prove secondary capacity.
*Near-miss:* 0.13.13 validation exhausted repository creation; preview and staging
provisioning returned 503 with GitHub's secondary-limit response.
*Enforcer:* manual serialized job reruns; TODO: a shared deployed-suite lease
and secondary-limit backoff in the managed GitHub client.
