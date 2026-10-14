#!/usr/bin/env python3
"""Generate a standalone HTML visualization for one processed recording trace."""

from __future__ import annotations

import argparse
import copy
import html
import json
from pathlib import Path
from typing import Any

from compare_screenshot_sync import read_jsonl, start_timestamp, timestamp
from render_trace_review_sheet import action_summary, format_key_label

SYNC_WARNING_GAP_SECONDS = 0.75


def event_type(event: dict[str, Any]) -> str:
    return str(event.get("type") or "")


def is_screenshot(event: dict[str, Any]) -> bool:
    return event_type(event) == "screenshot"


def is_action(event: dict[str, Any]) -> bool:
    return event_type(event) not in {"", "screenshot", "a11y+screenshot", "sleep"}


def is_review_event(event: dict[str, Any]) -> bool:
    return event_type(event) not in {"", "screenshot", "a11y+screenshot"}


def is_sleep(event: dict[str, Any]) -> bool:
    return event_type(event) == "sleep"


def payload(event: dict[str, Any]) -> dict[str, Any]:
    value = event.get("args") or event.get("data") or {}
    return value if isinstance(value, dict) else {}


def as_display_id(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None

def image_data_url_from_payload(value: dict[str, Any]) -> str | None:
    image = value.get("image")
    if not isinstance(image, str) or not image:
        return None
    encoding = str(value.get("encoding") or "jpg").lower()
    mime = "image/png" if encoding == "png" else "image/jpeg"
    return f"data:{mime};base64,{image}"

def image_data_url(event: dict[str, Any]) -> str | None:
    return image_data_url_from_payload(payload(event))

def screenshot_displays(screenshot: dict[str, Any]) -> list[dict[str, Any]]:
    displays = payload(screenshot).get("displays")
    if not isinstance(displays, list):
        return []
    return [display for display in displays if isinstance(display, dict)]

def display_label(display_id: int | None) -> str:
    return f"display {display_id}" if display_id is not None else "top-level image"

def add_preference(
    preferences: list[tuple[int, str]],
    seen: set[int],
    value: Any,
    reason: str,
) -> None:
    display_id = as_display_id(value)
    if display_id is not None and display_id not in seen:
        preferences.append((display_id, reason))
        seen.add(display_id)

def choose_screenshot_view(
    screenshot: dict[str, Any],
    action: dict[str, Any] | None = None,
) -> dict[str, Any]:
    args = payload(screenshot)
    displays = screenshot_displays(screenshot)
    preferences: list[tuple[int, str]] = []
    seen: set[int] = set()

    if action is not None:
        add_preference(preferences, seen, payload(action).get("display_id"), "action display_id")
    add_preference(preferences, seen, args.get("active_display_id"), "active_display_id")
    add_preference(preferences, seen, args.get("focused_display_id"), "focused_display_id")
    add_preference(preferences, seen, args.get("current_display_id"), "current_display_id")
    add_preference(preferences, seen, args.get("pointer_display_id"), "pointer_display_id")
    for display in displays:
        if display.get("is_primary") is True:
            add_preference(preferences, seen, display.get("display_id"), "primary display fallback")
    for display in displays:
        add_preference(preferences, seen, display.get("display_id"), "first display fallback")

    for preferred_id, reason in preferences:
        for display in displays:
            if as_display_id(display.get("display_id")) == preferred_id:
                image = image_data_url_from_payload(display)
                if image:
                    return {
                        "image": image,
                        "display": display,
                        "display_id": preferred_id,
                        "reason": reason,
                        "source": "display",
                    }

    return {
        "image": image_data_url(screenshot),
        "display": None,
        "display_id": None,
        "reason": "top-level fallback",
        "source": "top-level",
    }

def normalized_display_bounds(
    display: dict[str, Any] | None,
) -> tuple[float, float, float, float] | None:
    if not isinstance(display, dict):
        return None
    bounds = display.get("normalized_bounds")
    if not isinstance(bounds, dict):
        return None
    x = bounds.get("x")
    y = bounds.get("y")
    width = bounds.get("width")
    height = bounds.get("height")
    if all(isinstance(value, (int, float)) for value in [x, y, width, height]):
        if float(width) > 0 and float(height) > 0:
            return float(x), float(y), float(width), float(height)
    return None


def scrub_large_images(value: Any) -> Any:
    value = copy.deepcopy(value)
    if isinstance(value, dict):
        for key, child in list(value.items()):
            if key == "image" and isinstance(child, str) and len(child) > 120:
                value[key] = f"[base64 image omitted: {len(child)} chars]"
            else:
                value[key] = scrub_large_images(child)
    elif isinstance(value, list):
        value = [scrub_large_images(item) for item in value]
    return value


def json_block(value: Any) -> str:
    return html.escape(json.dumps(scrub_large_images(value), indent=2, sort_keys=True))


def fmt_ts(value: float | int | None) -> str:
    if isinstance(value, (int, float)):
        return f"{float(value):.3f}s"
    return "n/a"


def fmt_delta(value: float | int | None) -> str:
    if isinstance(value, (int, float)):
        return f"{float(value):.3f}s"
    return "n/a"


def action_time_range(action: dict[str, Any]) -> str:
    start = start_timestamp(action)
    end = timestamp(action)
    if abs(end - start) < 0.001:
        return fmt_ts(end)
    return f"{fmt_ts(start)} -> {fmt_ts(end)}"


def fmt_coord(value: Any) -> str:
    if not isinstance(value, (int, float)):
        return "n/a"
    text = f"{float(value):.4f}".rstrip("0").rstrip(".")
    return text or "0"


def fmt_point(x: Any, y: Any) -> str:
    return f"({fmt_coord(x)}, {fmt_coord(y)})"


def action_position_html(action: dict[str, Any]) -> str:
    if event_type(action) != "drag":
        return ""
    args = payload(action)
    start = fmt_point(args.get("start_x"), args.get("start_y"))
    end = fmt_point(args.get("end_x"), args.get("end_y"))
    return f"""
          <div class="position-row">
            <span><strong>Start</strong>{html.escape(start)}</span>
            <span><strong>End</strong>{html.escape(end)}</span>
          </div>
    """


def display_value(action: dict[str, Any]) -> str:
    display_id = payload(action).get("display_id")
    return f"display {display_id}" if display_id is not None else "display n/a"


def event_label(event: dict[str, Any]) -> str:
    typ = event_type(event)
    args = payload(event)
    if typ == "screenshot":
        width = args.get("width")
        height = args.get("height")
        return f"Screenshot {width}x{height}" if width and height else "Screenshot"
    if typ == "sleep":
        return f"Sleep {args.get('duration', '')}s"
    if typ == "click":
        return (
            f"{args.get('button', 'left')} click x{args.get('clicks', 1)} "
            f"at {args.get('x')}, {args.get('y')}"
        )
    if typ == "drag":
        return (
            f"Drag {args.get('button', 'left')} "
            f"{args.get('start_x')}, {args.get('start_y')} -> "
            f"{args.get('end_x')}, {args.get('end_y')}"
        )
    if typ == "press":
        count = args.get("count")
        suffix = f" x{count}" if isinstance(count, int) and count > 1 else ""
        lock_state = args.get("lock_state")
        state_suffix = f" {lock_state}" if lock_state in {"on", "off"} else ""
        return f"Press {args.get('key', '')}{state_suffix}{suffix}"
    if typ == "typewrite":
        return f"Type {json.dumps(str(args.get('text', '')))}"
    if typ == "hotkey":
        return "Hotkey " + "+".join(format_key_label(key) for key in args.get("keys", []))
    if typ == "scroll":
        return f"Scroll {args.get('clicks')} at {args.get('x')}, {args.get('y')}"
    return typ or "unknown"


def marker_points(action: dict[str, Any], marker_kind: str) -> list[tuple[Any, Any, str, str]]:
    args = payload(action)
    typ = event_type(action)
    if typ == "click":
        return [(args.get("x"), args.get("y"), "click", "click-marker")]
    if typ == "drag":
        if marker_kind == "before":
            return [(args.get("start_x"), args.get("start_y"), "drag start", "drag-start")]
        if marker_kind == "after":
            return [(args.get("end_x"), args.get("end_y"), "drag end", "drag-end")]
    if typ == "scroll":
        return [(args.get("x"), args.get("y"), "scroll", "scroll-marker")]
    return []

def remap_marker_point(
    x: Any,
    y: Any,
    screenshot: dict[str, Any],
    selection: dict[str, Any],
) -> tuple[float, float] | None:
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None

    bounds = normalized_display_bounds(selection.get("display"))
    if bounds is not None:
        left, top, width, height = bounds
        local_x = (float(x) - left) / width
        local_y = (float(y) - top) / height
        if 0.0 <= local_x <= 1.0 and 0.0 <= local_y <= 1.0:
            return local_x, local_y
        return None

    args = payload(screenshot)
    if selection.get("source") == "top-level" and (
        args.get("capture_mode") != "all_displays" or not screenshot_displays(screenshot)
    ):
        return float(x), float(y)

    return None

def marker_html(
    action: dict[str, Any],
    marker_kind: str,
    screenshot: dict[str, Any],
    selection: dict[str, Any],
) -> str:
    markers: list[str] = []

    for x, y, label, css_class in marker_points(action, marker_kind):
        point = remap_marker_point(x, y, screenshot, selection)
        if point is None:
            continue
        local_x, local_y = point
        marker_label = label if label != "click" else "click"
        markers.append(
            "<span "
            f"class=\"marker {css_class}\" "
            f"data-label=\"{html.escape(marker_label)}\" "
            f"style=\"left:{local_x * 100:.3f}%;top:{local_y * 100:.3f}%\" "
            f"title=\"{html.escape(label)}\"></span>"
        )

    return "".join(markers)

def selection_note(
    screenshot: dict[str, Any],
    action: dict[str, Any] | None,
    selection: dict[str, Any],
    marker_kind: str,
    markers: str,
) -> str:
    parts = [
        f"showing {display_label(selection.get('display_id'))} from {selection.get('reason')}"
    ]
    if action is not None and marker_kind and marker_points(action, marker_kind):
        if markers:
            parts.append("mouse position annotated")
        elif (
            selection.get("source") == "display"
            and normalized_display_bounds(selection.get("display")) is None
        ):
            parts.append("marker hidden: this recording has no display bounds")
        else:
            parts.append("marker hidden: action point is outside this display")
    return " · ".join(parts)


def screenshot_panel(
    screenshot: dict[str, Any],
    label: str,
    event_index: int | None = None,
    action: dict[str, Any] | None = None,
    marker_kind: str = "",
) -> str:
    selection = choose_screenshot_view(screenshot, action)
    image = selection.get("image")
    ts = fmt_ts(timestamp(screenshot))
    index_label = f"#{event_index} " if event_index is not None else ""
    body = (
        f"<img src=\"{image}\" alt=\"{html.escape(label)} screenshot\">"
        if image
        else "<div class=\"missing-image\">No screenshot image</div>"
    )
    markers = marker_html(action, marker_kind, screenshot, selection) if action else ""
    note = selection_note(screenshot, action, selection, marker_kind, markers)
    return f"""
      <section class="shot-panel">
        <div class="shot-title">{html.escape(label)} <span>{html.escape(index_label)}{ts}</span></div>
        <div class="image-wrap">{body}{markers}</div>
        <div class="shot-note">{html.escape(note)}</div>
      </section>
    """


IndexedTriple = tuple[
    int,
    int,
    dict[str, Any],
    int,
    dict[str, Any],
    int,
    dict[str, Any],
]


def indexed_triples(events: list[dict[str, Any]]) -> list[IndexedTriple]:
    result: list[IndexedTriple] = []
    for action_index, event in enumerate(events):
        if not is_action(event):
            continue
        surrounding = surrounding_screenshots(events, action_index)
        if surrounding:
            before_index, before_event, after_index, after_event = surrounding
            result.append(
                (
                    len(result) + 1,
                    before_index,
                    before_event,
                    action_index,
                    event,
                    after_index,
                    after_event,
                )
            )
    return result


def surrounding_screenshots(
    events: list[dict[str, Any]],
    event_index: int,
) -> tuple[int, dict[str, Any], int, dict[str, Any]] | None:
    before = next(
        (
            (pos, events[pos])
            for pos in range(event_index - 1, -1, -1)
            if is_screenshot(events[pos])
        ),
        None,
    )
    after = next(
        (
            (pos, events[pos])
            for pos in range(event_index + 1, len(events))
            if is_screenshot(events[pos])
        ),
        None,
    )
    if before and after:
        before_index, before_event = before
        after_index, after_event = after
        return before_index, before_event, after_index, after_event
    return None


def next_action_after(events: list[dict[str, Any]], event_index: int) -> tuple[int, dict[str, Any]] | None:
    return next(
        (
            (pos, events[pos])
            for pos in range(event_index + 1, len(events))
            if is_action(events[pos])
        ),
        None,
    )


def previous_action_before(events: list[dict[str, Any]], event_index: int) -> tuple[int, dict[str, Any]] | None:
    return next(
        (
            (pos, events[pos])
            for pos in range(event_index - 1, -1, -1)
            if is_action(events[pos])
        ),
        None,
    )


def indexed_review_items(events: list[dict[str, Any]]) -> list[tuple[str, IndexedTriple]]:
    result: list[tuple[str, IndexedTriple]] = []
    action_number = 0
    for event_index, event in enumerate(events):
        if not is_review_event(event):
            continue
        surrounding = surrounding_screenshots(events, event_index)
        if surrounding:
            before_index, before_event, after_index, after_event = surrounding
            kind = "sleep" if is_sleep(event) else "action"
            if kind == "action":
                action_number += 1
            result.append(
                (
                    kind,
                    (
                        action_number,
                        before_index,
                        before_event,
                        event_index,
                        event,
                        after_index,
                        after_event,
                    ),
                )
            )
    return result


def action_context_warnings(
    events: list[dict[str, Any]],
    before_index: int,
    action_index: int,
    action: dict[str, Any],
    after_index: int,
    before_gap: float,
    after_gap: float,
) -> list[str]:
    warnings: list[str] = []
    if before_gap > SYNC_WARNING_GAP_SECONDS:
        warnings.append(f"wide before gap {before_gap:.2f}s")
    if after_gap > SYNC_WARNING_GAP_SECONDS:
        warnings.append(f"wide after gap {after_gap:.2f}s")
    if any(is_action(events[pos]) for pos in range(before_index + 1, action_index)):
        warnings.append("no screenshot between previous action and this action")
    if any(is_action(events[pos]) for pos in range(action_index + 1, after_index)):
        warnings.append("after screenshot also follows a later action")
    if timestamp(action) < timestamp(events[before_index]):
        warnings.append("action ends before selected before screenshot")
    return warnings


def warning_chips(warnings: list[str]) -> str:
    if not warnings:
        return ""
    chips = "".join(
        f"<span>{html.escape(warning)}</span>"
        for warning in warnings
    )
    return f'<div class="sync-warnings">{chips}</div>'


def render_action_card(
    index: int,
    events: list[dict[str, Any]],
    before_index: int,
    before: dict[str, Any],
    action_index: int,
    action: dict[str, Any],
    after_index: int,
    after: dict[str, Any],
) -> str:
    before_gap = start_timestamp(action) - timestamp(before)
    after_gap = timestamp(after) - timestamp(action)
    args = payload(action)
    summary = action_summary(action)
    duration = timestamp(action) - start_timestamp(action)
    warnings = action_context_warnings(
        events,
        before_index,
        action_index,
        action,
        after_index,
        before_gap,
        after_gap,
    )
    action_strip = f"""
        <div class="action-strip">
          <div class="action-main">
            <div class="eyebrow">Action {index} · processed #{action_index}</div>
            <h2>{html.escape(summary)}</h2>
            {warning_chips(warnings)}
          </div>
          {action_position_html(action)}
          <div class="time-triplet">
            <span><strong>Before</strong> #{before_index} {fmt_ts(timestamp(before))}</span>
            <span><strong>Action</strong> {html.escape(action_time_range(action))}</span>
            <span><strong>After</strong> #{after_index} {fmt_ts(timestamp(after))}</span>
          </div>
        </div>
    """
    return f"""
      <article class="action-card" id="action-{index}">
        {action_strip}
        <div class="frame-grid">
          {screenshot_panel(before, "Before", before_index, action, "before")}
          {screenshot_panel(after, "After", after_index, action, "after")}
        </div>
        <details>
          <summary>Action JSON</summary>
          <pre>{json_block({"type": event_type(action), "timestamp": action.get("timestamp"), "start_timestamp": action.get("start_timestamp"), "args": args})}</pre>
        </details>
      </article>
    """


def render_sleep_card(
    events: list[dict[str, Any]],
    before_index: int,
    before: dict[str, Any],
    sleep_index: int,
    sleep_event: dict[str, Any],
    after_index: int,
    after: dict[str, Any],
) -> str:
    args = payload(sleep_event)
    duration = args.get("duration")
    duration_label = f"{duration}s" if duration not in (None, "") else "n/a"
    sleep_ts = timestamp(sleep_event)
    before_gap = sleep_ts - timestamp(before)
    after_gap = timestamp(after) - sleep_ts
    previous_action = previous_action_before(events, sleep_index)
    next_action = next_action_after(events, sleep_index)
    previous_label = (
        f"prev processed #{previous_action[0]} end {fmt_ts(timestamp(previous_action[1]))}"
        if previous_action
        else "prev action n/a"
    )
    next_label = (
        f"next processed #{next_action[0]} start {fmt_ts(start_timestamp(next_action[1]))}"
        if next_action
        else "next action n/a"
    )
    actual_gap = (
        start_timestamp(next_action[1]) - sleep_ts
        if next_action
        else None
    )
    return f"""
      <article class="action-card sleep-card" id="sleep-{sleep_index}">
        <header>
          <div>
            <div class="eyebrow">Sleep · processed #{sleep_index}</div>
            <h2>sleep {html.escape(duration_label)}</h2>
            <div class="action-time">
              pause marker at {fmt_ts(sleep_ts)}
              · represented duration {html.escape(duration_label)}
              · next action gap {fmt_delta(actual_gap)}
            </div>
            <div class="sleep-note">
              Processor-inserted idle period between actions; it is not a user input event.
            </div>
          </div>
          <div class="timing">
            <span>before #{before_index} {fmt_ts(timestamp(before))}</span>
            <span>sleep #{sleep_index} {fmt_ts(sleep_ts)}</span>
            <span>after #{after_index} {fmt_ts(timestamp(after))}</span>
            <span>{html.escape(previous_label)}</span>
            <span>{html.escape(next_label)}</span>
            <span>before gap {before_gap:.2f}s</span>
            <span>after gap {after_gap:.2f}s</span>
          </div>
        </header>
        <div class="frame-grid">
          {screenshot_panel(before, "Before Sleep", before_index)}
          {screenshot_panel(after, "After Sleep", after_index)}
        </div>
        <details>
          <summary>Sleep JSON</summary>
          <pre>{json_block({"type": event_type(sleep_event), "timestamp": sleep_event.get("timestamp"), "start_timestamp": sleep_event.get("start_timestamp"), "args": args})}</pre>
        </details>
      </article>
    """


def render_review_card(kind: str, item: IndexedTriple, events: list[dict[str, Any]]) -> str:
    index, before_index, before, event_index, event, after_index, after = item
    if kind == "sleep":
        return render_sleep_card(events, before_index, before, event_index, event, after_index, after)
    return render_action_card(index, events, before_index, before, event_index, event, after_index, after)


def screenshot_cadence(events: list[dict[str, Any]]) -> dict[str, float | int | None]:
    screenshots = [event for event in events if is_screenshot(event)]
    gaps = [
        timestamp(current) - timestamp(previous)
        for previous, current in zip(screenshots, screenshots[1:])
    ]
    if not gaps:
        return {
            "count": len(screenshots),
            "avg_gap": None,
            "min_gap": None,
            "max_gap": None,
            "effective_fps": None,
        }
    total = sum(gaps)
    return {
        "count": len(screenshots),
        "avg_gap": total / len(gaps),
        "min_gap": min(gaps),
        "max_gap": max(gaps),
        "effective_fps": len(gaps) / total if total > 0 else None,
    }


def cadence_line(label: str, cadence: dict[str, float | int | None]) -> str:
    effective_fps = cadence["effective_fps"]
    fps_label = (
        f"{effective_fps:.2f} fps"
        if isinstance(effective_fps, (int, float))
        else "n/a"
    )
    return (
        f"{label}: {cadence['count']} screenshots, "
        f"avg gap {fmt_delta(cadence['avg_gap'])}, "
        f"min {fmt_delta(cadence['min_gap'])}, "
        f"max {fmt_delta(cadence['max_gap'])}, "
        f"effective {fps_label}"
    )


def raw_screenshot_times(raw_events: list[dict[str, Any]] | None) -> list[float]:
    if raw_events is None:
        return []
    return [
        timestamp(event)
        for event in raw_events
        if is_screenshot(event)
    ]


def numeric_values(events: list[dict[str, Any]], key: str) -> list[float]:
    return [
        float(value)
        for event in events
        if is_screenshot(event)
        for value in [payload(event).get(key)]
        if isinstance(value, (int, float))
    ]


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))
    return ordered[index]


