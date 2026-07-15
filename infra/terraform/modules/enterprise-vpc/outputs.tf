output "instance" {
  description = "Secret-free coordinates consumed by kortix self-host and the on-box updater."
  value = {
    name               = var.name
    account_id         = var.expected_account_id
    region             = local.region
    release_channel    = var.release_channel
    vpc_id             = module.network.vpc_id
    private_subnet_ids = module.network.private_subnet_ids
    public_subnet_ids  = module.network.public_subnet_ids
    api_domain         = var.api_domain
    frontend_domain    = var.frontend_domain
    route53_zone_id    = var.route53_zone_id

    # The one box + its stable public address
    instance_id       = aws_instance.appliance.id
    instance_role_arn = aws_iam_role.appliance.arn
    public_ip         = aws_eip.appliance.public_ip
    eip_allocation_id = aws_eip.appliance.allocation_id
    security_group_id = aws_security_group.appliance.id
    availability_zone = data.aws_subnet.appliance.availability_zone

    # Supabase runs on this same box; server-side callers (api/frontend/gateway)
    # and Caddy reach the in-box Kong at this private IP:8000 (never the public
    # URL). `kortix self-host deploy` seeds the runtime secret's SUPABASE_URL and
    # DATABASE_URL from it, so it MUST be exported here.
    supabase_private_ip = aws_instance.appliance.private_ip

    # Data plane + secrets + release breadcrumb + bundle staging
    permissions_boundary_arn = var.permissions_boundary_arn
    runtime_secret_arn       = aws_secretsmanager_secret.runtime.arn
    updater_secret_arn       = aws_secretsmanager_secret.updater.arn
    release_ssm_parameter    = aws_ssm_parameter.release.name
    artifact_bucket          = aws_s3_bucket.artifacts.bucket
    ecr_repositories         = { for name, repository in aws_ecr_repository.enterprise : name => repository.repository_url }
    operator_role_arn        = try(aws_iam_role.operator[0].arn, null)
  }
  sensitive = true
}

output "ecr_repositories" {
  value = { for name, repository in aws_ecr_repository.enterprise : name => repository.repository_url }
}

output "public_ip" {
  description = "Appliance Elastic IP; the app A records and customer allowlists pin here."
  value       = aws_eip.appliance.public_ip
}

output "app_dns_records" {
  description = "Application A records pointing at the appliance EIP."
  value       = { for domain, record in aws_route53_record.app : domain => record.fqdn }
}

output "backup_contract" {
  description = "Durability contract: encrypted EBS + hourly AWS Backup recovery points. RPO tracks the EBS snapshot cadence (~60m) and restores are whole-volume."
  value = {
    backup_vault      = aws_backup_vault.supabase.name
    snapshot_schedule = "hourly"
    rpo_minutes       = 60
    rto_minutes       = 60
  }
}
