output "instance" {
  description = "Secret-free coordinates consumed by kortix self-host and the platform stage."
  value = {
    name                     = var.name
    account_id               = var.expected_account_id
    region                   = local.region
    release_channel          = var.release_channel
    cluster_name             = module.eks.cluster_name
    cluster_endpoint         = module.eks.cluster_endpoint
    cluster_ca_data          = module.eks.cluster_ca_data
    oidc_provider_arn        = module.eks.oidc_provider_arn
    oidc_provider_url        = module.eks.oidc_provider_url
    vpc_id                   = module.network.vpc_id
    private_subnet_ids       = module.network.private_subnet_ids
    api_domain               = var.api_domain
    frontend_domain          = var.frontend_domain
    certificate_arn          = aws_acm_certificate.public.arn
    app_namespace            = var.app_namespace
    app_service_account      = var.app_service_account
    app_irsa_role_arn        = module.app_irsa.role_arn
    permissions_boundary_arn = var.permissions_boundary_arn
    runtime_secret_arn       = aws_secretsmanager_secret.runtime.arn
    updater_secret_arn       = aws_secretsmanager_secret.updater.arn
    supabase_instance_id     = aws_instance.supabase.id
    supabase_private_ip      = aws_instance.supabase.private_ip
    release_state_table      = aws_dynamodb_table.release_state.name
    state_machine_arn        = aws_sfn_state_machine.reconcile.arn
    event_bus_arn            = aws_cloudwatch_event_bus.releases.arn
    operator_role_arn        = try(aws_iam_role.operator[0].arn, null)
  }
  sensitive = true
}
output "certificate_dns_validation_records" {
  description = "Add these exact CNAMEs in Cloudflare (DNS-only) before the platform stage."
  value = [for option in aws_acm_certificate.public.domain_validation_options : {
    domain = option.domain_name
    name   = option.resource_record_name
    type   = option.resource_record_type
    value  = option.resource_record_value
  }]
}

output "ecr_repositories" {
  value = { for name, repository in aws_ecr_repository.enterprise : name => repository.repository_url }
}

output "backup_contract" {
  description = "The signed runtime bundle configures WAL archival at <=5 minutes; hourly EBS recovery points are independent backstops."
  value = {
    wal_bucket        = aws_s3_bucket.backups.id
    backup_vault      = aws_backup_vault.supabase.name
    snapshot_schedule = "hourly"
    rpo_minutes       = 5
    rto_minutes       = 60
  }
}
