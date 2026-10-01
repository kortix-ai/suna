//! Timerange, timestamp, moment, and duration handling shared by the read commands.
//! All wall-clock values are local time, printed as `YYYY-MM-DDTHH:MM:SS`.

use anyhow::{bail, Result};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};

/// Inclusive millisecond bounds; `None` is open.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TimeRange {
    pub start: Option<i64>,
    pub end: Option<i64>,
}

const RANGE_HELP: &str = "Accepted values:\n  Single day: 2025-01-15  (expands to entire day 00:00–23:59:59)\n  Explicit:   2025-01-01|2025-01-31  or  2025-01-01T09:00|2025-01-31T17:00\n  Bounds:     since:2025-01-01  or  before:2025-06-01\n              since:2025-01-01|before:2025-06-01";

fn local_ms(n: NaiveDateTime) -> Option<i64> {
    let t = Local.from_local_datetime(&n);
    t.earliest().or_else(|| t.latest()).map(|d| d.timestamp_millis())
}

enum Point {
    Day(NaiveDate),
    Instant(i64),
}

fn parse_point(s: &str) -> Option<Point> {
    let s = s.trim();
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(Point::Day(d));
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, fmt) {
            return local_ms(n).map(Point::Instant);
        }
    }
    None
}

fn day_start(d: NaiveDate) -> Option<i64> {
    local_ms(d.and_time(NaiveTime::MIN))
}

fn day_end(d: NaiveDate) -> Option<i64> {
    day_start(d.succ_opt()?).map(|t| t - 1)
}

pub fn parse_range(s: &str) -> Result<TimeRange> {
    let bad = || anyhow::anyhow!("Unknown timerange: '{s}'.\n{RANGE_HELP}");
    let mut r = TimeRange::default();
    let parts: Vec<&str> = s.split('|').map(str::trim).collect();
    if parts.len() > 2 || parts.iter().any(|p| p.is_empty()) {
        return Err(bad());
    }
    let mut plain = 0;
    for p in &parts {
        let (kind, text) = match (p.strip_prefix("since:"), p.strip_prefix("before:")) {
            (Some(t), _) => ("since", t),
            (_, Some(t)) => ("before", t),
            _ => {
                plain += 1;
                (if plain == 1 { "since" } else { "before" }, *p)
            }
        };
        let point = parse_point(text).ok_or_else(bad)?;
        if kind == "since" {
            if r.start.is_some() {
                return Err(bad());
            }
            r.start = match point {
                Point::Day(d) => day_start(d),
                Point::Instant(t) => Some(t),
            };
        } else {
            if r.end.is_some() {
                return Err(bad());
            }
            r.end = match point {
                Point::Day(d) => day_end(d),
                Point::Instant(t) => Some(t),
            };
        }
    }
    if parts.len() == 1 && plain == 1 {
        // A lone value must be a whole day.
        match parse_point(parts[0]) {
            Some(Point::Day(d)) => return Ok(TimeRange { start: day_start(d), end: day_end(d) }),
            _ => return Err(bad()),
        }
    }
    Ok(r)
}

/// Point-in-time `--ts` value, milliseconds since the epoch.
pub fn parse_ts(s: &str) -> Result<i64> {
    match parse_point(s) {
        Some(Point::Instant(t)) => Ok(t),
        Some(Point::Day(d)) => day_start(d).ok_or_else(|| anyhow::anyhow!("invalid timestamp '{s}'")),
        None => bail!("invalid timestamp '{s}' (use 2026-01-15T09:30 or 2026-01-15T09:30:45)"),
    }
}

/// `now`, `20m`, `-2h`, `3d ago`, or an ISO timestamp -> epoch ms. Future moments are rejected.
pub fn parse_moment(input: &str, now_ms: i64) -> Result<i64> {
    let s = input.trim();
    let low = s.to_ascii_lowercase();
    let ms = if low == "now" {
        now_ms
    } else if let Some(offset) = parse_offset(&low) {
        now_ms - offset
    } else {
        match parse_point(s) {
            Some(Point::Instant(t)) => t,
            Some(Point::Day(_)) => bail!(
                "'{s}' names a day but not a time, and a link points at an instant. Add one, e.g. {s}T09:00 — or say '2h ago'."
            ),
            None => bail!(
                "could not read '{s}' as a moment.\nUse 'now', a relative offset like '20m' / '-2h' / '3d ago', or an ISO timestamp like 2025-01-15T09:30."
            ),
        }
    };
    if ms > now_ms + 1000 {
        bail!("'{s}' is in the future; a link into the future can never resolve.");
    }
    Ok(ms.min(now_ms))
}

