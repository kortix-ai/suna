package main

import (
	"os"
	"regexp"
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
	versionPattern := regexp.MustCompile(`github\.com/caddyserver/caddy/v2/cmd/caddy@(v[0-9]+\.[0-9]+\.[0-9]+)`)
	match := versionPattern.FindStringSubmatch(string(dockerfile))
	if len(match) != 2 {
		t.Fatal("API Dockerfile must pin a Caddy release")
	}
	if match[1] != "v2.11.4" {
		t.Fatalf("API Dockerfile must pin Caddy v2.11.4, got %s", match[1])
	}
}