def timing_summary(label: str, values: list[float]) -> str | None:
    if not values:
        return None
    p95 = percentile(values, 0.95)
    return (
        f"{label} avg {sum(values) / len(values):.1f}ms, "
        f"p95 {p95:.1f}ms, "
        f"max {max(values):.1f}ms"
    )


def capture_producer_summary(events: list[dict[str, Any]]) -> str | None:
    shots = [event for event in events if is_screenshot(event)]
    frame_ids = numeric_values(events, "frame_id")
    if not shots or not frame_ids:
        return None
    first_id = int(min(frame_ids))
    last_id = int(max(frame_ids))
    produced = last_id - first_id + 1
    start_values = numeric_values(events, "capture_started_timestamp")
    start_ts = min(start_values) if start_values else timestamp(shots[0])
    elapsed = max(0.0, timestamp(shots[-1]) - start_ts)
    fps = (produced - 1) / elapsed if elapsed > 0 and produced > 1 else None
    fps_label = f"{fps:.2f} fps" if isinstance(fps, (int, float)) else "n/a"
    return (
        f"capture producer {produced} frames, "
        f"{len(shots)} encoded, "
        f"{fps_label}"
    )


def capture_timing_line(events: list[dict[str, Any]] | None) -> str | None:
    if events is None:
        return None
    capture = numeric_values(events, "capture_duration_ms")
    queue_wait = numeric_values(events, "queue_wait_ms")
    encode = numeric_values(events, "encode_duration_ms")
    if not capture and not queue_wait and not encode:
        return None
    limited = sum(
        1
        for event in events
        if is_screenshot(event) and payload(event).get("capture_limited") is True
    )
    dropped = numeric_values(events, "dropped_raw_frames")
    queue_depth = numeric_values(events, "raw_queue_depth")
    parts = [
        summary
        for summary in [
            capture_producer_summary(events),
            timing_summary("capture", capture),
            timing_summary("queue wait", queue_wait),
            timing_summary("encode", encode),
        ]
        if summary
    ]
    if capture:
        parts.append(f"capture-limited {limited}/{len(capture)}")
    if dropped:
        parts.append(f"dropped raw frames {int(max(dropped))}")
    if queue_depth:
        parts.append(f"max raw queue depth {int(max(queue_depth))}")
    return "Raw pipeline: " + " · ".join(parts)


