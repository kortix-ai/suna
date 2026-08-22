# Cryptographic Key Rotation Standard

Owner: Security and Infrastructure  
Effective date: 2026-07-17  
Review cadence: Annual and after material cryptographic or access changes

## Scope

This standard covers Kortix-managed AWS KMS keys used for encryption and
digital signing. AWS-managed keys follow the provider's managed lifecycle.
Application credentials and IAM access keys follow the separate secrets and
credential-rotation process.

## Cryptoperiods

- Customer-managed symmetric KMS encryption keys use AWS automatic rotation
  with a maximum 365-day rotation period.
- Customer-managed asymmetric signing keys are rolled over at least annually.
  AWS KMS does not support automatic rotation for asymmetric keys, so rollover
  uses the controlled replacement procedure below.
- A key is rotated immediately, regardless of age, when compromise is known or
  suspected, an authorized user with key-administration access leaves or
  changes role, a cryptographic weakness affects the key, or the Security owner
  directs emergency rotation.

## Symmetric KMS enforcement

Terraform-managed encryption keys set `enable_key_rotation = true`. Quarterly
control sampling runs `aws kms get-key-rotation-status` for every enabled
customer-managed symmetric key and records `KeyRotationEnabled`,
`RotationPeriodInDays`, and `NextRotationDate`. A disabled or overdue result is
remediated as a security finding.

## Asymmetric signing-key rollover

1. Open an approved production change identifying the existing key, role,
   consumers, and rollback window.
2. Create a replacement KMS asymmetric signing key with the same key spec and
   least-privilege policy. Never export private key material.
3. Publish the replacement public key or trust metadata alongside the current
   key. Keep both keys trusted during the overlap window.
4. Sign and verify a non-production artifact, then promote through staging and
   the reviewed production release path.
5. Switch signing to the replacement key and verify consumer acceptance,
   signature validation, and CloudTrail activity.
6. Remove the previous key from active signing only after all supported
   consumers trust the replacement. Disable it for the rollback window, then
   schedule deletion under the approved change.
7. Attach the change, verification output, key IDs, activation time, and
   retirement time to the annual evidence record.

Emergency rollover follows the same verification steps with an expedited
change record; consumer trust is updated before the suspected key is disabled
whenever doing so does not prolong active compromise.

## Audit trail

CloudTrail records KMS creation, policy, enable/disable, signing, rotation, and
deletion-scheduling events in the multi-region `management-events` trail.
Evidence is retained in Drata with the annual rotation-status sample and the
most recent asymmetric rollover change record.
