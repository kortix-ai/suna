output "state_bucket" { value = aws_s3_bucket.state.id }
output "lock_table" { value = aws_dynamodb_table.locks.name }
output "kms_key_arn" { value = aws_kms_key.state.arn }
output "permissions_boundary_arn" { value = aws_iam_policy.role_boundary.arn }
output "region" { value = data.aws_region.current.region }

output "backend_config" {
  description = "Secret-free values written into the generated backend.hcl for all later stages."
  value = {
    bucket         = aws_s3_bucket.state.id
    dynamodb_table = aws_dynamodb_table.locks.name
    region         = data.aws_region.current.region
    encrypt        = true
    kms_key_id     = aws_kms_key.state.arn
  }
}
