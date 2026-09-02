use std::collections::HashMap;

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
}

impl Config {
    pub fn from_process_env() -> Result<Self> {
        let env = hydrate_environment(std::env::vars().collect())?;
        Self::from_environment(&env)
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
        })
    }
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
