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
	if !strings.Contains(string(buildScript), `cd "${runtime_dir}/caddy"`) {
		t.Fatal("build.sh must build Caddy from the pinned local module")
	}

	caddyModule, err := os.ReadFile("caddy/go.mod")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"github.com/caddyserver/caddy/v2 v2.11.4",
		"golang.org/x/text v0.39.0",
		"google.golang.org/grpc v1.82.1",
	} {
		if !strings.Contains(string(caddyModule), required) {
			t.Fatalf("caddy/go.mod must contain %q", required)
		}
	}

	dockerfile, err := os.ReadFile("../api/Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(dockerfile), "github.com/caddyserver/caddy/v2/cmd/caddy@v2.10.2") {
		t.Fatal("apps/api/Dockerfile must not build the vulnerable Caddy v2.10.2 release")
	}
	for _, required := range []string{
		"COPY apps/kortix-app-runtime/caddy/go.mod apps/kortix-app-runtime/caddy/go.sum ./caddy/",
		"COPY apps/kortix-app-runtime/caddy/main.go ./",
		"WORKDIR /runtime/caddy",
		"CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build",
		"-o /out/caddy .",
	} {
		if !strings.Contains(string(dockerfile), required) {
			t.Fatalf("apps/api/Dockerfile must contain %q", required)
		}
	}
	if strings.Contains(string(dockerfile), "GOBIN=/out go install") {
		t.Fatal("apps/api/Dockerfile must not set GOBIN while cross-compiling Caddy")
	}
	if strings.Contains(string(dockerfile), "RUN cd /runtime/caddy") {
		t.Fatal("apps/api/Dockerfile must use WORKDIR instead of RUN cd")
	}
}
