use std::{collections::HashMap, time::Duration};

use anyhow::{bail, Context, Result};
use serde_json::Value;

pub const AGGREGATE_ENV_KEY: &str = "KORTIX_ENV_JSON";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub bind_addr: String,
    pub environment: String,
    pub version: String,
    pub commit: String,
    pub instance: String,
    pub max_event_loop_lag_ms: u64,
    pub cors_allowed_origins: Vec<String>,
    pub advertised_drain: Duration,
    pub max_graceful_drain: Duration,
}

impl Config {
    pub fn from_process_env() -> Result<Self> {
        let original: HashMap<String, String> = std::env::vars().collect();
        let hydrated = hydrate_environment(original.clone())?;
        let config = Self::from_environment(&hydrated)?;
        apply_process_environment(&original, &hydrated);
        Ok(config)
    }

    pub fn from_environment(env: &HashMap<String, String>) -> Result<Self> {
        let host = env
            .get("HOST")
            .cloned()
            .unwrap_or_else(|| "0.0.0.0".to_owned());
        let port = env.get("PORT").map(String::as_str).unwrap_or("8008");
        let port: u16 = port
            .parse()
            .context("PORT must be an integer from 0 to 65535")?;
        let max_event_loop_lag_ms = parse_u64(env, "HEALTH_MAX_EVENT_LOOP_LAG_MS", 5_000)?;
        let advertised_drain_ms = parse_u64(env, "SHUTDOWN_ADVERTISED_DRAIN_MS", 30_000)?;
        let max_graceful_drain_ms = parse_u64(env, "SHUTDOWN_MAX_GRACEFUL_DRAIN_MS", 30_000)?;

        Ok(Self {
            bind_addr: format!("{host}:{port}"),
            environment: env
                .get("INTERNAL_KORTIX_ENV")
                .cloned()
                .unwrap_or_else(|| "dev".to_owned()),
            version: env
                .get("KORTIX_VERSION")
                .cloned()
                .unwrap_or_else(|| "dev".to_owned()),
            commit: env
                .get("KORTIX_COMMIT")
                .cloned()
                .unwrap_or_else(|| "unknown".to_owned()),
            instance: env
                .get("HOSTNAME")
                .cloned()
                .unwrap_or_else(|| "unknown".to_owned()),
            max_event_loop_lag_ms,
            cors_allowed_origins: env
                .get("CORS_ALLOWED_ORIGINS")
                .map(|origins| {
                    origins
                        .split(',')
                        .map(str::trim)
                        .filter(|origin| !origin.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            advertised_drain: Duration::from_millis(advertised_drain_ms),
            max_graceful_drain: Duration::from_millis(max_graceful_drain_ms),
        })
    }
}

fn parse_u64(env: &HashMap<String, String>, key: &str, default: u64) -> Result<u64> {
    env.get(key).map_or(Ok(default), |value| {
        value
            .parse()
            .with_context(|| format!("{key} must be a non-negative integer"))
    })
}

fn apply_process_environment(
    original: &HashMap<String, String>,
    hydrated: &HashMap<String, String>,
) {
    for (key, value) in hydrated {
        if !original.contains_key(key) {
            std::env::set_var(key, value);
        }
    }
    std::env::remove_var(AGGREGATE_ENV_KEY);
}

/// Expands the aggregate ECS secret into an environment snapshot.
///
/// Explicit environment variables take precedence over values from the JSON
/// object. The aggregate secret is removed from the returned snapshot. The
/// input is validated in full before any values are hydrated.
pub fn hydrate_environment(mut env: HashMap<String, String>) -> Result<HashMap<String, String>> {
    let Some(raw) = env.remove(AGGREGATE_ENV_KEY) else {
        return Ok(env);
    };

    let value: Value = serde_json::from_str(&raw)
        .map_err(|_| anyhow::anyhow!("{AGGREGATE_ENV_KEY} must contain a JSON object"))?;
    let Some(object) = value.as_object() else {
        bail!("{AGGREGATE_ENV_KEY} must contain a JSON object");
    };

    let mut hydrated = Vec::with_capacity(object.len());
    for (key, value) in object {
        let Some(value) = value.as_str() else {
            bail!(r#"{AGGREGATE_ENV_KEY} key "{key}" must be a string"#);
        };
        if key.is_empty() || key.contains(['=', '\0']) {
            bail!(r#"{AGGREGATE_ENV_KEY} key "{key}" is not a valid environment variable name"#);
        }
        if value.contains('\0') {
            bail!(r#"{AGGREGATE_ENV_KEY} key "{key}" contains a null byte"#);
        }
        hydrated.push((key.clone(), value.to_owned()));
    }

    for (key, value) in hydrated {
        env.entry(key).or_insert(value);
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn hydrates_strings_and_removes_aggregate_secret() {
        let hydrated = hydrate_environment(env(&[(
            AGGREGATE_ENV_KEY,
            r#"{"DATABASE_URL":"postgres://example","TOKEN":"secret"}"#,
        )]))
        .unwrap();

        assert_eq!(hydrated.get("DATABASE_URL").unwrap(), "postgres://example");
        assert_eq!(hydrated.get("TOKEN").unwrap(), "secret");
        assert!(!hydrated.contains_key(AGGREGATE_ENV_KEY));
    }

    #[test]
    fn explicit_environment_has_precedence() {
        let hydrated = hydrate_environment(env(&[
            ("KORTIX_VERSION", "0.12.4"),
            (AGGREGATE_ENV_KEY, r#"{"KORTIX_VERSION":"stale"}"#),
        ]))
        .unwrap();

        assert_eq!(hydrated.get("KORTIX_VERSION").unwrap(), "0.12.4");
    }

    #[test]
    fn rejects_malformed_and_non_object_json() {
        for raw in ["not-json", "null", "[]", r#""value""#] {
            let error = hydrate_environment(env(&[(AGGREGATE_ENV_KEY, raw)])).unwrap_err();
            assert_eq!(
                error.to_string(),
                "KORTIX_ENV_JSON must contain a JSON object"
            );
        }
    }

    #[test]
    fn rejects_entries_that_cannot_be_process_variables() {
        for (raw, expected) in [
            (
                r#"{"":"value"}"#,
                r#"KORTIX_ENV_JSON key "" is not a valid environment variable name"#,
            ),
            (
                r#"{"BAD=KEY":"value"}"#,
                r#"KORTIX_ENV_JSON key "BAD=KEY" is not a valid environment variable name"#,
            ),
            (
                r#"{"KEY":"bad\u0000value"}"#,
                r#"KORTIX_ENV_JSON key "KEY" contains a null byte"#,
            ),
        ] {
            assert_eq!(
                hydrate_environment(env(&[(AGGREGATE_ENV_KEY, raw)]))
                    .unwrap_err()
                    .to_string(),
                expected
            );
        }
    }

    #[test]
    fn parses_health_and_shutdown_limits() {
        let config = Config::from_environment(&env(&[
            ("HEALTH_MAX_EVENT_LOOP_LAG_MS", "123"),
            ("SHUTDOWN_ADVERTISED_DRAIN_MS", "456"),
            ("SHUTDOWN_MAX_GRACEFUL_DRAIN_MS", "789"),
        ]))
        .unwrap();
        assert_eq!(config.max_event_loop_lag_ms, 123);
        assert_eq!(config.advertised_drain, Duration::from_millis(456));
        assert_eq!(config.max_graceful_drain, Duration::from_millis(789));
    }

    #[test]
    fn process_hydration_subprocess_proves_mutation_and_removal() {
        const CHILD: &str = "KORTIX_PROCESS_HYDRATION_CHILD";
        if std::env::var_os(CHILD).is_some() {
            Config::from_process_env().unwrap();
            assert_eq!(std::env::var("HYDRATED_ONLY").unwrap(), "from-json");
            assert_eq!(std::env::var("EXPLICIT_WINS").unwrap(), "explicit");
            assert!(std::env::var_os(AGGREGATE_ENV_KEY).is_none());
            return;
        }

        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("config::tests::process_hydration_subprocess_proves_mutation_and_removal")
            .arg("--exact")
            .arg("--nocapture")
            .env(CHILD, "1")
            .env("EXPLICIT_WINS", "explicit")
            .env(
                AGGREGATE_ENV_KEY,
                r#"{"HYDRATED_ONLY":"from-json","EXPLICIT_WINS":"aggregate"}"#,
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "child failed:
stdout: {}
stderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn invalid_config_does_not_partially_hydrate_process() {
        const CHILD: &str = "KORTIX_INVALID_CONFIG_CHILD";
        if std::env::var_os(CHILD).is_some() {
            assert!(Config::from_process_env().is_err());
            assert!(std::env::var_os("MUST_NOT_BE_SET").is_none());
            assert!(std::env::var_os(AGGREGATE_ENV_KEY).is_some());
            return;
        }

        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("config::tests::invalid_config_does_not_partially_hydrate_process")
            .arg("--exact")
            .env(CHILD, "1")
            .env(
                AGGREGATE_ENV_KEY,
                r#"{"PORT":"invalid","MUST_NOT_BE_SET":"value"}"#,
            )
            .output()
            .unwrap();
        assert!(output.status.success());
    }

    #[test]
    fn rejects_non_string_values() {
        let error = hydrate_environment(env(&[(
            AGGREGATE_ENV_KEY,
            r#"{"DATABASE_URL":"valid","PORT":8000}"#,
        )]))
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            r#"KORTIX_ENV_JSON key "PORT" must be a string"#
        );
    }
}
