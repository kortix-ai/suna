# Elastic IP (stable address across instance replacement) + optional Route53
# records. Without var.zone_id, DNS is left to the operator — point your own
# DNS at the eip_public_ip output (A/AAAA for both var.domain and the API
# hostname).

resource "aws_eip" "this" {
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${local.name}-eip" })
}

resource "aws_eip_association" "this" {
  instance_id   = aws_instance.this.id
  allocation_id = aws_eip.this.id
}

resource "aws_route53_record" "root" {
  count   = var.zone_id != "" ? 1 : 0
  zone_id = var.zone_id
  name    = var.domain
  type    = "A"
  ttl     = var.dns_ttl
  records = [aws_eip.this.public_ip]

  # Lets this module take over a zone that already has an A record for this
  # name (e.g. replacing a hand-deployed box with this same module) instead of
  # failing on "record already exists" — the new value simply wins.
  allow_overwrite = true
}

resource "aws_route53_record" "api" {
  count   = var.zone_id != "" ? 1 : 0
  zone_id = var.zone_id
  name    = local.api_domain
  type    = "A"
  ttl     = var.dns_ttl
  records = [aws_eip.this.public_ip]

  allow_overwrite = true
}
