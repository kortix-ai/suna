# ── Project snapshot object store (S3 config provider) — previews ─────────────
#
# One bucket for every pull-request preview; each preview writes under its own
# `pr-<n>/` prefix and the objects expire after 7 days. A preview API runs
# inside a sandbox from the self-host Compose bundle and has no AWS identity of
# its own, so the deploy job assumes kortix-gha-preview-deploy (12 h session,
# max_session_duration on the role) and forwards the TEMPORARY credentials into
# the preview API through the runtime-secret allowlist
# (tests/src/core/preview-stack.ts). When that session expires the producer's
# uploads and the presigned GETs stop working and sessions fall back to the
# Git path until the preview is redeployed. No long-lived credential exists.
# docs/runbooks/project-snapshot-s3.md#aws

module "project_snapshots" {
  source          = "../../modules/project-snapshots-bucket"
  name            = "kortix-preview-project-snapshots"
  expiration_days = 7
  tags            = local.tags
}

# The producer's uploads and the presigned GETs it mints, on the objects only.
resource "aws_iam_role_policy" "github_preview_snapshots" {
  name = "preview-project-snapshots"
  role = aws_iam_role.github_preview_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "SnapshotObjects"
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject"]
      Resource = "${module.project_snapshots.bucket_arn}/*"
    }]
  })
}

output "project_snapshot_bucket" {
  description = "Value the preview stack sets as KORTIX_PROJECT_SNAPSHOT_S3_BUCKET."
  value       = module.project_snapshots.bucket_name
}
