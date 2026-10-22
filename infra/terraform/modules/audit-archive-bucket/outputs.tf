output "bucket_name" {
  description = "Value for AUDIT_ARCHIVE_BUCKET."
  value       = aws_s3_bucket.audit_archive.bucket
}

output "bucket_arn" {
  description = "Pass to modules/ecs-api as audit_archive_bucket_arn to grant the API task role write/read on the archive."
  value       = aws_s3_bucket.audit_archive.arn
}

output "kms_key_arn" {
  description = "Pass to modules/ecs-api as audit_archive_kms_key_arn. The task role needs GenerateDataKey/Decrypt on it."
  value       = aws_kms_key.audit_archive.arn
}
