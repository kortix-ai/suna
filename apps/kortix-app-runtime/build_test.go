package main

import (
	"os"
	"strings"
	"testing"
)

func TestBuildPinsPatchedCaddyRelease(t *testing.T) {
	buildScript, err := os.ReadFile("build.sh")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(buildScript), `CADDY_VERSION="v2.11.4"`) {
		t.Fatal("build.sh must pin Caddy v2.11.4")
	}

	dockerfile, err := os.ReadFile("../api/Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	normalizedDockerfile := strings.Join(
		strings.Fields(strings.ReplaceAll(string(dockerfile), "\\\n", " ")),
		" ",
	)
	if !strings.Contains(normalizedDockerfile, "github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4") {
		t.Fatal("apps/api/Dockerfile must pin Caddy v2.11.4")
	}
	if strings.Contains(normalizedDockerfile, "github.com/caddyserver/caddy/v2/cmd/caddy@v2.10.2") {
		t.Fatal("apps/api/Dockerfile must not build the vulnerable Caddy v2.10.2 release")
	}
	if !strings.Contains(
		normalizedDockerfile,
		"CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOPATH=/tmp/caddy-go go install -ldflags='-s -w' github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4",
	) {
		t.Fatal("apps/api/Dockerfile must cross-compile Caddy without setting GOBIN")
	}
	if !strings.Contains(
		normalizedDockerfile,
		"find /tmp/caddy-go/bin -type f -name caddy -exec cp {} /out/caddy \\; && test -x /out/caddy",
	) {
		t.Fatal("apps/api/Dockerfile must copy and verify the cross-compiled Caddy binary")
	}
	if strings.Contains(normalizedDockerfile, "GOBIN=/out go install") {
		t.Fatal("apps/api/Dockerfile must not use GOBIN with a cross-compiled go install")
	}
}
