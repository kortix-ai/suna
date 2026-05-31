output "certificate_arn" {
  description = "ARN of the validated certificate (safe to attach to a listener)."
  value       = aws_acm_certificate_validation.this.certificate_arn
}
