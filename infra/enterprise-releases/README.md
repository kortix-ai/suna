# Enterprise stable compatibility contracts

Every stable promotion requires a reviewed compatibility contract. The release
workflow refuses to infer rollback or database safety from a version number.

- `kubernetes_minor` lists the exact EKS minors certified for the artifact.
- `rollback_from` lists newer enterprise releases that may safely roll back to
  this release. Leave it empty until that exact downgrade has passed the drill.
- `migrations` lists migrations introduced relative to the preceding stable
  baseline, with the source digest and explicit rollback properties. The first
  customer-zero release may use a single reviewed `baseline` entry because
  there is no earlier installed enterprise release to roll back to.

Contracts are immutable review evidence. Add a new file for every enterprise
revision; never rewrite a contract after its TUF target has been published.
