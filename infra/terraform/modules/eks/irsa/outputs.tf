output "role_arn" {
  description = "ARN to put on the ServiceAccount's eks.amazonaws.com/role-arn annotation."
  value       = aws_iam_role.this.arn
}

output "role_name" {
  value = aws_iam_role.this.name
}
