# Change Management Policy

> Maps to SOC 2 Common Criteria **CC8.1** — "The entity authorizes, designs,
> develops, configures, documents, tests, approves, and implements changes to
> infrastructure, data, software, and procedures to meet its objectives."

This document describes how code changes are reviewed, approved, and deployed
for the Kortix (`suna`) repository. It is the source of truth a SOC 2 auditor
will check against the actual GitHub configuration.

## Scope

All changes to application code, infrastructure-as-code, CI/CD workflows, and
database schema in `kortix-ai/suna`.

Protected branches (no direct pushes; changes land only via reviewed PR):

- `newer-kortix` — active development trunk
- `main` — release / production-target branch (protection to be enabled when
  releases cut from `main`)

## Roles

- **Author** — the engineer who opens the change as a pull request.
- **Reviewer** — an engineer, other than the author, who approves the PR. An
  author can never approve their own PR (segregation of duties).
- **Code owner** — reviewer required for sensitive paths, defined in
  [`.github/CODEOWNERS`](../../.github/CODEOWNERS).

## Standard change workflow

1. **Branch** off the protected branch for the change.
2. **Open a pull request** using the
   [PR template](../../.github/pull_request_template.md). Fill in the summary,
   testing notes, and the security & data review checklist.
3. **Automated checks** (`.github/workflows/ci.yml`) run on the PR and must pass.
4. **Peer review** — at least **one approving review** from a non-author. Stale
   approvals are dismissed when new commits are pushed. All review conversations
   must be resolved.
5. **Merge** — only when checks pass and the review requirement is met. Direct
   pushes and force-pushes to protected branches are blocked, including for
   admins (`enforce_admins`).

## Enforced controls (GitHub branch protection)

The following are configured on each protected branch and constitute the
technical enforcement of this policy:

| Control | Setting |
| --- | --- |
| Require pull request before merge | ✅ |
| Required approving reviews | 1 (non-author) |
| Dismiss stale approvals on new commits | ✅ |
| Require review from Code Owners | enabled once ≥2 code owners exist |
| Require conversation resolution | ✅ |
| Require status checks to pass | ✅ (`API typecheck`) |
| Require branches up to date before merge | ✅ |
| Block force pushes | ✅ |
| Block branch deletion | ✅ |
| Enforce on administrators (no bypass) | ✅ |

> **Operational note:** with a single code owner, required reviews still require
> a *second* person to approve (you cannot approve your own PR). Until a second
> reviewer is added, admins may be temporarily exempted by disabling
> `enforce_admins`; this exemption is itself a deviation that should be recorded.

## Emergency / hotfix changes

For urgent production fixes where a reviewer is unavailable:

1. The change still goes through a PR.
2. It may be merged with admin override **only if** the emergency is documented
   in the PR description (what broke, why it could not wait).
3. A retroactive review is requested within 1 business day and linked to the PR.

## Evidence & auditability

- Every merge has a PR with description, CI result, approver, and timestamp —
  retained in GitHub.
- Security-relevant runtime actions are recorded in the application audit log
  (`kortix.audit_events`).
- This policy is reviewed at least annually and whenever the branching model
  changes.

_Last reviewed: 2026-05-22._
