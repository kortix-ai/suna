package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	controlPort          = 7331
	ingressPort          = 8080
	defaultReadinessPath = "/"
	defaultLogCapacity   = 10000
	shutdownGrace        = 10 * time.Second
	daemonPIDPath        = "/tmp/kortix-appd.pid"
	daemonLogPath        = "/tmp/kortix-appd-bootstrap.log"
	daemonLockPath       = "/tmp/kortix-appd-bootstrap.lock"
)

var caddyCommand = func(configPath string) *exec.Cmd {
	path := os.Getenv("KORTIX_APPD_CADDY_BIN")
	if path == "" {
		path = "/kortix/bin/caddy"
	}
	return exec.Command(path, "run", "--config", configPath, "--adapter", "caddyfile")
}

var daemonCommand = func() (*exec.Cmd, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve appd executable: %w", err)
	}
	return exec.Command(executable), nil
}

var daemonProcessAlive = func(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

var daemonProcessMatchesExecutable = func(pid int) bool {
	currentPath, err := os.Executable()
	if err != nil {
		return false
	}
	current, err := os.Stat(currentPath)
	if err != nil {
		return false
	}
	process, err := os.Stat(fmt.Sprintf("/proc/%d/exe", pid))
	return err == nil && os.SameFile(current, process)
}

func daemonize(pidPath, logPath string) error {
	lock, err := os.OpenFile(daemonLockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return fmt.Errorf("open daemon lock: %w", err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("lock daemon bootstrap: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) //nolint:errcheck

	if raw, readErr := os.ReadFile(pidPath); readErr == nil {
		pid, parseErr := strconv.Atoi(strings.TrimSpace(string(raw)))
		if parseErr == nil && daemonProcessAlive(pid) && daemonProcessMatchesExecutable(pid) {
			return nil
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return fmt.Errorf("read daemon pid: %w", readErr)
	}

	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("open daemon log: %w", err)
	}
	defer logFile.Close()
	null, err := os.Open(os.DevNull)
	if err != nil {
		return fmt.Errorf("open null input: %w", err)
	}
	defer null.Close()

	cmd, err := daemonCommand()
	if err != nil {
		return err
	}
	cmd.Stdin = null
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start appd daemon: %w", err)
	}
	pid := cmd.Process.Pid
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(pid)+"\n"), 0600); err != nil {
		_ = cmd.Process.Kill()
		return fmt.Errorf("write daemon pid: %w", err)
	}
	time.Sleep(100 * time.Millisecond)
	if !daemonProcessAlive(pid) {
		return fmt.Errorf("appd daemon %d exited during bootstrap", pid)
	}
	return cmd.Process.Release()
}

type appSpec struct {
	Command       []string          `json:"command"`
	Workdir       string            `json:"workdir,omitempty"`
	TargetPort    int               `json:"target_port,omitempty"`
	ReadinessPath string            `json:"readiness_path,omitempty"`
	StaticRoot    string            `json:"static_root,omitempty"`
	SPA           bool              `json:"spa,omitempty"`
	RestartLimit  int               `json:"restart_limit,omitempty"`
	Environment   map[string]string `json:"environment,omitempty"`
}

func (s appSpec) validate() error {
	if s.StaticRoot == "" && len(s.Command) == 0 {
		return errors.New("command is required for a dynamic app")
	}
	if s.StaticRoot != "" && len(s.Command) > 0 {
		return errors.New("static_root and command are mutually exclusive")
	}
	if s.StaticRoot != "" {
		if !filepath.IsAbs(s.StaticRoot) {
			return errors.New("static_root must be an absolute path")
		}
		if strings.ContainsAny(s.StaticRoot, "\r\n\x00") {
			return errors.New("static_root contains an invalid control character")
		}
	}
	if s.StaticRoot == "" {
		if s.TargetPort < 1 || s.TargetPort > 65535 {
			return fmt.Errorf("target_port must be between 1 and 65535")
		}
		if s.TargetPort == controlPort || s.TargetPort == ingressPort {
			return fmt.Errorf("target_port %d is reserved", s.TargetPort)
		}
	}
	if s.ReadinessPath != "" && !strings.HasPrefix(s.ReadinessPath, "/") {
		return errors.New("readiness_path must start with /")
	}
	if s.RestartLimit < 0 || s.RestartLimit > 20 {
		return errors.New("restart_limit must be between 0 and 20")
	}
	return nil
}

func (s appSpec) readinessPath() string {
	if s.ReadinessPath == "" {
		return defaultReadinessPath
	}
	return s.ReadinessPath
}

// Readiness must cover the complete public path. Probing the user process
// directly can publish ready before Caddy accepts traffic after a cold start.
func (s appSpec) readinessURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", ingressPort, s.readinessPath())
}

