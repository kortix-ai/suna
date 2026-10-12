---
recorded: 2026-10-06T13:09:01Z
incident_date: 2026-10-05
---
# Every environment shares one Daytona disk quota: read provider_events by error text before blaming the provider, and classify every quota message

**Rule:** When sessions fail with "The sandbox provider could not start this session", read `kortix.provider_events.error` for the session first: the generic copy is the classifier's fallback, and the provider's real text is stored there and in `session_sandboxes.metadata.lastProvisioningError`. Add every provider quota or limit message to `classifySandboxProvisioningFailure`, so the user sees the cause. Remember that dev, staging, preview, and prod share ONE Daytona organization and its disk quota (40,000 GiB, 40 GiB per sandbox): load in any environment can stop sessions in every environment.

**Trigger surface:** a "could not start this session" report; pinning a project to Daytona (`metadata.default_sandbox_provider`); a workload that creates hundreds of sessions a day; editing `apps/api/src/platform/services/sandbox-provisioning-error.ts`.

**Incident:** 2026-10-05 20:00Z to at least 2026-10-06 08:54Z, prod. A project pinned to Daytona ran an agent workload that created 490 to 1,363 sessions a day. Daytona answered "Total disk limit exceeded. Maximum allowed: 40000GiB." 543 times in 16 hours, plus 226 `ThrottlerException: Too Many Requests`. On 2026-10-06, 398 of 490 sessions on that project failed. The measured non-archived disk was 45,725 GiB: 956 prod sandboxes waited in `archiving` (36,900 GiB), about 200 of them since September, and 151 prod sandboxes were in `error`. Failover never ran: a project pin locks the provider. Every user saw "could not start this session. Try again." Other accounts were not affected: prod routes them 100% to Platinum.

**Enforcement:** `sandbox-provisioning-error.test.ts` ("names a full provider storage quota as the cause") and `stopped-wake-result.test.ts` (an already-failed session re-classifies on read). None yet for the quota itself: alert on the Daytona organization's non-archived disk, and on `provider_events` error rate per provider.
