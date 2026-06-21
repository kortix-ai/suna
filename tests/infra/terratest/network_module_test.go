package terratest

import (
	"testing"

	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// Example terratest stub. This runs `terraform init` + `terraform validate`
// against the network module to prove it is internally consistent, WITHOUT
// applying anything to a cloud account (no plan against real AWS creds).
//
// Promote to a real plan/apply test only in an account you control, and gate it
// behind a build tag so it never runs by accident:
//   //go:build terratest_apply
//
// Requires Go (>= 1.22) and terraform on PATH. This is intentionally NOT wired
// into run.sh, which is fully Dockerized and tooling-free.
func TestNetworkModuleValidate(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../../../infra/terraform/modules/network",
		NoColor:      true,
	}

	terraform.Init(t, opts)
	out := terraform.Validate(t, opts)
	assert.Contains(t, out, "Success")
}
