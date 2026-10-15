output "bucket_name" {
  description = "Value for KORTIX_CAPTURE_S3_BUCKET."
  value       = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  description = "Pass to modules/ecs-api as capture_bucket_arn."
  value       = aws_s3_bucket.this.arn
}

output "queue_url" {
  description = "Value for KORTIX_CAPTURE_SQS_QUEUE_URL."
  value       = aws_sqs_queue.manifests.id
}

output "queue_arn" {
  description = "Pass to modules/ecs-api as capture_queue_arn."
  value       = aws_sqs_queue.manifests.arn
}

output "device_role_arn" {
  description = "Value for KORTIX_CAPTURE_STS_ROLE_ARN; pass to modules/ecs-api as capture_device_role_arn."
  value       = aws_iam_role.device.arn
}
