# Apps AWS Lightsail hosting

This module provisions the shared AWS resources for the optional Kortix Apps
AWS Lightsail Container Services backend.

It creates:

- One private, versioned, KMS-encrypted S3 bucket for short-lived build contexts.
- One immutable, scan-on-push, KMS-encrypted ECR repository for deployment images.
- One privileged CodeBuild project for Docker builds.
- One KMS-encrypted CloudWatch log group with 365-day retention.
- One rotating customer-managed KMS key shared by those three resources.
- One least-privilege policy document for the Kortix API ECS task role.

The API task can start and inspect CodeBuild jobs. It can manage only the
environment's S3 prefix and ECR repository. Lightsail Container Services does
not support resource-scoped IAM for all required actions, so those actions use
`Resource = "*"`. Resource names and tags contain the Kortix environment.

The environment root passes these outputs to `modules/ecs-api`:

- `KORTIX_APPS_LIGHTSAIL_ENABLED=true`
- `KORTIX_APPS_AWS_REGION`
- `KORTIX_APPS_BUILD_BUCKET`
- `KORTIX_APPS_ECR_REPOSITORY_URI`
- `KORTIX_APPS_CODEBUILD_PROJECT`

The API uploads one build context, starts CodeBuild, pushes an immutable
deployment image, and deletes the build context in a `finally` path. S3 also
expires current contexts after two days and noncurrent versions after one day.
ECR expires only untagged interrupted-build layers automatically.

The database-aware Apps hosting reaper owns tagged-image and orphan-service
deletion. It fails closed when it cannot load the protection set. It protects
nonterminal deployments, current runtimes, recent runtimes, and the ten newest
ready rollback images for every live App.

Lightsail stop deletes the Container Service. The next authorized App request
recreates it from the retained immutable image. Direct Lightsail origins require
the runtime-specific `X-Kortix-Origin-Token`; the Kortix proxy injects it.

Run validation from this directory:

```sh
terraform init -backend=false
terraform fmt -check
terraform validate
```
