//! Enrollment (`POST /v1/capture/device/enroll`) against a mock Kortix issuer:
//! `sync enroll` and `sync adopt` store an enrollment exactly like a sign-in,
//! pending and refused answers store nothing, and the machine service's
//! decision (`managed::step`) follows the library's state.

use kortix_backend::memory::{
    cli::{self, SyncEnrollArgs},
    managed::{self, ManagedConfig, Step},
    paths::MemoryPaths,
    settings::Settings,
    sync::issuer::{self, Adoption, EnrollUser, Enrollment},
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const TOKEN: &str = "kortix_enr_synthetictokensynthetictokensynthet";

/// What the mock answers next, and every body it received.
#[derive(Default)]
struct Issuer {
    /// `enrolled`, `pending`, `invalid`, `denied`, `busy`.
    mode: String,
    bodies: Vec<Value>,
    /// The Authorization header of each request.
    auths: Vec<Option<String>>,
    issued: usize,
}

type Shared = Arc<Mutex<Issuer>>;

fn start(state: Shared) -> String {
    use axum::{extract::State, http::{HeaderMap, StatusCode}, routing::post, Json, Router};
    async fn enroll(State(s): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
        let mut st = s.lock().unwrap();
        st.auths.push(headers.get("authorization").and_then(|v| v.to_str().ok()).map(str::to_string));
        st.bodies.push(body.clone());
        if body["enrollment_token"] != TOKEN {
            return (
                StatusCode::UNAUTHORIZED,
                Json(
                    json!({"error": "Unknown enrollment token", "code": "enrollment_token_invalid"}),
                ),
            );
        }
        match st.mode.as_str() {
            "pending" => (
                StatusCode::ACCEPTED,
                Json(
                    json!({"status": "pending", "reason": "approval_required", "enrollment_id": "e1", "retry_after_s": 60}),
                ),
            ),
            "denied" => (
                StatusCode::FORBIDDEN,
                Json(json!({"error": "denied", "code": "enrollment_denied"})),
            ),
            "busy" => (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error": "slow_down"})),
            ),
            _ => {
                st.issued += 1;
                (
                    StatusCode::OK,
                    Json(
                        json!({"status": "enrolled", "device_token": format!("kortix_cap_synthetic{}", st.issued),
                        "token_type": "Bearer", "prefix": "orgs/00000000-0000-4000-8000-000000000001",
                        "device_id": "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "account": {"name": "Example Org"},
                        "member": {"email": "person@example.com"}}),
                    ),
                )
            }
        }
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let app = Router::new()
                    .route("/v1/capture/device/enroll", post(enroll))
                    .with_state(state);
                axum::serve(tokio::net::TcpListener::from_std(listener).unwrap(), app)
                    .await
                    .unwrap();
            });
    });
    url
}

fn library() -> MemoryPaths {
    // Never the OS secret store on a developer's machine.
    std::env::set_var(kortix_backend::secret_store::STORE_ENV, "file");
    MemoryPaths::at(
        std::env::temp_dir().join(format!("kcap-enroll-{}", uuid::Uuid::new_v4().simple())),
    )
}

fn args(url: &str) -> SyncEnrollArgs {
    SyncEnrollArgs {
        issuer: Some(url.to_string()),
        principal: Some("person@example.com".into()),
        account_name: Some("EXAMPLE\\person".into()),
    }
}

