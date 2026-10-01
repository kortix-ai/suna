//! Kortix Capture recorder: captures what is on screen about every 2 seconds,
//! extracts its text, encodes 1 fps video chunks, and uploads them to the
//! user's Kortix account.
//!
//! Capture runs in a native sidecar (`native/macos/CaptureEngine.swift` on
//! macOS, `capture_engine` on Windows and Linux). These modules own policy,
//! storage, retention, upload, and local queries.
//!
//! - `recorder`: capture, OCR, and finalizer threads; the `recorder.json` status file.
//! - `uploader`: the capture gate (`GET /v1/capture/agent/config`) and chunk upload
//!   (`POST /chunks`, `PUT`, `POST /commit`) with backoff; local expiry after upload.
//! - `store`, `paths`, `settings`, `retention`, `engine`, `frames`: library layout.
//! - `cli`, `query`, `agent`, `timerange`, `axrender`, `tfidf`, `screen`: the
//!   `kortix-capture` commands for local debugging and agent retrieval.
//!
//! Data directory: `ai.kortix.capture` under the platform data dir, or
//! `$KORTIX_CAPTURE_DIR`. See `apps/capture/AGENTS.md` for build, test, and env vars.

pub mod agent;
pub mod axrender;
pub mod cli;
pub mod engine;
pub mod frames;
pub mod paths;
pub mod query;
pub mod recorder;
pub mod retention;
pub mod screen;
pub mod settings;
pub mod store;
pub mod tfidf;
pub mod timerange;
pub mod uploader;