def render_sync_diagnostics(
    events: list[dict[str, Any]],
    action_triples: list[IndexedTriple],
    raw_events: list[dict[str, Any]] | None = None,
) -> str:
    processed_cadence = screenshot_cadence(events)
    raw_cadence = screenshot_cadence(raw_events) if raw_events is not None else None
    raw_times = raw_screenshot_times(raw_events)
    warnings: list[str] = []
    processed_avg_gap = processed_cadence["avg_gap"]
    raw_effective_fps = raw_cadence["effective_fps"] if raw_cadence else None
    raw_avg_gap = raw_cadence["avg_gap"] if raw_cadence else None
    if isinstance(raw_effective_fps, (int, float)) and raw_effective_fps < 1.5:
        warnings.append(f"low raw screenshot cadence: {raw_effective_fps:.2f} fps")
    elif raw_cadence is None:
        warnings.append("raw JSONL was not provided, so recorder cadence cannot be measured here")
    if isinstance(raw_avg_gap, (int, float)) and raw_avg_gap > SYNC_WARNING_GAP_SECONDS:
        warnings.append(
            f"average raw screenshot gap is {raw_avg_gap:.2f}s, so fast actions can share one visual context"
        )
    if isinstance(processed_avg_gap, (int, float)) and processed_avg_gap > SYNC_WARNING_GAP_SECONDS:
        warnings.append(
            f"average processed screenshot gap is {processed_avg_gap:.2f}s"
        )

    for left, right in zip(action_triples, action_triples[1:]):
        left_number, _, _, left_action_index, left_action, left_after_index, _ = left
        right_number, right_before_index, _, right_action_index, right_action, _, _ = right
        if left_after_index > right_action_index or right_before_index < left_action_index:
            raw_between = [
                shot_ts
                for shot_ts in raw_times
                if timestamp(left_action) < shot_ts < start_timestamp(right_action)
            ]
            if raw_events is not None and not raw_between:
                warnings.append(
                    "raw trace has no screenshot between "
                    f"Action {left_number} end {fmt_ts(timestamp(left_action))} and "
                    f"Action {right_number} start {fmt_ts(start_timestamp(right_action))}"
                )
            warnings.append(
                "processed trace has no screenshot between "
                f"Action {left_number} ({fmt_ts(timestamp(left_action))}) and "
                f"Action {right_number} ({fmt_ts(start_timestamp(right_action))})"
            )

    warning_items = "\n".join(
        f"<li>{html.escape(warning)}</li>"
        for warning in warnings
    )
    if not warning_items:
        warning_items = "<li>No timing warnings detected for processed triples.</li>"

    raw_line = (
        f"<p>{html.escape(cadence_line('Raw', raw_cadence))}</p>"
        if raw_cadence is not None
        else "<p>Raw: not provided</p>"
    )
    capture_line = capture_timing_line(raw_events)
    capture_paragraph = (
        f"<p>{html.escape(capture_line)}</p>"
        if capture_line is not None
        else ""
    )
    return f"""
      <section class="sync-diagnostics">
        <div>
          <h2>Sync Diagnostics</h2>
          <p>{html.escape(cadence_line("Processed", processed_cadence))}</p>
          {raw_line}
          {capture_paragraph}
        </div>
        <ul>{warning_items}</ul>
      </section>
    """


