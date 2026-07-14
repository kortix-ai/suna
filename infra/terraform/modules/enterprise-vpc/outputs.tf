output "instance" {
  description = "Secret-free coordinates consumed by kortix self-host, the deployer, and the DNS platform stage."
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
    certificate_arn    = aws_acm_certificate_validation.public.certificate_arn

    # ECS control plane
    cluster_name            = aws_ecs_cluster.this.name
    cluster_arn             = aws_ecs_cluster.this.arn
    api_service             = local.api_family
    gateway_service         = local.gateway_family
    frontend_service        = local.frontend_family
    migrate_task_def        = local.migrate_family
    deployer_task_def       = local.deployer_family
    api_task_role_arn       = aws_iam_role.api_task.arn
    gateway_task_role_arn   = aws_iam_role.gateway_task.arn
    frontend_task_role_arn  = aws_iam_role.frontend_task.arn
    execution_role_arn      = aws_iam_role.ecs_execution.arn
    deployer_task_role_arn  = aws_iam_role.deployer_task.arn
    tasks_security_group_id = aws_security_group.tasks.id

    # Shared ALB + target groups
    alb_dns_name              = aws_lb.this.dns_name
    alb_zone_id               = aws_lb.this.zone_id
    alb_arn                   = aws_lb.this.arn
    api_target_group_arn      = aws_lb_target_group.api.arn
    gateway_target_group_arn  = aws_lb_target_group.gateway.arn
    frontend_target_group_arn = aws_lb_target_group.frontend.arn
    supabase_target_group_arn = aws_lb_target_group.supabase.arn

    # Data plane + secrets + release breadcrumb
    permissions_boundary_arn = var.permissions_boundary_arn
    runtime_secret_arn       = aws_secretsmanager_secret.runtime.arn
    updater_secret_arn       = aws_secretsmanager_secret.updater.arn
    supabase_instance_id     = aws_instance.supabase.id
    supabase_private_ip      = aws_instance.supabase.private_ip
    release_ssm_parameter    = aws_ssm_parameter.release.name
    operator_role_arn        = try(aws_iam_role.operator[0].arn, null)
  }
  sensitive = true
}

output "certificate_dns_validation_records" {
  description = "ACM validation records managed automatically in the customer Route 53 zone."
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

output "alb_dns_name" {
  description = "Shared ALB DNS name; the platform stage aliases api_domain and frontend_domain here."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  value = aws_lb.this.zone_id
}

output "backup_contract" {
  description = "Durability contract: encrypted EBS + hourly AWS Backup recovery points. RPO tracks the EBS snapshot cadence (~60m); custom WAL/PITR was removed."
  value = {
    backup_vault      = aws_backup_vault.supabase.name
    snapshot_schedule = "hourly"
    rpo_minutes       = 60
    rto_minutes       = 60
  }
}