func (s appSpec) restartLimit() int {
	return s.RestartLimit
}

func renderCaddyfile(spec appSpec) (string, error) {
	if err := spec.validate(); err != nil {
		return "", err
	}
	var body string
	if spec.StaticRoot != "" {
		root := filepath.Clean(spec.StaticRoot)
		spa := ""
		if spec.SPA {
			spa = "\ttry_files {path} /index.html\n"
		}
		body = fmt.Sprintf("\troot * %s\n%s\tfile_server\n", root, spa)
	} else {
		body = fmt.Sprintf(`	reverse_proxy 127.0.0.1:%d {
		header_up Host {http.request.header.X-Kortix-App-Host}
		header_up X-Forwarded-Host {http.request.header.X-Kortix-App-Host}
		header_up -X-Kortix-App-Host
	}
`, spec.TargetPort)
	}
	return fmt.Sprintf(`{
	admin off
	auto_https off
}

:%d {
	encode zstd gzip
	log {
		output stdout
		format json
	}
%s}
`, ingressPort, body), nil
}

type logEntry struct {
	Cursor uint64    `json:"cursor"`
	Time   time.Time `json:"time"`
	Source string    `json:"source"`
	Line   string    `json:"line"`
}

type logRing struct {
	mu       sync.RWMutex
	entries  []logEntry
	capacity int
	next     uint64
}

func newLogRing(capacity int) *logRing {
	if capacity < 1 {
		capacity = defaultLogCapacity
	}
	return &logRing{capacity: capacity}
}

func (r *logRing) append(source, line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	entry := logEntry{Cursor: r.next, Time: time.Now().UTC(), Source: source, Line: line}
	if len(r.entries) == r.capacity {
		copy(r.entries, r.entries[1:])
		r.entries[len(r.entries)-1] = entry
		return
	}
	r.entries = append(r.entries, entry)
}

func (r *logRing) after(cursor uint64, limit int) ([]logEntry, uint64) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	out := make([]logEntry, 0, min(limit, len(r.entries)))
	for _, entry := range r.entries {
		if entry.Cursor <= cursor {
			continue
		}
		out = append(out, entry)
		if len(out) == limit {
			break
		}
	}
	next := cursor
	if len(out) > 0 {
		next = out[len(out)-1].Cursor
	}
	return out, next
}

func childEnvironment(parent []string) []string {
	blocked := []string{"KORTIX_APPD_", "KORTIX_APP_SPEC"}
	out := make([]string, 0, len(parent))
	for _, item := range parent {
		skip := false
		for _, prefix := range blocked {
			if strings.HasPrefix(item, prefix) {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, item)
		}
	}
	return out
}

func caddyEnvironment(parent []string) []string {
	env := childEnvironment(parent)
	out := make([]string, 0, len(env)+2)
	for _, item := range env {
		if strings.HasPrefix(item, "XDG_CONFIG_HOME=") || strings.HasPrefix(item, "XDG_DATA_HOME=") {
			continue
		}
		out = append(out, item)
	}
	return append(out,
		"XDG_CONFIG_HOME=/tmp/kortix-caddy-config",
		"XDG_DATA_HOME=/tmp/kortix-caddy-data",
	)
}

type runtimeState struct {
	startedAt time.Time
	ready     atomic.Bool
	statusMu  sync.RWMutex
	status    string
	restarts  int
	lastExit  string
	logs      *logRing
}