def render_event_row(index: int, event: dict[str, Any]) -> str:
    typ = event_type(event)
    label = event_label(event)
    raw = json_block(event)
    image = ""
    if typ == "screenshot":
        selection = choose_screenshot_view(event)
        image_url = selection.get("image")
        if image_url:
            summary = (
                f"View screenshot ({display_label(selection.get('display_id'))} "
                f"from {selection.get('reason')})"
            )
            image = (
                "<details class=\"event-image\">"
                f"<summary>{html.escape(summary)}</summary>"
                f"<img src=\"{image_url}\" alt=\"event {index} screenshot\">"
                "</details>"
            )
    return f"""
      <article class="event-row type-{html.escape(typ)}" data-type="{html.escape(typ)}">
        <div class="event-meta">
          <span class="event-index">#{index}</span>
          <span class="event-time">{fmt_ts(timestamp(event))}</span>
          <span class="event-type">{html.escape(typ)}</span>
        </div>
        <div class="event-label">{html.escape(label)}</div>
        {image}
        <details>
          <summary>Raw JSON</summary>
          <pre>{raw}</pre>
        </details>
      </article>
    """


def css() -> str:
    return """
    :root {
      color-scheme: light;
      --bg: #f6f7f8;
      --panel: #ffffff;
      --text: #15171a;
      --muted: #616975;
      --line: #d8dde3;
      --accent: #0b6bcb;
      --bad: #b42318;
      --good: #027a48;
      --shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 10;
      background: rgba(246, 247, 248, 0.94);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(12px);
    }
    .topbar-inner {
      max-width: 1440px;
      margin: 0 auto;
      padding: 16px 22px;
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
    }
    .topbar-tools {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 20px; }
    h2 { font-size: 17px; }
    .source-path {
      margin-top: 6px;
      max-width: 900px;
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .stats {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .stat {
      min-width: 82px;
      padding: 7px 9px;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 7px;
      text-align: right;
      font-size: 12px;
    }
    .stat strong {
      display: block;
      font-size: 16px;
      color: var(--text);
    }
    main {
      max-width: 1440px;
      margin: 0 auto;
      padding: 18px 22px 48px;
    }
    .section-title {
      margin: 20px 0 10px;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .section-title h2 { font-size: 18px; }
    .section-title span { color: var(--muted); font-size: 12px; }
    .review-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .sleep-toggle {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 10px;
      border: 1px solid #d0a62f;
      border-radius: 7px;
      background: #fff8e6;
      color: #6f4b00;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      user-select: none;
    }
    .sleep-toggle input {
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: #0b6bcb;
    }
    .sleep-toggle:has(input:checked) {
      border-color: #0b6bcb;
      background: #eaf4ff;
      color: #084f96;
    }
    .sleep-toggle-status {
      padding: 4px 7px;
      border-radius: 999px;
      background: #eef2f6;
      color: #2f3742;
      font-size: 12px;
      white-space: nowrap;
    }
    body.show-sleep .sleep-toggle-status {
      background: #eaf4ff;
      color: #084f96;
    }
    .action-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      margin-bottom: 18px;
      overflow: hidden;
    }
    .sleep-card {
      background: #fbfcfd;
      border-color: #cfd6df;
      display: none;
    }
    body.show-sleep .sleep-card {
      display: block;
    }
    .sleep-card h2 {
      color: #334155;
    }
    .action-card > header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: flex-start;
    }
    .eyebrow {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
      margin-bottom: 3px;
    }
    .action-time {
      margin-top: 5px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }
    .sleep-note {
      margin-top: 7px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .sync-warnings {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .sync-warnings span {
      padding: 4px 7px;
      border-radius: 6px;
      background: #fff4d6;
      color: #7a4b00;
      border: 1px solid #f3d38b;
      font-size: 12px;
      line-height: 1.2;
    }
    .timing {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      max-width: 520px;
    }
    .timing span {
      padding: 4px 7px;
      border-radius: 6px;
      background: #eef2f6;
      color: #2f3742;
      font-size: 12px;
      white-space: nowrap;
    }
    .frame-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      align-items: start;
      gap: 0;
      border-bottom: 1px solid var(--line);
    }
    .shot-panel {
      align-self: start;
      padding: 0;
      min-width: 0;
    }
    .shot-panel + .shot-panel {
      border-left: 1px solid var(--line);
    }
    .shot-title {
      display: flex;
      justify-content: space-between;
      color: var(--muted);
      font-size: 12px;
      margin: 0;
      padding: 10px 12px;
    }
    .shot-note {
      margin-top: 7px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .image-wrap {
      position: relative;
      background: #101418;
      border: 1px solid #202731;
      border-radius: 6px;
      overflow: hidden;
    }
    .image-wrap img,
    .event-image img {
      display: block;
      width: 100%;
      height: auto;
    }
    .marker {
      position: absolute;
      width: 30px;
      height: 30px;
      margin-left: -15px;
      margin-top: -15px;
      border-radius: 999px;
      border: 4px solid #ffcf33;
      background: rgba(255, 255, 255, 0.10);
      box-shadow: 0 0 0 4px rgba(0,0,0,0.55), 0 0 24px rgba(255, 207, 51, 0.95);
      pointer-events: none;
    }
    .marker::before {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      width: 8px;
      height: 8px;
      margin-left: -4px;
      margin-top: -4px;
      border-radius: 999px;
      background: currentColor;
      color: #ffcf33;
      box-shadow: 0 0 0 2px rgba(0,0,0,0.65);
    }
    .marker::after {
      content: attr(data-label);
      position: absolute;
      left: 24px;
      top: -28px;
      padding: 3px 6px;
      border-radius: 5px;
      background: rgba(17, 24, 39, 0.92);
      color: #ffffff;
      font-size: 11px;
      line-height: 1;
      white-space: nowrap;
      box-shadow: 0 1px 6px rgba(0,0,0,0.35);
    }
    .drag-start { border-color: #22c55e; box-shadow: 0 0 0 4px rgba(0,0,0,0.55), 0 0 24px rgba(34,197,94,0.9); }
    .drag-start::before { color: #22c55e; }
    .drag-end { border-color: #ef4444; box-shadow: 0 0 0 4px rgba(0,0,0,0.55), 0 0 24px rgba(239,68,68,0.9); }
    .drag-end::before { color: #ef4444; }
    .action-strip {
      margin: 0;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
      display: grid;
      gap: 8px;
      text-align: center;
    }
    .position-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      justify-self: center;
      width: min(100%, 720px);
    }
    .position-row span {
      min-width: 0;
      padding: 6px 8px;
      border: 1px solid #bbf7d0;
      border-radius: 6px;
      background: #f0fdf4;
      color: #14532d;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      font-weight: 800;
      line-height: 1.25;
      overflow-wrap: anywhere;
      text-align: center;
    }
    .position-row strong {
      display: block;
      margin-bottom: 2px;
      color: #15803d;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .time-triplet {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 4px;
    }
    .time-triplet span {
      min-width: 0;
      padding: 3px 7px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: #f8fafc;
      color: #334155;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      font-weight: 800;
      line-height: 1.2;
      white-space: nowrap;
    }
    .time-triplet strong {
      color: var(--muted);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
    }
    details {
      padding: 10px 14px;
      border-top: 1px solid var(--line);
    }
    details:first-child { border-top: 0; }
    summary {
      cursor: pointer;
      color: var(--accent);
      font-size: 13px;
      font-weight: 600;
    }
    pre {
      margin: 10px 0 0;
      padding: 12px;
      background: #111827;
      color: #e5e7eb;
      overflow: auto;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
    }
    .events {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .event-row {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .event-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 9px 12px 0;
      color: var(--muted);
      font-size: 12px;
    }
    .event-type {
      color: var(--text);
      background: #eef2f6;
      border-radius: 5px;
      padding: 2px 6px;
    }
    .event-label {
      padding: 7px 12px 10px;
      font-size: 14px;
    }
    .event-image {
      border-top: 1px solid var(--line);
    }
    .missing-image {
      min-height: 240px;
      display: grid;
      place-items: center;
      color: #cbd5e1;
    }
    .controls {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      color: var(--muted);
      font-size: 13px;
    }
    .sync-diagnostics {
      display: grid;
      grid-template-columns: minmax(240px, 0.8fr) minmax(280px, 1.2fr);
      gap: 18px;
      align-items: start;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      margin: 0 0 18px;
      padding: 14px 16px;
    }
    .sync-diagnostics h2 {
      margin: 0 0 7px;
      font-size: 18px;
    }
    .sync-diagnostics p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .sync-diagnostics ul {
      margin: 0;
      padding-left: 18px;
      color: #7a4b00;
      font-size: 13px;
      line-height: 1.45;
    }
    button {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 6px 9px;
      background: var(--panel);
      color: var(--text);
      cursor: pointer;
    }
    @media (max-width: 900px) {
      .topbar-inner, .action-card > header { flex-direction: column; }
      .stats, .topbar-tools, .timing { justify-content: flex-start; }
      .frame-grid { grid-template-columns: 1fr; }
      .position-row { grid-template-columns: 1fr; }
      .time-triplet { grid-template-columns: 1fr; }
      .sync-diagnostics { grid-template-columns: 1fr; }
      .shot-panel + .shot-panel { border-left: 0; border-top: 1px solid var(--line); }
    }
    """


