resource "aws_lightsail_instance" "this" {
  name              = var.instance_name
  availability_zone = var.availability_zone
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id
  key_pair_name     = var.key_pair_name
  tags              = var.tags

  lifecycle {
    ignore_changes = [
      key_pair_name, # Key pair can't be changed after creation
    ]
  }
}

# Create new static IP only if not using existing one
resource "aws_lightsail_static_ip" "this" {
  count = var.create_static_ip && var.static_ip_name == null ? 1 : 0
  name  = "${var.instance_name}-ip"
}

# Use provided static IP name or newly created one
locals {
  static_ip_name = var.create_static_ip ? (
    var.static_ip_name != null ? var.static_ip_name : aws_lightsail_static_ip.this[0].name
  ) : null
}

# Only create attachment if we're creating a new static IP
# If using existing static IP, attachment already exists
resource "aws_lightsail_static_ip_attachment" "this" {
  count          = var.create_static_ip && var.static_ip_name == null ? 1 : 0
  static_ip_name = aws_lightsail_static_ip.this[0].name
  instance_name  = aws_lightsail_instance.this.name
}

resource "aws_lightsail_instance_public_ports" "this" {
  instance_name = aws_lightsail_instance.this.name

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = ["0.0.0.0/0"]
  }
}
