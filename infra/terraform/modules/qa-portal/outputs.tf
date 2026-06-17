output "bucket_name" {
  description = "S3 bucket holding QA results + reports."
  value       = aws_s3_bucket.this.id
}

output "bucket_arn" {
  value = aws_s3_bucket.this.arn
}

output "role_arn" {
  description = "IRSA role ARN — put on the portal ServiceAccount's eks.amazonaws.com/role-arn annotation (envs/qa/values.yaml serviceAccount.roleArn)."
  value       = aws_iam_role.portal.arn
}

output "role_name" {
  value = aws_iam_role.portal.name
}

output "dns_record_hostname" {
  description = "FQDN of the qa record when Terraform manages DNS (empty otherwise)."
  value       = var.manage_dns_record ? module.dns[0].record_hostnames["qa"] : ""
}