def javascript() -> str:
    return """
    function toggleDetails(open) {
      document.querySelectorAll('details').forEach((node) => { node.open = open; });
    }
    function setEventFilter(value) {
      document.querySelectorAll('.event-row').forEach((node) => {
        node.style.display = value === 'all' || node.dataset.type === value ? '' : 'none';
      });
    }
    function toggleSleep(checked) {
      const input = document.getElementById('sleepToggle');
      const visible = typeof checked === 'boolean' ? checked : Boolean(input && input.checked);
      document.body.classList.toggle('show-sleep', visible);
      const status = document.getElementById('sleepToggleStatus');
      if (status) {
        status.textContent = visible ? 'sleep visible' : 'sleep hidden';
      }
    }
    """


def generate(preprocessed: Path, output: Path, raw_jsonl: Path | None = None) -> None:
    events = read_jsonl(preprocessed)
    raw_events = read_jsonl(raw_jsonl) if raw_jsonl is not None else None
    action_triples = indexed_triples(events)
    review_items = indexed_review_items(events)
    counts: dict[str, int] = {}
    for event in events:
        counts[event_type(event)] = counts.get(event_type(event), 0) + 1
    action_count = sum(
        1
        for event in events
        if event_type(event) not in {"", "screenshot", "a11y+screenshot", "sleep"}
    )

    review_cards = "\n".join(
        render_review_card(kind, item, events)
        for kind, item in review_items
    )
    event_rows = "\n".join(render_event_row(index, event) for index, event in enumerate(events))
    filters = "\n".join(
        f'<button type="button" onclick="setEventFilter({json.dumps(kind)})">{html.escape(kind)} ({count})</button>'
        for kind, count in sorted(counts.items())
    )

    document = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kortix Recording Trace</title>
  <style>{css()}</style>
