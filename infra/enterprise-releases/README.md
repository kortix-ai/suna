# Enterprise stable compatibility contracts

Every stable promotion requires a reviewed compatibility contract. The release
workflow refuses to infer rollback or database safety from a version number.

- `kubernetes_minor` lists the exact EKS minors certified for the artifact.
- `rollback_from` lists the prior published revision(s) that this release can
  be safely rolled back to. The protected promotion workflow enforces this:
  for any revision `eN` with `N > 1`, `rollback_from` MUST be non-empty and
  MUST include the immediately preceding published revision for the same
  production version — the highest existing `e<k>` (`k < N`) contract file
  already committed under this directory. Every entry must itself resolve to
  a contract file that has already been published (an existing
  `infra/enterprise-releases/<entry>.json`); the workflow fails the promotion
  otherwise. Additional predecessors, including ones from an earlier
  production version (e.g. a new version's `e1` rolling back into the prior
  version's last revision), may be listed explicitly alongside the required
  entry. The first revision of a brand-new production version (`e1`) is
  exempt from this check because there is no prior revision to name.
- `migrations` lists migrations introduced relative to the preceding stable
  baseline, with the source digest and explicit rollback properties. The first
  customer-zero release may use a single reviewed `baseline` entry because
  there is no earlier installed enterprise release to roll back to.

For the first baseline, `sha256` is the deterministic archive digest of the
canonical node-pg-migrate ledger in the exact production image source commit:

```bash
git archive --format=tar <RELEASE_SOURCE_SHA> -- packages/db/migrations | sha256sum
```

The protected promotion workflow recomputes this digest and rejects a baseline
contract that does not match the production provenance recorded on `prod`.

Contracts are immutable review evidence. Add a new file for every enterprise
revision; never rewrite a contract after its TUF target has been published.
