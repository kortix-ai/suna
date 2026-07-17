# GuardDuty Runtime Monitoring detects suspicious processes, file access, and
# network behavior inside EC2, EKS, and ECS workloads. Agent management is
# enabled centrally so current and replacement compute enters coverage without
# manual installation. Empty regions incur no runtime-agent usage until a
# supported workload is created there.

locals {
  guardduty_runtime_agent_management = toset([
    "EKS_ADDON_MANAGEMENT",
    "ECS_FARGATE_AGENT_MANAGEMENT",
    "EC2_AGENT_MANAGEMENT",
  ])
}

resource "aws_guardduty_detector_feature" "runtime_usw2" {
  detector_id = aws_guardduty_detector.usw2.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_use1" {
  provider    = aws.use1
  detector_id = aws_guardduty_detector.use1.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_aps1" {
  provider    = aws.aps1
  detector_id = aws_guardduty_detector.aps1.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_eun1" {
  provider    = aws.eun1
  detector_id = aws_guardduty_detector.eun1.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_euw3" {
  provider    = aws.euw3
  detector_id = aws_guardduty_detector.euw3.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_euw2" {
  provider    = aws.euw2
  detector_id = aws_guardduty_detector.euw2.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_euw1" {
  provider    = aws.euw1
  detector_id = aws_guardduty_detector.euw1.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_apne3" {
  provider    = aws.apne3
  detector_id = aws_guardduty_detector.apne3.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_apne2" {
  provider    = aws.apne2
  detector_id = aws_guardduty_detector.apne2.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_apne1" {
  provider    = aws.apne1
  detector_id = aws_guardduty_detector.apne1.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_cac1" {
  provider    = aws.cac1
  detector_id = aws_guardduty_detector.cac1.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_sae1" {
  provider    = aws.sae1
  detector_id = aws_guardduty_detector.sae1.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_apse1" {
  provider    = aws.apse1
  detector_id = aws_guardduty_detector.apse1.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_apse2" {
  provider    = aws.apse2
  detector_id = aws_guardduty_detector.apse2.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_euc1" {
  provider    = aws.euc1
  detector_id = aws_guardduty_detector.euc1.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_use2" {
  provider    = aws.use2
  detector_id = aws_guardduty_detector.use2.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_guardduty_detector_feature" "runtime_usw1" {
  provider    = aws.usw1
  detector_id = aws_guardduty_detector.usw1.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = local.guardduty_runtime_agent_management
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}
