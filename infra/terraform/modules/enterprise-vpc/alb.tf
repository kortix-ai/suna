# One public ALB fronts the whole installation. Host + path rules route:
#   api.<domain>   /v1/llm*  -> gateway TG,  /*  -> api TG
#   <domain>       <supabase prefixes> -> supabase TG (EC2 Kong :8000),  /* -> frontend TG
# Host + path routing and success-code semantics are owned here at the ALB (the
# single edge for the whole installation); there is no in-cluster edge tier.

resource "aws_security_group" "alb" {
  #checkov:skip=CKV_AWS_260:Port 80 exists only for the ALB's HTTP->HTTPS redirect listener and honors alb_ingress_cidrs.
  name_prefix = "${var.name}-alb-"
  description = "Public ingress to the shared Kortix ALB"
  vpc_id      = module.network.vpc_id

  ingress {
    description = "HTTP (redirected to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
  }

  egress {
    description = "Forward to ECS tasks and the Supabase host"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = merge(local.tags, { Name = "${var.name}-alb" })
}

#trivy:ignore:AVD-AWS-0053
resource "aws_lb" "this" {
  # Public exposure is the product: this ALB is the single customer-facing entry
  # point for the frontend, API, and Supabase data plane. Reach is governed by
  # alb_ingress_cidrs, which enterprise customers restrict to their networks.
  #checkov:skip=CKV2_AWS_28:Enterprise customers restrict alb_ingress_cidrs and may front the ALB with their own WAF; a Kortix-managed WAF is out of the single-tenant scope.
  #checkov:skip=CKV_AWS_91:Access logging needs an ELB-log-delivery bucket policy; planned follow-up, not a v1 gate. CloudTrail + VPC flow logs cover the account audit trail.
  #checkov:skip=CKV_AWS_150:deletion_protection is governed by the customer's reviewed decommission procedure, not always-on in the template.
  name                       = "${local.lb_base}-alb"
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = module.network.public_subnet_ids
  idle_timeout               = var.alb_idle_timeout
  drop_invalid_header_fields = true
  tags                       = merge(local.tags, { Name = "${var.name}-alb" })
}

# ── Target groups ─────────────────────────────────────────────────────────────
resource "aws_lb_target_group" "api" {
  #checkov:skip=CKV_AWS_378:TLS terminates at the ALB; target traffic is HTTP inside private subnets to tasks/Kong, the standard ALB pattern.
  name        = "${local.lb_base}-api"
  port        = local.api_port
  protocol    = "HTTP"
  vpc_id      = module.network.vpc_id
  target_type = "ip"

  health_check {
    path                = "/v1/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200-399"
  }

  deregistration_delay = 30
  tags                 = local.tags
}

resource "aws_lb_target_group" "gateway" {
  #checkov:skip=CKV_AWS_378:TLS terminates at the ALB; target traffic is HTTP inside private subnets to tasks/Kong, the standard ALB pattern.
  name        = "${local.lb_base}-gw"
  port        = local.gateway_port
  protocol    = "HTTP"
  vpc_id      = module.network.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health/live"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200-399"
  }

  deregistration_delay = 30
  tags                 = local.tags
}

resource "aws_lb_target_group" "frontend" {
  name        = "${local.lb_base}-fe"
  port        = local.frontend_port
  protocol    = "HTTP"
  vpc_id      = module.network.vpc_id
  target_type = "ip"

  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200-399"
  }

  deregistration_delay = 30
  tags                 = local.tags
}

# Supabase Kong runs on the private EC2, not on ECS, so this TG registers the
# host's private IP directly (IP target type, no ECS service).
resource "aws_lb_target_group" "supabase" {
  #checkov:skip=CKV_AWS_378:TLS terminates at the ALB; target traffic is HTTP inside private subnets to tasks/Kong, the standard ALB pattern.
  name        = "${local.lb_base}-sb"
  port        = local.supabase_port
  protocol    = "HTTP"
  vpc_id      = module.network.vpc_id
  target_type = "ip"

  health_check {
    path                = "/auth/v1/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200-399"
  }

  deregistration_delay = 30
  tags                 = local.tags
}

resource "aws_lb_target_group_attachment" "supabase" {
  target_group_arn  = aws_lb_target_group.supabase.arn
  target_id         = aws_instance.supabase.private_ip
  port              = local.supabase_port
  availability_zone = data.aws_subnet.supabase.availability_zone
}

# ── Listeners ─────────────────────────────────────────────────────────────────
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
  tags = local.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.public.certificate_arn

  # Default: the frontend on the root domain.
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
  tags = local.tags
}

# api.<domain>: /v1/llm* -> gateway
resource "aws_lb_listener_rule" "api_gateway" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
  condition {
    host_header {
      values = [var.api_domain]
    }
  }
  condition {
    path_pattern {
      values = ["/v1/llm*"]
    }
  }
  tags = local.tags
}

# api.<domain>: everything else -> api
resource "aws_lb_listener_rule" "api_default" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    host_header {
      values = [var.api_domain]
    }
  }
  tags = local.tags
}

# <domain>: Supabase data-plane prefixes -> supabase (max 5 path values per
# condition, so graphql is a second rule).
resource "aws_lb_listener_rule" "supabase_core" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 30

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.supabase.arn
  }
  condition {
    host_header {
      values = [var.frontend_domain]
    }
  }
  condition {
    path_pattern {
      values = ["/rest/v1*", "/auth/v1*", "/storage/v1*", "/realtime/v1*", "/functions/v1*"]
    }
  }
  tags = local.tags
}

resource "aws_lb_listener_rule" "supabase_graphql" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 31

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.supabase.arn
  }
  condition {
    host_header {
      values = [var.frontend_domain]
    }
  }
  condition {
    path_pattern {
      values = ["/graphql/v1*"]
    }
  }
  tags = local.tags
}

# ── Supabase host ingress (defined here to avoid a security-group cycle) ───────
resource "aws_vpc_security_group_ingress_rule" "supabase_kong_from_alb" {
  security_group_id            = aws_security_group.supabase.id
  referenced_security_group_id = aws_security_group.alb.id
  description                  = "Supabase Kong from the shared ALB"
  ip_protocol                  = "tcp"
  from_port                    = local.supabase_port
  to_port                      = local.supabase_port
  tags                         = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "supabase_kong_from_tasks" {
  security_group_id            = aws_security_group.supabase.id
  referenced_security_group_id = aws_security_group.tasks.id
  description                  = "Supabase Kong from ECS tasks"
  ip_protocol                  = "tcp"
  from_port                    = local.supabase_port
  to_port                      = local.supabase_port
  tags                         = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "supabase_postgres_from_tasks" {
  security_group_id            = aws_security_group.supabase.id
  referenced_security_group_id = aws_security_group.tasks.id
  description                  = "Supabase Postgres from ECS tasks (migrations + runtime)"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  tags                         = local.tags
}
