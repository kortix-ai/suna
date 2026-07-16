output "public_ip" {
  description = "The box's stable Elastic IP. Point your own DNS here if var.zone_id was left empty."
  value       = aws_eip.this.public_ip
}

output "instance_id" {
  value = aws_instance.this.id
}

output "data_volume_id" {
  description = "The EBS volume backing /var/lib/docker (all Docker volumes, incl. Postgres). delete_on_termination = false — it outlives the instance."
  value       = aws_ebs_volume.data.id
}

output "dashboard_url" {
  value = "https://${var.domain}"
}

output "api_url" {
  value = "https://${local.api_domain}"
}

output "dns_managed_by_terraform" {
  description = "Whether Terraform created the Route53 A records (true when var.zone_id was set)."
  value       = var.zone_id != ""
}

output "ssm_connect_command" {
  description = "Connect to the box with no SSH key and no open SSH port."
  value       = "aws ssm start-session --target ${aws_instance.this.id}"
}

output "post_apply_next_steps" {
  description = "What to do after `terraform apply` finishes — secrets are deliberately NOT Terraform inputs."
  value       = <<-EOT
    kortix self-host is provisioning on ${aws_eip.this.public_ip} (this takes a
    few minutes on first boot — Docker install, image pulls, ACME cert issuance).

    ${var.zone_id != "" ? "DNS: Terraform created these Route53 A records (nothing left to do) ->" : "ACTION NEEDED — DNS was NOT configured by Terraform (var.zone_id was left empty). Create these exact records with your DNS provider before ACME can issue a cert:"}
        Type  A
        Name  ${var.domain}
        Value ${aws_eip.this.public_ip}

        Type  A
        Name  ${local.api_domain}
        Value ${aws_eip.this.public_ip}

    Secrets (sandbox provider key, managed git PAT, SMTP, ...) are NOT
    Terraform inputs by design — set them once the box is up:

      aws ssm start-session --target ${aws_instance.this.id}
      sudo kortix self-host configure --instance ${var.instance_name}
      # or non-interactively:
      sudo kortix self-host secrets set --instance ${var.instance_name} DAYTONA_API_KEY=...
      sudo kortix self-host start --instance ${var.instance_name}

    Then open the dashboard at https://${var.domain} -> Settings -> Git (connect
    a GitHub App or PAT) and Settings -> Model (connect your own model key,
    BYOK) to finish setup.

    Updates: the in-compose auto-updater keeps this box current on the
    ${var.kortix_channel} channel (auto_update=${var.auto_update}), applying
    new versions with zero downtime on its own daily schedule — re-running
    `terraform apply` does NOT redeploy the app; it only touches the AWS
    resources (instance, volume, DNS, snapshots).

    Backups: EBS snapshots of the data volume run every ${var.backup_interval_hours}h,
    keeping the last ${var.backup_retention_count}.
  EOT
}
