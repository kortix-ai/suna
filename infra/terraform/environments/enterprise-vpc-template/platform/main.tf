# Platform stage — retained as a no-op for backward compatibility.
#
# Under EKS this stage installed Helm controllers, External Secrets, and
# external-dns. Under the ECS model it aliased the two application domains at the
# shared ALB. The appliance has neither: there is one box with a stable Elastic
# IP, and the application A records now live in the cluster stage (the module
# creates them directly against the customer Route 53 zone, alongside the ACME
# DNS-01 grant the on-box updater uses). Nothing remains for a separate
# post-cluster stage to do.
#
# The stage is kept (empty) so `kortix self-host` keeps materializing a complete,
# reviewed graph and any operator muscle-memory / automation that applies it is a
# harmless no-op. Delete it only in a coordinated change with the CLI asset list.

provider "aws" {
  region = var.aws_region
}
