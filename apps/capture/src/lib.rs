//! Kortix Capture recorder. See `memory` for the module map.

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub mod capture_engine;
pub mod memory;
