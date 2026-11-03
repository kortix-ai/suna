# ════════════════════════════════════════════════════════════════════════════
# Account quotas the environment roots depend on
# ════════════════════════════════════════════════════════════════════════════
# A quota increase is a request that AWS approves asynchronously, so it lives
# here: this root applies on the push to dev, days before an environment root
# that needs the higher quota applies at a deploy.

# Routes per route table. The network module's egress route tables route the
# GitHub prefix list (max_entries 150) to the NAT, and a route that names a
# prefix list counts its max_entries against this quota. Default: 50.
resource "aws_servicequotas_service_quota" "vpc_routes_per_route_table_euw2" {
  provider     = aws.euw2 # prod, staging
  service_code = "vpc"
  quota_code   = "L-93826ACB"
  value        = 200
}

resource "aws_servicequotas_service_quota" "vpc_routes_per_route_table_use2" {
  provider     = aws.use2 # dev
  service_code = "vpc"
  quota_code   = "L-93826ACB"
  value        = 200
}
