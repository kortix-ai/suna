use std::{error::Error, fmt};

/// An error of the action recorder, with the sentence the service logs.
#[derive(Debug, Clone)]
pub struct AppError {
    pub detail: String,
}

impl AppError {
    fn new(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
        }
    }

    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(detail)
    }

    pub fn conflict(detail: impl Into<String>) -> Self {
        Self::new(detail)
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(detail)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.detail)
    }
}

impl Error for AppError {}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        AppError::internal(value.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
