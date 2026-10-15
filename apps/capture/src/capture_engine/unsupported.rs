//! Stubs so the shared engine code compiles on macOS, where the Swift engine
//! (`native/macos/CaptureEngine.swift`) serves the protocol instead.
#![allow(dead_code)]

use super::*;
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

pub fn init() {}
pub fn permissions() -> Value {
    permissions_json(false, false)
}
pub fn preflight() -> Option<&'static str> {
    Some("unsupported_platform")
}
pub fn idle_seconds() -> f64 {
    0.0
}
pub fn session_locked() -> bool {
    false
}
pub fn foreground() -> Option<Foreground> {
    None
}
pub fn browser_url(_: &Foreground) -> Option<String> {
    None
}
pub fn ax_tree(_: &Foreground, _: usize, _: usize) -> Option<AxResult> {
    None
}
pub fn windows(_: &Foreground) -> Vec<WinInfo> {
    Vec::new()
}
pub fn screenshot(_: Option<Rect>) -> Result<Shot> {
    bail!("unsupported_platform")
}
pub fn displays() -> Vec<DisplayInfo> {
    Vec::new()
}
pub fn screenshot_display(_: &DisplayInfo) -> Result<RgbImage> {
    bail!("unsupported_platform")
}
pub fn ocr(_: &str, _: &RgbaImage, _: &str, _: &[String]) -> Result<Vec<Word>> {
    bail!("unsupported_platform")
}
pub fn icon(_: &str, _: u32) -> Result<IconResult> {
    bail!("unsupported_platform")
}
pub fn encode(_: &[String], _: &str, _: u32, _: u32, _: f64) -> Result<usize> {
    bail!("unsupported_platform")
}
pub fn extract_frame(_: &str, _: usize) -> Result<RgbImage> {
    bail!("unsupported_platform")
}
pub fn extract_all(_: &str, _: usize, _: &Path) -> Result<Vec<PathBuf>> {
    bail!("unsupported_platform")
}

pub fn audio_source(_: &str, _: Option<&str>) -> i32 {
    super::audio::fail("audio sources run in the Swift engine on macOS", 1)
}
pub fn encode_audio(_: &str, _: &str, _: u32, _: u32) -> Result<()> {
    anyhow::bail!("unsupported platform")
}
pub fn audio_devices() -> Result<Value> {
    anyhow::bail!("unsupported platform")
}