func (r *runtimeState) setStatus(status string) {
	r.statusMu.Lock()
	r.status = status
	r.statusMu.Unlock()
}

func (r *runtimeState) snapshot() map[string]any {
	r.statusMu.RLock()
	defer r.statusMu.RUnlock()
	return map[string]any{
		"status": r.status, "ready": r.ready.Load(), "started_at": r.startedAt,
		"restarts": r.restarts, "last_exit": r.lastExit,
	}
}

func pipeLines(reader io.Reader, source string, logs *logRing) {
	scanner := bufio.NewScanner(reader)
	buffer := make([]byte, 64*1024)
	scanner.Buffer(buffer, 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		logs.append(source, line)
		log.Printf("[%s] %s", source, line)
	}
	if err := scanner.Err(); err != nil {
		logs.append("appd", fmt.Sprintf("%s log stream failed: %v", source, err))
	}
}

func commandFor(spec appSpec) *exec.Cmd {
	cmd := exec.Command(spec.Command[0], spec.Command[1:]...)
	if spec.Workdir != "" {
		cmd.Dir = spec.Workdir
	}
	env := childEnvironment(os.Environ())
	for key, value := range spec.Environment {
		env = append(env, key+"="+value)
	}
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}

type childProcess struct {
	cmd    *exec.Cmd
	exited <-chan error
}

func startLogged(cmd *exec.Cmd, source string, logs *logRing) (*childProcess, error) {
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go pipeLines(stdout, source, logs)
	go pipeLines(stderr, source, logs)
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	return &childProcess{cmd: cmd, exited: exited}, nil
}

func terminate(child *childProcess) {
	if child == nil || child.cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-child.cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-child.exited:
	case <-time.After(shutdownGrace):
		_ = syscall.Kill(-child.cmd.Process.Pid, syscall.SIGKILL)
		<-child.exited
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func authorized(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		got := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
		if len(got) != len(token) || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next(w, req)
	}
}

func controlHandler(token string, state *runtimeState) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", authorized(token, func(w http.ResponseWriter, _ *http.Request) {
		status := http.StatusOK
		if !state.ready.Load() {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, state.snapshot())
	}))
	mux.HandleFunc("/v1/status", authorized(token, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, state.snapshot())
	}))
	mux.HandleFunc("/v1/logs", authorized(token, func(w http.ResponseWriter, req *http.Request) {
		cursor, _ := strconv.ParseUint(req.URL.Query().Get("after"), 10, 64)
		limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
		entries, next := state.logs.after(cursor, limit)
		writeJSON(w, http.StatusOK, map[string]any{"entries": entries, "next_cursor": next})
	}))
	return mux
}

func serveControl(ctx context.Context, token string, state *runtimeState) *http.Server {
	server := &http.Server{Addr: fmt.Sprintf(":%d", controlPort), Handler: controlHandler(token, state), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			state.logs.append("appd", fmt.Sprintf("control server failed: %v", err))
		}
	}()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	return server
}

