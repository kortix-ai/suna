#![cfg(unix)]

use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};

fn unused_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn spawn_api(port: u16, aggregate: &str) -> Child {
    spawn_api_with_drain(port, aggregate, 300, 500)
}

fn spawn_api_with_drain(
    port: u16,
    aggregate: &str,
    advertised_drain_ms: u64,
    max_graceful_drain_ms: u64,
) -> Child {
    Command::new(env!("CARGO_BIN_EXE_kortix-api"))
        .env_clear()
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("KORTIX_ENV_JSON", aggregate)
        .env("KORTIX_VERSION", "explicit-version")
        .env(
            "SHUTDOWN_ADVERTISED_DRAIN_MS",
            advertised_drain_ms.to_string(),
        )
        .env(
            "SHUTDOWN_MAX_GRACEFUL_DRAIN_MS",
            max_graceful_drain_ms.to_string(),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn raw_request(port: u16, request: &str) -> Option<String> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(100),
    )
    .ok()?;
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    Some(response)
}

fn get(port: u16, path: &str) -> Option<(u16, serde_json::Value)> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(100),
    )
    .ok()?;
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (head, body) = response.split_once("\r\n\r\n")?;
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    Some((status, serde_json::from_str(body).ok()?))
}

fn wait_for_health(port: u16) -> (u16, serde_json::Value) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Some(response) = get(port, "/health") {
            return response;
        }
        sleep(Duration::from_millis(20));
    }
    panic!("API did not start within 5 seconds")
}

fn wait_for_ready(port: u16) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Some((200, body)) = get(port, "/health/ready") {
            return body;
        }
        sleep(Duration::from_millis(1));
    }
    panic!("API readiness did not become observable within 5 seconds")
}

fn terminate(child: &Child) {
    let status = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn aggregate_hydrates_real_startup_and_explicit_values_win() {
    let port = unused_port();
    let mut child = spawn_api(
        port,
        r#"{"INTERNAL_KORTIX_ENV":"aggregate-env","KORTIX_VERSION":"aggregate-version"}"#,
    );
    let (status, body) = wait_for_health(port);
    assert_eq!(status, 200);
    assert_eq!(body["environment"], "aggregate-env");
    assert_eq!(body["version"], "explicit-version");
    terminate(&child);
    assert!(child.wait().unwrap().success());
}

#[test]
fn readiness_never_precedes_sigterm_registration() {
    for iteration in 0..12 {
        let port = unused_port();
        let mut child = spawn_api_with_drain(port, "{}", 0, 100);
        let body = wait_for_ready(port);
        assert_eq!(body["status"], "ok", "iteration {iteration}");

        terminate(&child);
        let status = child.wait().unwrap();
        assert!(
            status.success(),
            "SIGTERM used the default handler after readiness on iteration {iteration}: {status}"
        );
    }
}

#[test]
fn sigterm_advertises_draining_before_listener_stops() {
    let port = unused_port();
    let mut child = spawn_api(port, "{}");
    wait_for_health(port);
    terminate(&child);

    let deadline = Instant::now() + Duration::from_millis(250);
    let mut observed = None;
    while Instant::now() < deadline {
        if let Some(response) = get(port, "/health/ready") {
            observed = Some(response);
            break;
        }
        sleep(Duration::from_millis(10));
    }
    let (status, body) = observed.expect("listener stopped during advertised drain");
    assert_eq!(status, 503);
    assert_eq!(
        body,
        serde_json::json!({"status":"draining", "reason":"shutdown in progress"})
    );

    let deadline = Instant::now() + Duration::from_secs(2);
    let exited_in_time = loop {
        if child.try_wait().unwrap().is_some() {
            break true;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            break false;
        }
        sleep(Duration::from_millis(20));
    };
    let status = child.wait().unwrap();
    assert!(
        exited_in_time,
        "API exceeded advertised plus maximum graceful drain"
    );
    assert!(status.success());
}

#[test]
fn real_server_emits_response_context_and_cors_headers() {
    let port = unused_port();
    let mut child = spawn_api(port, r#"{"INTERNAL_KORTIX_ENV":"preview"}"#);
    wait_for_health(port);

    let incoming = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00";
    let response = raw_request(
        port,
        &format!(
            "GET /v1/health/live HTTP/1.1\r\nHost: localhost\r\nOrigin: https://pr-9.preview.kortix.com\r\ntraceparent: {incoming}\r\nConnection: close\r\n\r\n"
        ),
    )
    .unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    assert!(head.starts_with("HTTP/1.1 200"));
    let lower = head.to_ascii_lowercase();
    assert!(lower.contains("\r\nx-request-id: "));
    assert!(lower.contains("\r\nserver-timing: api;dur="));
    assert!(lower.contains("\r\naccess-control-allow-origin: https://pr-9.preview.kortix.com"));
    let trace_line = lower
        .lines()
        .find(|line| line.starts_with("traceparent: "))
        .unwrap();
    assert!(trace_line.starts_with("traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-"));
    assert!(trace_line.ends_with("-00"));
    assert_ne!(trace_line, format!("traceparent: {incoming}"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(body).unwrap(),
        serde_json::json!({"status":"ok", "event_loop_lag_ms":0})
    );

    terminate(&child);
    assert!(child.wait().unwrap().success());
}