fn parse_offset(low: &str) -> Option<i64> {
    let t = low.strip_suffix("ago").unwrap_or(low).trim().trim_start_matches('-');
    let split = t.find(|c: char| !c.is_ascii_digit() && c != '.')?;
    let (num, unit) = t.split_at(split);
    let n: f64 = num.parse().ok()?;
    let mult = match unit.trim() {
        "s" | "sec" | "secs" | "second" | "seconds" => 1_000.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 60_000.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3_600_000.0,
        "d" | "day" | "days" => 86_400_000.0,
        "w" | "week" | "weeks" => 604_800_000.0,
        _ => return None,
    };
    Some((n * mult) as i64)
}

fn local(ms: i64) -> DateTime<Local> {
    DateTime::from_timestamp_millis(ms).unwrap_or_default().with_timezone(&Local)
}

/// Local ISO timestamp, no zone: `2026-01-15T09:30:45`.
pub fn iso(ms: i64) -> String {
    local(ms).format("%Y-%m-%dT%H:%M:%S").to_string()
}

pub fn hhmm(ms: i64) -> String {
    local(ms).format("%H:%M").to_string()
}

pub fn day_of(ms: i64) -> String {
    local(ms).format("%Y-%m-%d").to_string()
}

pub fn mmddhhmm(ms: i64) -> String {
    local(ms).format("%m-%dT%H:%M").to_string()
}

/// `8h 7m 8s`, `1m`, `0s`.
pub fn human(secs: i64) -> String {
    let secs = secs.max(0);
    let (h, m, s) = (secs / 3600, secs % 3600 / 60, secs % 60);
    let mut out = Vec::new();
    if h > 0 {
        out.push(format!("{h}h"));
    }
    if m > 0 {
        out.push(format!("{m}m"));
    }
    if s > 0 || out.is_empty() {
        out.push(format!("{s}s"));
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(s: &str) -> i64 {
        parse_ts(s).unwrap()
    }

    #[test]
    fn whole_day_and_ranges() {
        let r = parse_range("2026-01-15").unwrap();
        assert_eq!(r.start, Some(ms("2026-01-15T00:00")));
        assert_eq!(r.end, Some(ms("2026-01-16T00:00") - 1));
        let r = parse_range("2026-01-01|2026-01-31").unwrap();
        assert_eq!(r.start, Some(ms("2026-01-01T00:00")));
        assert_eq!(r.end, Some(ms("2026-02-01T00:00") - 1));
        let r = parse_range("2026-01-01T09:00|2026-01-01T17:30:15").unwrap();
        assert_eq!(r.start, Some(ms("2026-01-01T09:00")));
        assert_eq!(r.end, Some(ms("2026-01-01T17:30:15")));
    }

    #[test]
    fn bounds_combine() {
        assert_eq!(parse_range("since:2026-01-01").unwrap().end, None);
        assert_eq!(parse_range("before:2026-06-01").unwrap().start, None);
        let r = parse_range("since:2026-01-01|before:2026-06-01").unwrap();
        assert_eq!(r.start, Some(ms("2026-01-01T00:00")));
        assert_eq!(r.end, Some(ms("2026-06-02T00:00") - 1));
    }

    #[test]
    fn rejects_bad_ranges() {
        for bad in ["garbage", "2026-01-15T10", "", "a|b|c", "2026-01-15T09:00", "since:x"] {
            assert!(parse_range(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn moments() {
        let now = ms("2026-01-15T12:00:00");
        assert_eq!(parse_moment("now", now).unwrap(), now);
        assert_eq!(parse_moment("20m", now).unwrap(), now - 20 * 60_000);
        assert_eq!(parse_moment("-2h", now).unwrap(), now - 2 * 3_600_000);
        assert_eq!(parse_moment("3d ago", now).unwrap(), now - 3 * 86_400_000);
        assert_eq!(parse_moment("2026-01-15T09:30", now).unwrap(), ms("2026-01-15T09:30"));
        assert!(parse_moment("2026-01-15T13:00", now).unwrap_err().to_string().contains("future"));
        assert!(parse_moment("2026-01-15", now).unwrap_err().to_string().contains("names a day"));
        assert!(parse_moment("soon", now).is_err());
    }

    #[test]
    fn durations_and_iso() {
        assert_eq!(human(29228), "8h 7m 8s");
        assert_eq!(human(60), "1m");
        assert_eq!(human(0), "0s");
        assert_eq!(human(3600), "1h");
        assert_eq!(iso(ms("2026-01-15T09:30:45")), "2026-01-15T09:30:45");
    }
}
