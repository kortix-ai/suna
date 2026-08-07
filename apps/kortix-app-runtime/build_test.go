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
	if !strings.Contains(string(dockerfile), "github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4") {
		t.Fatal("apps/api/Dockerfile must pin Caddy v2.11.4")
	}
	if strings.Contains(string(dockerfile), "github.com/caddyserver/caddy/v2/cmd/caddy@v2.10.2") {
		t.Fatal("apps/api/Dockerfile must not build the vulnerable Caddy v2.10.2 release")
	}
}
