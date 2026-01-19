# ECS Cluster
resource "aws_ecs_cluster" "this" {
  name = var.cluster_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = var.tags
}

# EBS Encryption by Default
resource "aws_ebs_encryption_by_default" "this" {
  enabled = true
}

# Get latest ECS-optimized AMI
data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended"
}

locals {
  ami_id = jsondecode(data.aws_ssm_parameter.ecs_ami.value).image_id
}

# Launch Template
resource "aws_launch_template" "this" {
  name_prefix   = "${var.cluster_name}-"
  image_id      = local.ami_id
  instance_type = var.instance_type
  key_name      = var.key_name

  iam_instance_profile {
    arn = aws_iam_instance_profile.ecs.arn
  }

  vpc_security_group_ids = [var.ecs_security_group_id]

  user_data = base64encode(<<-EOF
    #!/bin/bash
    echo ECS_CLUSTER=${aws_ecs_cluster.this.name} >> /etc/ecs/ecs.config
  EOF
  )

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      encrypted             = true
      volume_size           = 30
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tag_specifications {
    resource_type = "instance"
    tags = merge(
      var.tags,
      { Name = var.cluster_name }
    )
  }

  tag_specifications {
    resource_type = "volume"
    tags = merge(
      var.tags,
      { Name = var.cluster_name }
    )
  }

  tags = var.tags

  depends_on = [aws_ebs_encryption_by_default.this]
}

# Auto Scaling Group
resource "aws_autoscaling_group" "this" {
  name                = "${var.cluster_name}-asg"
  vpc_zone_identifier = var.private_subnet_ids
  min_size            = var.min_size
  max_size            = var.max_size
  desired_capacity    = var.desired_capacity

  launch_template {
    id      = aws_launch_template.this.id
    version = "$Latest"
  }

  health_check_type         = "EC2"
  health_check_grace_period = 300

  tag {
    key                 = "Name"
    value               = var.cluster_name
    propagate_at_launch = true
  }

  dynamic "tag" {
    for_each = var.tags
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }
}

# Capacity Provider
resource "aws_ecs_capacity_provider" "this" {
  name = "${var.cluster_name}-capacity"

  auto_scaling_group_provider {
    auto_scaling_group_arn = aws_autoscaling_group.this.arn

    managed_scaling {
      status          = "ENABLED"
      target_capacity = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 2
      instance_warmup_period    = 120
    }

    managed_termination_protection = "DISABLED"
  }

  tags = var.tags
}

# Cluster Capacity Providers
resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name = aws_ecs_cluster.this.name

  capacity_providers = [aws_ecs_capacity_provider.this.name]

  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.this.name
    weight            = 1
    base              = 1
  }
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/suna-api"
  retention_in_days = 30

  tags = var.tags
}

# Task Definition
resource "aws_ecs_task_definition" "api" {
  family                   = "suna-api"
  requires_compatibilities = ["EC2"]
  network_mode             = "awsvpc"
  task_role_arn            = aws_iam_role.task.arn
  execution_role_arn       = aws_iam_role.task_execution.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.container_image
    essential = true

    entryPoint = ["sh", "-lc"]

    command = var.secrets_arn != null ? [
      var.use_aws_redis ? "eval \"$(python - <<'PY'\nimport os, json, shlex\nj = os.environ.get('SUNA_ENV_JSON')\nskip = {'REDIS_HOST','REDIS_PORT','REDIS_PASSWORD','REDIS_USERNAME','REDIS_SSL','PORT'}\nif j:\n    try:\n        d = json.loads(j)\n        for k, v in d.items():\n            if k in skip:\n                continue\n            val = str(v)\n            print(f\"export {k}={shlex.quote(val)}\")\n    except Exception:\n        pass\nPY\n)\"; uv run gunicorn api:app --workers ${WORKERS:-8} --bind 0.0.0.0:8000 --worker-class uvicorn.workers.UvicornWorker --timeout ${TIMEOUT:-75} --graceful-timeout 600 --keep-alive 75 --max-requests 5000 --max-requests-jitter 2500 --forwarded-allow-ips '*' --worker-connections 2000 --worker-tmp-dir /dev/shm --log-level info --access-logfile - --error-logfile - --capture-output --enable-stdio-inheritance" : "eval \"$(python - <<'PY'\nimport os, json, shlex\nj = os.environ.get('SUNA_ENV_JSON')\nskip = {'PORT'}\nif j:\n    try:\n        d = json.loads(j)\n        for k, v in d.items():\n            if k in skip:\n                continue\n            val = str(v)\n            print(f\"export {k}={shlex.quote(val)}\")\n    except Exception:\n        pass\nPY\n)\"; uv run gunicorn api:app --workers ${WORKERS:-8} --bind 0.0.0.0:8000 --worker-class uvicorn.workers.UvicornWorker --timeout ${TIMEOUT:-75} --graceful-timeout 600 --keep-alive 75 --max-requests 5000 --max-requests-jitter 2500 --forwarded-allow-ips '*' --worker-connections 2000 --worker-tmp-dir /dev/shm --log-level info --access-logfile - --error-logfile - --capture-output --enable-stdio-inheritance"
    ] : [
      "uv run gunicorn api:app --workers ${WORKERS:-8} --bind 0.0.0.0:8000 --worker-class uvicorn.workers.UvicornWorker --timeout ${TIMEOUT:-75} --graceful-timeout 600 --keep-alive 75 --max-requests 5000 --max-requests-jitter 2500 --forwarded-allow-ips '*' --worker-connections 2000 --worker-tmp-dir /dev/shm --log-level info --access-logfile - --error-logfile - --capture-output --enable-stdio-inheritance"
    ]

    portMappings = [{
      containerPort = 8000
      hostPort      = 8000
      protocol      = "tcp"
    }]

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:8000/v1/health-docker || exit 1"]
      interval    = 15
      timeout     = 10
      retries     = 3
      startPeriod = 60
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "ecs"
      }
    }

    environment = concat(
      [
        { name = "PORT", value = "8000" },
        { name = "WORKERS", value = "8" },
        { name = "TIMEOUT", value = "75" }
      ],
      var.use_aws_redis ? [
        { name = "REDIS_HOST", value = var.redis_endpoint },
        { name = "REDIS_PORT", value = "6379" },
        { name = "REDIS_PASSWORD", value = "" },
        { name = "REDIS_USERNAME", value = "" },
        { name = "REDIS_SSL", value = "false" }
      ] : []
    )

    secrets = var.secrets_arn != null ? [
      { name = "SUNA_ENV_JSON", valueFrom = var.secrets_arn }
    ] : []

    cpu    = var.task_cpu
    memory = var.task_memory

    stopTimeout = 60
  }])

  tags = var.tags
}

# ECS Service
resource "aws_ecs_service" "api" {
  name            = "${var.cluster_name}-api-svc"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.service_desired_count

  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.this.name
    weight            = 1
    base              = var.service_base_count
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "api"
    container_port   = 8000
  }

  health_check_grace_period_seconds = 90

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 150

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  enable_ecs_managed_tags = true
  propagate_tags           = "SERVICE"

  tags = var.tags

  lifecycle {
    ignore_changes = [desired_count]
  }
}

data "aws_region" "current" {}
