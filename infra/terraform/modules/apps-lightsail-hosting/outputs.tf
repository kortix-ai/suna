output "build_bucket" {
  value = aws_s3_bucket.build_contexts.id
}

output "ecr_repository_uri" {
  value = aws_ecr_repository.apps.repository_url
}

output "codebuild_project" {
  value = aws_codebuild_project.apps.name
}

output "api_task_role_policy_json" {
  value = data.aws_iam_policy_document.api_task.json
}
