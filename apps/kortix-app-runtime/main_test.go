package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestDaemonizeStartsOnceAndWritesPid(t *testing.T) {
	originalCommand := daemonCommand
	originalAlive := daemonProcessAlive
	originalMatches := daemonProcessMatchesExecutable
	starts := 0
	daemonCommand = func() (*exec.Cmd, error) {
		starts++
		return exec.Command("sh", "-c", "sleep 30"), nil
	}
	daemonProcessAlive = func(pid int) bool {
		return syscall.Kill(pid, 0) == nil
	}
	daemonProcessMatchesExecutable = func(int) bool { return true }
	t.Cleanup(func() {
		daemonCommand = originalCommand
		daemonProcessAlive = originalAlive
		daemonProcessMatchesExecutable = originalMatches
	})

	dir := t.TempDir()
	pidPath := filepath.Join(dir, "appd.pid")
	logPath := filepath.Join(dir, "appd.log")
	if err := daemonize(pidPath, logPath); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	if err := daemonize(pidPath, logPath); err != nil {
		t.Fatal(err)
	}
	if starts != 1 {
		t.Fatalf("daemon starts = %d, want 1", starts)
	}
}

func TestDaemonizeReplacesAStalePidOwnedByAnotherProcess(t *testing.T) {
	originalCommand := daemonCommand
	originalAlive := daemonProcessAlive
	originalMatches := daemonProcessMatchesExecutable
	starts := 0
	daemonCommand = func() (*exec.Cmd, error) {
		starts++
		return exec.Command("sh", "-c", "sleep 30"), nil
	}
	// The stale PID was reused by another live process. kill(0) alone cannot
	// prove that the process is kortix-appd.
	daemonProcessAlive = func(int) bool { return true }
	daemonProcessMatchesExecutable = func(int) bool { return false }
	t.Cleanup(func() {
		daemonCommand = originalCommand
		daemonProcessAlive = originalAlive
		daemonProcessMatchesExecutable = originalMatches
	})

	dir := t.TempDir()
	pidPath := filepath.Join(dir, "appd.pid")
	logPath := filepath.Join(dir, "appd.log")
	if err := os.WriteFile(pidPath, []byte("4242\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := daemonize(pidPath, logPath); err != nil {
		t.Fatal(err)
	}
	if starts != 1 {
		t.Fatalf("daemon starts = %d, want 1 after stale PID reuse", starts)
	}
	raw, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
}

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

func TestReadinessChecksPublicIngressForStaticAndDynamicApps(t *testing.T) {
	for _, spec := range []appSpec{
		{StaticRoot: "/srv", ReadinessPath: "/health"},
		{Command: []string{"server"}, TargetPort: 3000, ReadinessPath: "/health"},
	} {
		want := "http://127.0.0.1:8080/health"
		if got := spec.readinessURL(); got != want {
			t.Fatalf("readiness URL = %q, want %q", got, want)
		}
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

func TestCaddyEnvironmentUsesWritableTemporaryState(t *testing.T) {
	env := strings.Join(caddyEnvironment([]string{"HOME=/root", "PATH=/bin"}), "\n")
	for _, required := range []string{
		"XDG_CONFIG_HOME=/tmp/kortix-caddy-config",
		"XDG_DATA_HOME=/tmp/kortix-caddy-data",
	} {
		if !strings.Contains(env, required) {
			t.Fatalf("Caddy environment missing %q: %s", required, env)
		}
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

// The access log is readable through `kortix apps logs`. Request headers carry
// credentials the App never owns: the viewer's Kortix token
// (X-Kortix-App-Viewer-Token), the signed viewer identity, and the provider's
// ingress token. Caddy redacts only Cookie and Authorization by default.
func TestCaddyAccessLogDropsRequestHeaders(t *testing.T) {
	for _, spec := range []appSpec{
		{Command: []string{"server"}, TargetPort: 3000},
		{StaticRoot: "/srv"},
	} {
		config, err := renderCaddyfile(spec)
		if err != nil {
			t.Fatal(err)
		}
		for _, expected := range []string{"format filter {", "wrap json", "request>headers delete"} {
			if !strings.Contains(config, expected) {
				t.Fatalf("missing %q in Caddyfile:\n%s", expected, config)
			}
		}
	}
}

func TestMountPointsDecodesOctalEscapes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mountinfo")
	contents := "22 1 0:21 / / rw - ext4 /dev/vda rw\n" +
		"40 22 252:16 / /data rw,relatime - ext4 /dev/vdb rw\n" +
		"41 22 252:32 / /my\\040volume rw - ext4 /dev/vdc rw\n"
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	points, err := mountPoints(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"/", "/data", "/my volume"} {
		if !points[want] {
			t.Fatalf("missing mount point %q in %v", want, points)
		}
	}
	if points["/my\\040volume"] {
		t.Fatal("escaped form must be decoded")
	}
}

func fakeCaddy(t *testing.T) {
	original := caddyCommand
	caddyCommand = func(string) *exec.Cmd {
		return exec.Command("sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done")
	}
	t.Cleanup(func() { caddyCommand = original })
}

func TestRunReportsMountMissingAndNeverStartsTheApp(t *testing.T) {
	fakeCaddy(t)
	dir := t.TempDir()
	info := filepath.Join(dir, "mountinfo")
	if err := os.WriteFile(info, []byte("22 1 0:21 / / rw - ext4 /dev/vda rw\n"), 0600); err != nil {
		t.Fatal(err)
	}
	originalPath, originalWindow := mountInfoPath, mountWaitWindow
	mountInfoPath, mountWaitWindow = info, 300*time.Millisecond
	t.Cleanup(func() { mountInfoPath, mountWaitWindow = originalPath, originalWindow })

	marker := filepath.Join(dir, "started")
	state := &runtimeState{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runWithState(ctx, appSpec{
			Command: []string{"sh", "-c", "touch " + marker + "; sleep 30"},
			Mounts:  []string{"/data"},
		}, state)
	}()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if state.snapshot()["reason"] == "mount_missing" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	snapshot := state.snapshot()
	if snapshot["status"] != "failed" || snapshot["reason"] != "mount_missing" || snapshot["ready"] != false {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if snapshot["last_exit"] != "mount /data is not mounted" {
		t.Fatalf("last_exit = %v", snapshot["last_exit"])
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("the app started on a missing mount")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run returned %v", err)
	}
}

func TestRunStartsWhenEveryMountIsPresent(t *testing.T) {
	fakeCaddy(t)
	dir := t.TempDir()
	info := filepath.Join(dir, "mountinfo")
	if err := os.WriteFile(info, []byte("40 22 252:16 / /data rw - ext4 /dev/vdb rw\n"), 0600); err != nil {
		t.Fatal(err)
	}
	originalPath := mountInfoPath
	mountInfoPath = info
	t.Cleanup(func() { mountInfoPath = originalPath })

	state := &runtimeState{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = runWithState(ctx, appSpec{Command: []string{"sh", "-c", "sleep 30"}, Mounts: []string{"/data"}}, state)
	}()
	waitFor(t, func() bool { return state.ready.Load() })
	if state.snapshot()["status"] != "running" {
		t.Fatalf("snapshot = %#v", state.snapshot())
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func serverPort(t *testing.T, url string) int {
	t.Helper()
	port, err := strconv.Atoi(url[strings.LastIndex(url, ":")+1:])
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func TestRunCheck(t *testing.T) {
	healthy := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/redirect":
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
		case healthy:
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	port := serverPort(t, server.URL)
	closed := httptest.NewServer(http.NotFoundHandler())
	closedPort := serverPort(t, closed.URL)
	closed.Close()

	for _, tc := range []struct {
		name  string
		check appCheck
		port  int
		pass  bool
	}{
		{"http 200", appCheck{Type: "http", Path: "/health", TimeoutS: 1}, port, true},
		{"http 302 passes", appCheck{Type: "http", Path: "/redirect", TimeoutS: 1}, port, true},
		{"tcp open", appCheck{Type: "tcp", TimeoutS: 1}, port, true},
		{"tcp closed", appCheck{Type: "tcp", TimeoutS: 1}, closedPort, false},
		{"http closed", appCheck{Type: "http", Path: "/", TimeoutS: 1}, closedPort, false},
	} {
		err := runCheck(context.Background(), tc.check, tc.port)
		if (err == nil) != tc.pass {
			t.Fatalf("%s: err = %v, want pass=%v", tc.name, err, tc.pass)
		}
	}
	healthy = false
	if err := runCheck(context.Background(), appCheck{Type: "http", Path: "/health", TimeoutS: 1}, port); err == nil || err.Error() != "HTTP 404" {
		t.Fatalf("404 must fail with HTTP 404, got %v", err)
	}
}

func TestChecksGateReadinessAndFlipBack(t *testing.T) {
	var healthy atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if healthy.Load() {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	spec := appSpec{
		Command: []string{"server"}, TargetPort: serverPort(t, server.URL),
		Checks: []appCheck{
			{Name: "web", Type: "http", Path: "/up", IntervalS: 1, TimeoutS: 1},
			{Type: "tcp", IntervalS: 1, TimeoutS: 1},
		},
	}
	if err := spec.validate(); err != nil {
		t.Fatal(err)
	}
	state := &runtimeState{status: "starting", logs: newLogRing(10)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startChecks(ctx, spec, state)
	waitFor(t, func() bool {
		checks, _ := state.snapshot()["checks"].([]checkResult)
		return len(checks) == 2 && checks[0].Status == "failing" && checks[1].Status == "passing"
	})
	if state.ready.Load() {
		t.Fatal("ready with a failing check")
	}
	healthy.Store(true)
	waitFor(t, func() bool { return state.ready.Load() })
	snapshot := state.snapshot()
	checks := snapshot["checks"].([]checkResult)
	if snapshot["status"] != "running" || checks[0].Name != "web" || checks[1].Name != "tcp-1" || checks[0].CheckedAt == nil {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	healthy.Store(false)
	waitFor(t, func() bool { return !state.ready.Load() })
	cancel()
}

func TestWorkerIsReadyOnceTheProcessRuns(t *testing.T) {
	fakeCaddy(t)
	spec := appSpec{Command: []string{"sh", "-c", "sleep 30"}}
	if err := spec.validate(); err != nil {
		t.Fatalf("a worker spec must be valid: %v", err)
	}
	config, err := renderCaddyfile(spec)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(config, `respond "this machine serves no http service" 503`) || strings.Contains(config, "reverse_proxy") {
		t.Fatalf("worker Caddyfile:\n%s", config)
	}
	state := &runtimeState{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = runWithState(ctx, spec, state) }()
	waitFor(t, func() bool { return state.ready.Load() && state.snapshot()["status"] == "running" })
	if _, ok := state.snapshot()["checks"]; ok {
		t.Fatal("a spec without checks reports none")
	}
}

func TestValidateSpecChecksAndMounts(t *testing.T) {
	base := appSpec{Command: []string{"server"}, TargetPort: 3000}
	ok := appCheck{Type: "http", Path: "/", IntervalS: 15, TimeoutS: 5, GracePeriodS: 10}
	for _, tc := range []struct {
		name  string
		edit  func(*appSpec)
		valid bool
	}{
		{"valid check and mount", func(s *appSpec) { s.Checks = []appCheck{ok}; s.Mounts = []string{"/data"} }, true},
		{"bad type", func(s *appSpec) { c := ok; c.Type = "grpc"; s.Checks = []appCheck{c} }, false},
		{"relative http path", func(s *appSpec) { c := ok; c.Path = "health"; s.Checks = []appCheck{c} }, false},
		{"zero interval", func(s *appSpec) { c := ok; c.IntervalS = 0; s.Checks = []appCheck{c} }, false},
		{"zero timeout", func(s *appSpec) { c := ok; c.TimeoutS = 0; s.Checks = []appCheck{c} }, false},
		{"negative grace", func(s *appSpec) { c := ok; c.GracePeriodS = -1; s.Checks = []appCheck{c} }, false},
		{"reserved check port", func(s *appSpec) { c := ok; c.Port = ingressPort; s.Checks = []appCheck{c} }, false},
		{"worker check without port", func(s *appSpec) { s.TargetPort = 0; s.Checks = []appCheck{ok} }, false},
		{"worker check with port", func(s *appSpec) { s.TargetPort = 0; c := ok; c.Port = 9000; s.Checks = []appCheck{c} }, true},
		{"relative mount", func(s *appSpec) { s.Mounts = []string{"data"} }, false},
		{"unclean mount", func(s *appSpec) { s.Mounts = []string{"/data/"} }, false},
		{"root mount", func(s *appSpec) { s.Mounts = []string{"/"} }, false},
		{"mount with newline", func(s *appSpec) { s.Mounts = []string{"/da\nta"} }, false},
	} {
		spec := base
		tc.edit(&spec)
		if err := spec.validate(); (err == nil) != tc.valid {
			t.Fatalf("%s: validate() = %v, want valid=%v", tc.name, err, tc.valid)
		}
	}
}

func TestLegacySpecKeepsIngressReadiness(t *testing.T) {
	var raw = `{"command":["server"],"target_port":3000,"readiness_path":"/health","restart_limit":3}`
	var spec appSpec
	if err := json.Unmarshal([]byte(raw), &spec); err != nil {
		t.Fatal(err)
	}
	if err := spec.validate(); err != nil {
		t.Fatal(err)
	}
	if spec.worker() || len(spec.Checks) != 0 {
		t.Fatalf("legacy spec misread: %#v", spec)
	}
	if got := spec.readinessURL(); got != "http://127.0.0.1:8080/health" {
		t.Fatalf("readiness URL = %q", got)
	}
}

func TestRunReportsAppStartFailure(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing-app")
	state := &runtimeState{logs: newLogRing(defaultLogCapacity)}
	err := runWithState(context.Background(), appSpec{
		Command: []string{missing}, TargetPort: 32126,
	}, state)
	if err == nil || !strings.HasPrefix(err.Error(), "start app: ") || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("run error = %v, want wrapped app start failure", err)
	}
}
