package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestValidateSpecRejectsReservedPorts(t *testing.T) {
	for _, port := range []int{controlPort, ingressPort} {
		spec := appSpec{Command: []string{"server"}, TargetPort: port}
		if err := spec.validate(); err == nil {
			t.Fatalf("expected port %d to be rejected", port)
		}
	}
}

func TestValidateSpecRejectsUnsafeStaticRoots(t *testing.T) {
	for _, root := range []string{"relative", "/srv\nrespond hacked"} {
		if err := (appSpec{StaticRoot: root}).validate(); err == nil {
			t.Fatalf("expected static root %q to be rejected", root)
		}
	}
}

func TestChildExitErrorHandlesSuccessfulExit(t *testing.T) {
	err := childExitError("app", nil)
	if got := err.Error(); got != "app exited successfully" {
		t.Fatalf("error = %q", got)
	}
}

func TestDynamicCaddyConfigRestoresPublicHost(t *testing.T) {
	spec := appSpec{Command: []string{"server"}, TargetPort: 3000}
	config, err := renderCaddyfile(spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		":8080",
		"reverse_proxy 127.0.0.1:3000",
		"header_up Host {http.request.header.X-Kortix-App-Host}",
		"header_up X-Forwarded-Host {http.request.header.X-Kortix-App-Host}",
		"header_up -X-Kortix-App-Host",
		"admin off",
	} {
		if !strings.Contains(config, expected) {
			t.Fatalf("missing %q in Caddyfile:\n%s", expected, config)
		}
	}
}

func TestStaticCaddyConfigSupportsSPAWithoutProxy(t *testing.T) {
	spec := appSpec{StaticRoot: "/srv", SPA: true}
	config, err := renderCaddyfile(spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"root * /srv", "try_files {path} /index.html", "file_server"} {
		if !strings.Contains(config, expected) {
			t.Fatalf("missing %q in Caddyfile:\n%s", expected, config)
		}
	}
	if strings.Contains(config, "reverse_proxy") {
		t.Fatalf("static Caddyfile must not proxy:\n%s", config)
	}
}

func TestLogRingIsBoundedAndCursorBased(t *testing.T) {
	ring := newLogRing(3)
	for _, line := range []string{"one", "two", "three", "four"} {
		ring.append("app", line)
	}
	entries, next := ring.after(0, 10)
	if len(entries) != 3 {
		t.Fatalf("got %d entries, want 3", len(entries))
	}
	if entries[0].Line != "two" || entries[2].Line != "four" {
		t.Fatalf("unexpected retained entries: %#v", entries)
	}
	if next != entries[2].Cursor {
		t.Fatalf("next cursor %d does not match final entry %d", next, entries[2].Cursor)
	}
	entries, _ = ring.after(entries[1].Cursor, 10)
	if len(entries) != 1 || entries[0].Line != "four" {
		t.Fatalf("cursor filter failed: %#v", entries)
	}
}

func TestChildEnvironmentRemovesControlSecrets(t *testing.T) {
	env := childEnvironment([]string{
		"PATH=/bin",
		"KORTIX_APPD_TOKEN=secret",
		"KORTIX_APP_SPEC={}",
		"KORTIX_APP_SPEC_PATH=/kortix/config/app.json",
		"KORTIX_APPD_CADDY_BIN=/secret/path",
		"PUBLIC_VALUE=yes",
	})
	joined := strings.Join(env, "\n")
	if strings.Contains(joined, "KORTIX_APPD_TOKEN") || strings.Contains(joined, "KORTIX_APP_SPEC") {
		t.Fatalf("control environment leaked: %s", joined)
	}
	if !strings.Contains(joined, "PUBLIC_VALUE=yes") {
		t.Fatalf("public environment missing: %s", joined)
	}
}

func TestControlEndpointsRequireTokenAndExposeState(t *testing.T) {
	state := &runtimeState{startedAt: time.Now().UTC(), status: "running", logs: newLogRing(10)}
	state.ready.Store(true)
	state.logs.append("app", "booted")
	server := httptest.NewServer(controlHandler("a-valid-runtime-token", state))
	defer server.Close()

	response, err := http.Get(server.URL + "/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", response.StatusCode)
	}
	_ = response.Body.Close()

	request, _ := http.NewRequest(http.MethodGet, server.URL+"/v1/logs?limit=1", nil)
	request.Header.Set("Authorization", "Bearer a-valid-runtime-token")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("authenticated logs = %d, want 200", response.StatusCode)
	}
	var body struct {
		Entries []logEntry `json:"entries"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Entries) != 1 || body.Entries[0].Line != "booted" {
		t.Fatalf("unexpected logs: %#v", body.Entries)
	}
}

func TestRunRestartsUntilBudgetIsExhausted(t *testing.T) {
	original := caddyCommand
	caddyCommand = func(string) *exec.Cmd {
		return exec.Command("sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done")
	}
	t.Cleanup(func() { caddyCommand = original })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := run(ctx, appSpec{
		Command:      []string{"sh", "-c", "exit 17"},
		TargetPort:   32123,
		RestartLimit: 2,
	}, "01234567890123456789012345678901")
	if err == nil || !strings.Contains(err.Error(), "exhausted after 2 restarts") {
		t.Fatalf("run error = %v", err)
	}
}

func TestRunHonorsZeroRestartLimit(t *testing.T) {
	original := caddyCommand
	caddyCommand = func(string) *exec.Cmd {
		return exec.Command("sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done")
	}
	t.Cleanup(func() { caddyCommand = original })

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := run(ctx, appSpec{
		Command:      []string{"sh", "-c", "exit 17"},
		TargetPort:   32125,
		RestartLimit: 0,
	}, "01234567890123456789012345678901")
	if err == nil || !strings.Contains(err.Error(), "exhausted after 0 restarts") {
		t.Fatalf("run error = %v", err)
	}
}

func TestRunStopsChildrenWhenContextEnds(t *testing.T) {
	original := caddyCommand
	caddyCommand = func(string) *exec.Cmd {
		return exec.Command("sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done")
	}
	t.Cleanup(func() { caddyCommand = original })

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, appSpec{
			Command:    []string{"sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done"},
			TargetPort: 32124,
		}, "01234567890123456789012345678901")
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("run returned %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("run did not stop after context cancellation")
	}
}
