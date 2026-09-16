output "bucket_name" {
  description = "Value for KORTIX_PROJECT_SNAPSHOT_S3_BUCKET."
  value       = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  description = "Pass to modules/ecs-api as project_snapshot_bucket_arn to grant the API task role read/write on the objects."
  value       = aws_s3_bucket.this.arn
}

output "bucket_regional_domain_name" {
  description = "Host presigned URLs resolve to (bucket.s3.<region>.amazonaws.com)."
  value       = aws_s3_bucket.this.bucket_regional_domain_name
}

output "accelerate_domain_name" {
  description = "Host presigned URLs resolve to when transfer_acceleration is on (bucket.s3-accelerate.amazonaws.com); null otherwise."
  value       = var.transfer_acceleration ? "${aws_s3_bucket.this.bucket}.s3-accelerate.amazonaws.com" : null
}
