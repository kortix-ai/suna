Email delivery that survives a provider outage

**Fixed**

- Transactional email — team invites, project access requests, and demo-request notifications — now goes through a chain of email providers. If one provider fails or is unavailable, the next one takes over automatically. This removes the single point of failure that delayed some emails on August 5.
- The Terms of Service link now opens the document directly instead of its containing folder.

**Internal**

- End-to-end cost tests compute gap-fill counts from their own time window, fixing a flaky check.
