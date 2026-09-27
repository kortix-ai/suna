---
recorded: 2026-09-16T13:12:56Z
incident_date: 2026-09-16
commit: fdd688ac47
---
# Exercise populated identity-provider defaults

Azure's configured default mappings include phone numbers, addresses, preferred language,
and enterprise department, employee number, and manager. Testing users with empty optional
fields hid unsupported-attribute failures. The strict SCIM parser returned 400 as soon as
those fields were populated, rejecting the entire provisioning request.

Validate the provider's actual mappings with populated values before declaring synchronization
healthy. Keep discovery schemas, create payloads, filtered PATCH paths, removals, and read-back
responses consistent. SCIM-15 and user-profile.test.ts enforce this contract.
