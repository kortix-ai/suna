mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["euw2-a", "euw2-b", "euw2-c"] }
  }
  mock_data "aws_region" {
    defaults = { region = "eu-west-2" }
  }
}

override_resource {
  target          = aws_ec2_managed_prefix_list.github
  values          = { id = "pl-github" }
  override_during = plan
}

override_resource {
  target          = aws_nat_gateway.this
  values          = { id = "nat-test" }
  override_during = plan
}

override_resource {
  target          = aws_internet_gateway.this
  values          = { id = "igw-test" }
  override_during = plan
}

run "egress_subnets_route_github_through_the_nat" {
  command = plan

  variables {
    name               = "kortix-test"
    cidr               = "10.30.0.0/16"
    az_count           = 2
    single_nat_gateway = false
  }

  assert {
    condition     = [for s in aws_subnet.egress : s.cidr_block] == ["10.30.64.0/20", "10.30.80.0/20"]
    error_message = "Egress subnets take /20 slots 4 and 5, clear of public (0-3) and private (8-11)."
  }

  assert {
    condition     = alltrue([for rt in aws_route_table.egress : length([for r in rt.route : r if r.cidr_block == "0.0.0.0/0" && r.gateway_id == "igw-test"]) == 1])
    error_message = "Each egress route table sends the default route to the internet gateway, not the NAT."
  }

  assert {
    condition     = alltrue([for rt in aws_route_table.egress : length([for r in rt.route : r if r.destination_prefix_list_id == "pl-github" && r.nat_gateway_id == "nat-test"]) == 1])
    error_message = "Each egress route table routes the GitHub prefix list (to the NAT)."
  }

  assert {
    condition     = contains(local.github_ipv4_cidrs, "140.82.112.0/20") && length(local.github_ipv4_cidrs) <= aws_ec2_managed_prefix_list.github.max_entries
    error_message = "The GitHub prefix list holds GitHub's main range and fits max_entries."
  }
}
