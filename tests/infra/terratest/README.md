# terratest (optional, requires Go)

Unlike the rest of `tests/infra/` (fully Dockerized, no host tooling), terratest
is a **Go** test framework and needs a Go toolchain. It is kept separate and is
**not** wired into `tests/infra/run.sh`.

## Prerequisites

- Go >= 1.22
- terraform on PATH (terratest shells out to it)
- For real plan/apply tests: cloud credentials for an account you control

## Run

```bash
cd tests/infra/terratest
go test -v ./...
```

`network_module_test.go` is a safe stub: it runs `terraform init` +
`terraform validate` on the network module only — no plan, no apply, no cloud
calls.

## Going further

To assert real provisioned infrastructure, write plan/apply tests and gate them
behind a build tag so they never run by default:

```go
//go:build terratest_apply
```

```bash
go test -tags terratest_apply -v -timeout 30m ./...
```

JUnit output (for CI dashboards):

```bash
go install github.com/jstemmer/go-junit-report/v2@latest
go test -v ./... 2>&1 | go-junit-report -set-exit-code \
  > ../../../test-results/infra/terratest.junit.xml
```
