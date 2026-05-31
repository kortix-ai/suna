# ── api-host ─────────────────────────────────────────────────────────────────
# A single Lightsail instance that runs the kortix-api Docker container(s)
# behind nginx (blue/green on 8008/8009). Mirrors the hand-built dev box so
# Terraform can adopt it via import without recreating it.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

resource "aws_lightsail_instance" "this" {
  name              = var.instance_name
  availability_zone = var.availability_zone
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id
  key_pair_name     = var.key_pair_name
  tags              = var.tags

  # The instance is provisioned/updated out-of-band (SSH deploy workflow).
  # Don't let Terraform fight day-to-day changes to the boot script.
  lifecycle {
    ignore_changes = [user_data]
  }
}

# Static IP is optional — dev uses a Lightsail static IP (kortix-dev-ip);
# prod currently rides the instance's plain public IP, so set
# manage_static_ip = false there.
resource "aws_lightsail_static_ip" "this" {
  count = var.manage_static_ip ? 1 : 0
  name  = var.static_ip_name
}

resource "aws_lightsail_static_ip_attachment" "this" {
  count          = var.manage_static_ip ? 1 : 0
  static_ip_name = aws_lightsail_static_ip.this[0].name
  instance_name  = aws_lightsail_instance.this.name
}

resource "aws_lightsail_instance_public_ports" "this" {
  instance_name = aws_lightsail_instance.this.name

  dynamic "port_info" {
    for_each = var.open_ports
    content {
      from_port = port_info.value.from_port
      to_port   = port_info.value.to_port
      protocol  = port_info.value.protocol
    }
  }
}