#[test]
fn enroll_stores_the_device_like_a_sign_in_and_turns_kortix_sync_on() {
    let state: Shared = Arc::new(Mutex::new(Issuer {
        mode: "enrolled".into(),
        ..Default::default()
    }));
    let url = start(state.clone());
    let paths = library();

    let v = cli::sync_enroll(&paths, &args(&url), TOKEN).unwrap();
    assert_eq!(v["status"], "enrolled", "{v}");
    assert_eq!(v["device_id"], "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
    assert_eq!(v["account_name"], "Example Org");

    // The request carries the contract's fields; the machine key is hashed.
    let body = state.lock().unwrap().bodies[0].clone();
    assert_eq!(
        body["user"],
        json!({"principal_name": "person@example.com", "account_name": "EXAMPLE\\person"})
    );
    let key = body["machine_key_sha256"].as_str().unwrap();
    assert!(
        key.len() == 64
            && key
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
    for k in ["hostname", "os", "os_version", "arch", "app_version"] {
        assert!(body["device"][k].is_string(), "device.{k} missing: {body}");
    }

    // Stored exactly like a sign-in: registration without secrets, the token in the secret store.
    let r = issuer::registration(&paths).unwrap();
    assert!(r.managed);
    assert_eq!(r.prefix, "orgs/00000000-0000-4000-8000-000000000001");
    assert_eq!(r.member_email.as_deref(), Some("person@example.com"));
    assert_eq!(r.account_name.as_deref(), Some("Example Org"));
    assert!(
        std::fs::read_to_string(paths.root.join("sync-device-token"))
            .unwrap()
            .starts_with("kortix_cap_synthetic1")
    );
    let on_disk = std::fs::read_to_string(paths.root.join("sync-issuer.json")).unwrap()
        + &std::fs::read_to_string(paths.settings()).unwrap();
    assert!(
        !on_disk.contains("kortix_cap_") && !on_disk.contains(TOKEN),
        "a secret leaked to disk: {on_disk}"
    );
    let s = Settings::load(&paths);
    assert!(s.sync.enabled && s.sync.provider == "kortix" && s.sync.kortix.url == url);

    // The machine service now runs this library instead of enrolling it again.
    let status = cli::sync_status_value(&paths);
    let cfg = ManagedConfig::from_values(Some(url.clone()), Some(TOKEN.into())).unwrap();
    assert_eq!(managed::step(&status, &cfg), Step::Run, "{status}");
    let elsewhere =
        ManagedConfig::from_values(Some("https://other.example".into()), Some(TOKEN.into()))
            .unwrap();
    assert_eq!(managed::step(&status, &elsewhere), Step::Enroll);

    // Enrolling again replaces the token (the issuer revokes the old one).
    cli::sync_enroll(&paths, &args(&url), TOKEN).unwrap();
    assert!(
        std::fs::read_to_string(paths.root.join("sync-device-token"))
            .unwrap()
            .starts_with("kortix_cap_synthetic2")
    );
    let _ = std::fs::remove_dir_all(&paths.root);
}

#[test]
fn pending_refused_and_busy_answers_store_nothing() {
    let state: Shared = Arc::new(Mutex::new(Issuer {
        mode: "pending".into(),
        ..Default::default()
    }));
    let url = start(state.clone());
    let paths = library();

    let v = cli::sync_enroll(&paths, &args(&url), TOKEN).unwrap();
    assert_eq!(
        v,
        json!({"status": "pending", "reason": "approval_required", "enrollment_id": "e1", "retry_after_s": 60})
    );
    assert!(issuer::registration(&paths).is_none());

    let v = cli::sync_enroll(&paths, &args(&url), "kortix_enr_wrong").unwrap();
    assert_eq!(v["status"], "refused");
    assert_eq!(v["code"], "enrollment_token_invalid");
    assert_eq!(v["retry_after_s"], 3600);

    state.lock().unwrap().mode = "denied".into();
    let v = cli::sync_enroll(&paths, &args(&url), TOKEN).unwrap();
    assert_eq!(
        (v["code"].as_str(), v["retry_after_s"].as_u64()),
        (Some("enrollment_denied"), Some(6 * 3600))
    );

    // 429 and 5xx are transport-level: the caller retries in a minute.
    state.lock().unwrap().mode = "busy".into();
    let user = EnrollUser {
        principal_name: None,
        account_name: "EXAMPLE\\person".into(),
    };
    let err = issuer::enroll(
        &url,
        TOKEN,
        &user,
        &kortix_backend::memory::sync::identity(&paths),
        None,
    )
    .unwrap_err();
    assert_eq!(
        kortix_backend::memory::sync::classify(&err),
        kortix_backend::memory::sync::ErrorClass::Transient
    );
    assert_eq!(
        managed::after_enrollment(&Err(err)).2,
        Duration::from_secs(60)
    );

    assert!(issuer::registration(&paths).is_none());
    assert!(
        !Settings::load(&paths).sync.enabled,
        "nothing turned sync on"
    );
    // No library may record before its enrollment: the managed service wants nothing.
    let status = cli::sync_status_value(&paths);
    assert_eq!(
        kortix_backend::memory::service::want_managed(&status, false, true),
        Default::default()
    );
    let _ = std::fs::remove_dir_all(&paths.root);
}

#[test]
fn adopt_stores_what_the_machine_service_enrolled() {
    let paths = library();
    let a = Adoption {
        issuer: "https://api.kortix.example/".into(),
        device_token: "kortix_cap_handedover".into(),
        prefix: "/orgs/o1/".into(),
        device_id: "d-1".into(),
        member_email: None,
        account_name: Some("Example Org".into()),
    };
    // The JSON the machine service writes to `sync adopt`'s stdin round-trips.
    let wire: Adoption = serde_json::from_str(&serde_json::to_string(&a).unwrap()).unwrap();
    issuer::adopt(&paths, &wire).unwrap();
    let r = issuer::registration(&paths).unwrap();
    assert_eq!(
        (r.issuer.as_str(), r.prefix.as_str(), r.managed),
        ("https://api.kortix.example", "orgs/o1", true)
    );
    let s = Settings::load(&paths);
    assert!(s.sync.enabled && s.sync.kortix.url == "https://api.kortix.example");
    // A token or device id the issuer did not really give is refused.
    for bad in [
        Adoption {
            device_token: " ".into(),
            ..a.clone()
        },
        Adoption {
            device_id: "../x".into(),
            ..a.clone()
        },
        Adoption {
            issuer: "file:///etc".into(),
            ..a.clone()
        },
    ] {
        assert!(issuer::adopt(&library(), &bad).is_err(), "{bad:?}");
    }
    let _ = std::fs::remove_dir_all(&paths.root);
}

#[test]
fn the_answer_table_matches_the_contract() {
    let ok = issuer::enrollment_answer(
        "https://k",
        202,
        &json!({"status": "pending", "reason": "approval_required", "retry_after_s": 1}),
    )
    .unwrap();
    // A wait below 10 s is raised to 10 s: a misbehaving server cannot make devices hammer it.
    assert_eq!(ok.retry_after(), Duration::from_secs(10));
    for (status, code, hours) in [
        (401, "enrollment_token_invalid", 1),
        (403, "capture_disabled", 1),
        (403, "enrollment_domain_not_allowed", 6),
        (403, "enrollment_limit_reached", 1),
        (400, "invalid_request", 1),
    ] {
        let body = if code == "invalid_request" {
            json!({"error": code})
        } else {
            json!({"code": code})
        };
        match issuer::enrollment_answer("https://k", status, &body).unwrap() {
            Enrollment::Refused {
                code: c,
                retry_after,
            } => {
                assert_eq!(
                    (c.as_str(), retry_after),
                    (code, Duration::from_secs(hours * 3600))
                );
            }
            other => panic!("{status} {code}: {other:?}"),
        }
    }
}

#[test]
fn a_computer_that_holds_a_device_token_sends_it_when_it_enrolls_again() {
    let state: Shared = Arc::new(Mutex::new(Issuer {
        mode: "enrolled".into(),
        ..Default::default()
    }));
    let url = start(state.clone());
    let paths = library();
    let a = args(&url);
    // First enrollment: nothing to prove yet.
    cli::sync_enroll(&paths, &a, TOKEN).unwrap();
    assert_eq!(state.lock().unwrap().auths[0], None);
    // Again, with the token the first one issued as proof.
    cli::sync_enroll(&paths, &a, TOKEN).unwrap();
    assert_eq!(
        state.lock().unwrap().auths[1].as_deref(),
        Some("Bearer kortix_cap_synthetic1")
    );
    // "Wait for an admin" (202) changes nothing: the held token is kept.
    state.lock().unwrap().mode = "pending".into();
    let v = cli::sync_enroll(&paths, &a, TOKEN).unwrap();
    assert_eq!(v["status"], "pending");
    assert_eq!(
        state.lock().unwrap().auths[2].as_deref(),
        Some("Bearer kortix_cap_synthetic2")
    );
    assert_eq!(
        issuer::held_device_token(&paths, &url).as_deref(),
        Some("kortix_cap_synthetic2")
    );
    let _ = std::fs::remove_dir_all(&paths.root);
}
