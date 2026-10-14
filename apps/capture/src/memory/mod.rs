//! Kortix Capture: a 24/7 recorder of what is on screen, searchable by
//! people (timeline UI) and agents (`kortix-capture` CLI).
//!
//! Capture runs in a native sidecar (`native/macos/CaptureEngine.swift`); this
//! module owns policy, storage, retention, and queries. See
//! `.agents/skills/kortix-capture/references/app-behavior.md` for the feature map.

pub mod action_exclusions;
pub mod actions;
pub mod agent;
pub mod ask;
pub mod audio;
pub mod axrender;
pub mod cli;
pub mod engine;
pub mod exclusions;
pub mod frames;
pub mod legacy;
pub mod managed;
pub mod onboarding;
pub mod paths;
pub mod policy;
pub mod privacy;
pub mod privacy_model;
pub mod query;
pub mod recorder;
pub mod redaction;
pub mod reserve;
pub mod retention;
pub mod screen;
pub mod service;
pub mod settings;
pub mod store;
pub mod sync;
pub mod tfidf;
pub mod timerange;
pub mod ui;