</head>
<body>
  <div class="topbar">
    <div class="topbar-inner">
      <div>
        <h1>Kortix Recording Trace</h1>
        <div class="source-path">{html.escape(str(preprocessed))}</div>
      </div>
      <div class="stats">
        <div class="stat"><strong>{len(events)}</strong>events</div>
        <div class="stat"><strong>{action_count}</strong>actions</div>
        <div class="stat"><strong>{counts.get("sleep", 0)}</strong>sleeps</div>
        <div class="stat"><strong>{counts.get("screenshot", 0)}</strong>screenshots</div>
        <div class="stat"><strong>{len(action_triples)}</strong>triples</div>
      </div>
      <div class="topbar-tools">
        <label class="sleep-toggle" for="sleepToggle">
          <input id="sleepToggle" type="checkbox" onchange="toggleSleep(this.checked)">
          <span>show sleep ({counts.get("sleep", 0)})</span>
        </label>
        <span id="sleepToggleStatus" class="sleep-toggle-status">sleep hidden</span>
      </div>
    </div>
  </div>
  <main>
    {render_sync_diagnostics(events, action_triples, raw_events)}

    <section class="section-title">
      <h2>Action Review</h2>
      <div class="review-controls">
        <span>Before and after screenshots around each processed action</span>
      </div>
    </section>
    {review_cards or '<p>No screenshot/action/screenshot triples found.</p>'}

    <section class="section-title">
      <h2>All Events</h2>
      <div class="controls">
        <button type="button" onclick="setEventFilter('all')">all ({len(events)})</button>
        {filters}
        <button type="button" onclick="toggleDetails(true)">expand details</button>
        <button type="button" onclick="toggleDetails(false)">collapse details</button>
      </div>
    </section>
    <section class="events">
      {event_rows}
    </section>
  </main>
  <script>{javascript()}</script>
</body>
</html>
"""
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(document, encoding="utf-8")
    print(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preprocessed", help="Processed JSONL trace or a directory containing one")
    parser.add_argument("--output", help="Output HTML path. Defaults beside the input trace")
    parser.add_argument("--raw-jsonl", help="Optional raw JSONL trace for recorder cadence diagnostics")
    args = parser.parse_args()

    input_path = Path(args.preprocessed)
    if input_path.is_dir():
        candidates = sorted(input_path.glob("*_preprocessed.jsonl"), key=lambda path: path.stat().st_mtime)
        if not candidates:
            raise SystemExit(f"no *_preprocessed.jsonl found in {input_path}")
        input_path = candidates[-1]
    output = (
        Path(args.output)
        if args.output
        else input_path.with_name(f"{input_path.stem}_visualization.html")
    )
    raw_jsonl = Path(args.raw_jsonl) if args.raw_jsonl else None
    generate(input_path, output, raw_jsonl)


if __name__ == "__main__":
    main()