func waitReady(ctx context.Context, spec appSpec, state *runtimeState) {
	url := spec.readinessURL()
	client := &http.Client{Timeout: 2 * time.Second}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		response, err := client.Do(req)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 500 {
				state.ready.Store(true)
				state.setStatus("running")
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func restartDelay(restart int) time.Duration {
	delay := 250 * time.Millisecond * time.Duration(1<<min(restart-1, 4))
	return min(delay, 4*time.Second)
}

func childExitError(name string, err error) error {
	if err == nil {
		return fmt.Errorf("%s exited successfully", name)
	}
	return fmt.Errorf("%s exited: %w", name, err)
}

func startApp(spec appSpec, state *runtimeState) (*childProcess, error) {
	child, err := startLogged(commandFor(spec), "app", state.logs)
	if err != nil {
		return nil, fmt.Errorf("start app: %w", err)
	}
	return child, nil
}

func startReadinessWatch(ctx context.Context, spec appSpec, state *runtimeState) context.CancelFunc {
	readyCtx, cancel := context.WithCancel(ctx)
	go waitReady(readyCtx, spec, state)
	return cancel
}

func run(ctx context.Context, spec appSpec, token string) error {
	if err := spec.validate(); err != nil {
		return err
	}
	state := &runtimeState{startedAt: time.Now().UTC(), status: "starting", logs: newLogRing(defaultLogCapacity)}
	serveControl(ctx, token, state)

	caddyfile, err := renderCaddyfile(spec)
	if err != nil {
		return err
	}
	caddyPath := filepath.Join(os.TempDir(), "kortix-app-Caddyfile")
	if err := os.WriteFile(caddyPath, []byte(caddyfile), 0600); err != nil {
		return fmt.Errorf("write Caddyfile: %w", err)
	}

	var app *childProcess
	if spec.StaticRoot == "" {
		app, err = startApp(spec, state)
		if err != nil {
			return err
		}
	}

	caddyCmd := caddyCommand(caddyPath)
	caddyCmd.Env = caddyEnvironment(os.Environ())
	caddyCmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	caddy, err := startLogged(caddyCmd, "caddy", state.logs)
	if err != nil {
		terminate(app)
		return fmt.Errorf("start caddy: %w", err)
	}
	defer os.Remove(caddyPath)

	cancelReady := startReadinessWatch(ctx, spec, state)
	defer func() { cancelReady() }()

	for {
		var appExited <-chan error
		if app != nil {
			appExited = app.exited
		}
		select {
		case <-ctx.Done():
			state.ready.Store(false)
			state.setStatus("stopping")
			terminate(caddy)
			terminate(app)
			state.setStatus("stopped")
			return nil
		case err := <-caddy.exited:
			state.ready.Store(false)
			terminate(app)
			return childExitError("caddy", err)
		case err := <-appExited:
			state.ready.Store(false)
			cancelReady()
			state.statusMu.Lock()
			state.lastExit = fmt.Sprint(err)
			state.statusMu.Unlock()
			if state.restarts >= spec.restartLimit() {
				state.setStatus("failed")
				terminate(caddy)
				return fmt.Errorf(
					"app restart budget exhausted after %d restarts: %w",
					state.restarts,
					childExitError("app", err),
				)
			}
			state.statusMu.Lock()
			state.restarts++
			restart := state.restarts
			state.status = "restarting"
			state.statusMu.Unlock()
			state.logs.append("appd", fmt.Sprintf("app exited; restart %d/%d in %s", restart, spec.restartLimit(), restartDelay(restart)))
			timer := time.NewTimer(restartDelay(restart))
			select {
			case <-ctx.Done():
				timer.Stop()
				terminate(caddy)
				state.setStatus("stopped")
				return nil
			case <-timer.C:
			}
			app, err = startApp(spec, state)
			if err != nil {
				terminate(caddy)
				state.setStatus("failed")
				return err
			}
			cancelReady = startReadinessWatch(ctx, spec, state)
		}
	}
}

func loadSpec() (appSpec, error) {
	raw := os.Getenv("KORTIX_APP_SPEC")
	if raw == "" {
		path := os.Getenv("KORTIX_APP_SPEC_PATH")
		if path == "" {
			path = "/kortix/config/app.json"
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return appSpec{}, fmt.Errorf("read app specification: %w", err)
		}
		raw = string(contents)
	}
	var spec appSpec
	if err := json.Unmarshal([]byte(raw), &spec); err != nil {
		return appSpec{}, fmt.Errorf("parse KORTIX_APP_SPEC: %w", err)
	}
	return spec, spec.validate()
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--daemon" {
		if err := daemonize(daemonPIDPath, daemonLogPath); err != nil {
			log.Fatal(err)
		}
		return
	}
	spec, err := loadSpec()
	if err != nil {
		log.Fatal(err)
	}
	token := os.Getenv("KORTIX_APPD_TOKEN")
	if len(token) < 32 {
		log.Fatal("KORTIX_APPD_TOKEN must contain at least 32 characters")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, spec, token); err != nil {
		log.Fatal(err)
	}
}
