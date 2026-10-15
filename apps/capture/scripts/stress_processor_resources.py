#!/usr/bin/env python3
"""Stress the Rust raw processor and enforce bounded resource usage."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

try:
    import psutil
except ImportError as exc:  # pragma: no cover - exercised by developer setup
    raise SystemExit("psutil is required. Install backend dev requirements first.") from exc


BACKEND_ROOT = Path(__file__).resolve().parent.parent


@dataclass
class ResourceStats:
    elapsed_seconds: float
    cpu_time_seconds: float
    max_rss_bytes: int
    rss_growth_bytes: int
    samples: int


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", type=int, default=80_000)
    parser.add_argument("--max-rss-mib", type=float, default=180.0)
    parser.add_argument("--max-rss-growth-mib", type=float, default=24.0)
    parser.add_argument("--min-events-per-cpu-second", type=float, default=5_000.0)
    parser.add_argument("--sample-interval", type=float, default=0.05)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--iterations", type=int, default=1)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--keep", action="store_true")
    parser.add_argument(
        "--summary-json",
        help="Optional path for a machine-readable summary of thresholds, iterations, aggregate metrics, and failures.",
    )
    args = parser.parse_args()

    if args.events < 1_000:
        raise SystemExit("--events must be at least 1000 for a meaningful stress sample")
    if args.iterations < 1:
        raise SystemExit("--iterations must be at least 1")

    if not args.skip_build:
        cargo = shutil.which("cargo") or str(Path.home() / ".cargo" / "bin" / exe_name("cargo"))
        run([cargo, "build", "--release", "--bin", "kortix-process-raw"], timeout=args.timeout)

    target_dir = Path(os.environ.get("CARGO_TARGET_DIR") or BACKEND_ROOT / "target")
    process_raw = target_dir / "release" / exe_name("kortix-process-raw")
    if not process_raw.exists():
        raise SystemExit(f"missing processor binary: {process_raw}")

    with tempfile.TemporaryDirectory(prefix="kortix-processor-stress-") as tmp:
        tmp_dir = Path(tmp)
        raw_path = tmp_dir / "stress_raw.jsonl"
        raw_events = generate_raw_recording(raw_path, args.events)
        failures: list[str] = []
        iteration_results: list[dict[str, float | int]] = []
        last_output_path: Path | None = None

        for iteration in range(1, args.iterations + 1):
            output_path = tmp_dir / f"stress_preprocessed_{iteration}.jsonl"
            last_output_path = output_path
            stats = run_monitored(
                [str(process_raw), "--file", str(raw_path), "--output", str(output_path)],
                sample_interval=args.sample_interval,
                timeout=args.timeout,
            )
            output_analysis = analyze_processed_output(output_path)
            output_events = output_analysis["processed_events"]
            if output_events == 0:
                failures.append(f"iteration {iteration}: processor produced no output events")
                continue

            events_per_cpu_second = raw_events / max(stats.cpu_time_seconds, 0.001)
            max_rss_mib = stats.max_rss_bytes / (1024 * 1024)
            rss_growth_mib = stats.rss_growth_bytes / (1024 * 1024)

            iteration_results.append(
                {
                    "iteration": iteration,
                    "processed_events": output_events,
                    "actions": output_analysis["actions"],
                    "screenshots": output_analysis["screenshots"],
                    "elapsed_seconds": stats.elapsed_seconds,
                    "cpu_time_seconds": stats.cpu_time_seconds,
                    "events_per_cpu_second": events_per_cpu_second,
                    "max_rss_mib": max_rss_mib,
                    "rss_growth_mib": rss_growth_mib,
                    "samples": stats.samples,
                }
            )

            print(f"iteration={iteration}")
            print(f"raw_events={raw_events}")
            print(f"processed_events={output_events}")
            print(f"actions={output_analysis['actions']}")
            print(f"screenshots={output_analysis['screenshots']}")
            print(f"action_types={','.join(output_analysis['action_types'])}")
            print(f"action_screenshot_pairs={output_analysis['action_screenshot_pairs']}")
            print(f"screenshot_action_screenshot_triples={output_analysis['screenshot_action_screenshot_triples']}")
            print(f"elapsed_seconds={stats.elapsed_seconds:.3f}")
            print(f"cpu_time_seconds={stats.cpu_time_seconds:.3f}")
            print(f"events_per_cpu_second={events_per_cpu_second:.1f}")
            print(f"max_rss_mib={max_rss_mib:.2f}")
            print(f"rss_growth_mib={rss_growth_mib:.2f}")
            print(f"samples={stats.samples}")

            if max_rss_mib > args.max_rss_mib:
                failures.append(
                    f"iteration {iteration}: max RSS {max_rss_mib:.2f} MiB exceeded {args.max_rss_mib:.2f} MiB"
                )
            if rss_growth_mib > args.max_rss_growth_mib:
                failures.append(
                    f"iteration {iteration}: RSS growth {rss_growth_mib:.2f} MiB exceeded {args.max_rss_growth_mib:.2f} MiB"
                )
            if events_per_cpu_second < args.min_events_per_cpu_second:
                failures.append(
                    f"iteration {iteration}: CPU throughput "
                    f"{events_per_cpu_second:.1f} events/cpu-second below "
                    f"{args.min_events_per_cpu_second:.1f}"
                )
            expected_action_types = {"click", "typewrite", "scroll", "drag"}
            missing_action_types = expected_action_types - set(output_analysis["action_types"])
            if missing_action_types:
                failures.append(
                    f"iteration {iteration}: processed output is missing expected action types: "
                    f"{', '.join(sorted(missing_action_types))}"
                )
            if output_analysis["actions"] == 0 or output_analysis["screenshots"] == 0:
                failures.append(f"iteration {iteration}: processed output is not training-data shaped")
            elif output_analysis["action_screenshot_pairs"] < int(output_analysis["actions"] * 0.75):
                failures.append(
                    f"iteration {iteration}: processed output has too few action->screenshot pairs: "
                    f"{output_analysis['action_screenshot_pairs']} for {output_analysis['actions']} actions"
                )

        aggregate: dict[str, float | int] = {}
        if iteration_results:
            aggregate = {
                "iterations": len(iteration_results),
                "max_iteration_rss_mib": max(result["max_rss_mib"] for result in iteration_results),
                "max_iteration_rss_growth_mib": max(result["rss_growth_mib"] for result in iteration_results),
                "min_iteration_events_per_cpu_second": min(
                    result["events_per_cpu_second"] for result in iteration_results
                ),
                "total_elapsed_seconds": sum(result["elapsed_seconds"] for result in iteration_results),
                "total_cpu_time_seconds": sum(result["cpu_time_seconds"] for result in iteration_results),
            }
            print(f"iterations={len(iteration_results)}")
            print(f"max_iteration_rss_mib={aggregate['max_iteration_rss_mib']:.2f}")
            print(f"max_iteration_rss_growth_mib={aggregate['max_iteration_rss_growth_mib']:.2f}")
            print(f"min_iteration_events_per_cpu_second={aggregate['min_iteration_events_per_cpu_second']:.1f}")
            print(f"total_elapsed_seconds={aggregate['total_elapsed_seconds']:.3f}")
            print(f"total_cpu_time_seconds={aggregate['total_cpu_time_seconds']:.3f}")

        if args.keep:
            kept = BACKEND_ROOT / "target" / "processor-stress"
            kept.mkdir(parents=True, exist_ok=True)
            shutil.copy2(raw_path, kept / raw_path.name)
            if last_output_path:
                shutil.copy2(last_output_path, kept / "stress_preprocessed.jsonl")
            print(f"kept={kept}")

        if args.summary_json:
            write_summary_json(
                Path(args.summary_json),
                {
                    "status": "fail" if failures else "pass",
                    "raw_events": raw_events,
                    "requested_iterations": args.iterations,
                    "thresholds": {
                        "max_rss_mib": args.max_rss_mib,
                        "max_rss_growth_mib": args.max_rss_growth_mib,
                        "min_events_per_cpu_second": args.min_events_per_cpu_second,
                    },
                    "iterations": iteration_results,
                    "aggregate": aggregate,
                    "failures": failures,
                },
            )
            print(f"summary_json={args.summary_json}")

        if failures:
            for failure in failures:
                print(failure, file=sys.stderr)
            return 1

    return 0

def write_summary_json(path: Path, summary: dict) -> None:
    path = path if path.is_absolute() else BACKEND_ROOT / path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def generate_raw_recording(path: Path, target_events: int) -> int:
    count = 0
    ts = 0.10

    def emit(handle, event: dict) -> None:
        nonlocal count
        if count >= target_events:
            return
        handle.write(json.dumps(event, separators=(",", ":")) + "\n")
        count += 1

    with path.open("w", encoding="utf-8") as handle:
        emit(handle, screenshot(ts, "initial"))
        cycle = 0
        while count < target_events:
            base = 1.0 + cycle * 1.4
            pattern = cycle % 4
            emit(handle, screenshot(base, f"frame-{cycle}"))

            if pattern == 0:
                for offset, key in [(0.05, "h"), (0.13, "i"), (0.21, "space")]:
                    emit(handle, key_down(base + offset, key))
                    emit(handle, key_up(base + offset + 0.03, key))
                emit(handle, checkpoint(base + 0.70))
            elif pattern == 1:
                emit(handle, mouse_down(base + 0.05, 0.20, 0.20, "left"))
                emit(handle, mouse_up(base + 0.10, 0.20, 0.20, "left"))
                emit(handle, mouse_down(base + 0.25, 0.20, 0.20, "left"))
                emit(handle, mouse_up(base + 0.30, 0.20, 0.20, "left"))
                emit(handle, checkpoint(base + 0.90))
            elif pattern == 2:
                emit(handle, scroll(base + 0.05, -1))
                emit(handle, scroll(base + 0.12, -2))
                emit(handle, scroll(base + 0.30, 3))
                emit(handle, scroll(base + 0.40, 1))
                emit(handle, checkpoint(base + 0.90))
            else:
                emit(handle, key_down(base + 0.05, "ctrl"))
                emit(handle, mouse_down(base + 0.10, 0.30, 0.30, "left"))
                emit(
                    handle,
                    {
                        "type": "mouse_move",
                        "timestamp": base + 0.25,
                        "data": {"x": 0.45, "y": 0.45, "is_dragging": True},
                    },
                )
                emit(handle, mouse_up(base + 0.45, 0.45, 0.45, "left"))
                emit(handle, key_up(base + 0.55, "ctrl"))
                emit(handle, checkpoint(base + 0.90))

            ts = base + 1.0
            cycle += 1

    return count


def screenshot(ts: float, label: str) -> dict:
    return {
        "type": "screenshot",
        "timestamp": ts,
        "data": {"image": label, "width": 100, "height": 100, "encoding": "jpg"},
    }


def key_down(ts: float, key: str) -> dict:
    return {"type": "key_down", "timestamp": ts, "data": {"key": key}}


def key_up(ts: float, key: str) -> dict:
    return {
        "type": "key_up",
        "timestamp": ts,
        "data": {"key": key, "hold_duration": 0.03},
    }


def mouse_down(ts: float, x: float, y: float, button: str) -> dict:
    return {"type": "mouse_down", "timestamp": ts, "data": {"x": x, "y": y, "button": button}}


def mouse_up(ts: float, x: float, y: float, button: str) -> dict:
    return {"type": "mouse_up", "timestamp": ts, "data": {"x": x, "y": y, "button": button}}


def scroll(ts: float, clicks: int) -> dict:
    return {"type": "mouse_scroll", "timestamp": ts, "data": {"x": 0.5, "y": 0.5, "clicks": clicks}}


def checkpoint(ts: float) -> dict:
    return {"type": "checkpoint", "timestamp": ts, "data": {}}


def run(command: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=BACKEND_ROOT,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        print(result.stdout, file=sys.stdout)
        print(result.stderr, file=sys.stderr)
        raise SystemExit(result.returncode)
    return result


def run_monitored(command: list[str], sample_interval: float, timeout: float) -> ResourceStats:
    started = time.monotonic()
    process = subprocess.Popen(
        command,
        cwd=BACKEND_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    ps_process = psutil.Process(process.pid)
    rss_samples: list[int] = []
    cpu_time_seconds = 0.0

    while True:
        elapsed = time.monotonic() - started
        if elapsed > timeout:
            process.kill()
            stdout, stderr = process.communicate()
            print(stdout, file=sys.stdout)
            print(stderr, file=sys.stderr)
            raise SystemExit(f"processor timed out after {timeout:.1f}s")

        try:
            rss_samples.append(ps_process.memory_info().rss)
            cpu_times = ps_process.cpu_times()
            cpu_time_seconds = cpu_times.user + cpu_times.system
        except psutil.NoSuchProcess:
            pass

        if process.poll() is not None:
            break
        time.sleep(sample_interval)

    stdout, stderr = process.communicate()
    if process.returncode != 0:
        print(stdout, file=sys.stdout)
        print(stderr, file=sys.stderr)
        raise SystemExit(process.returncode)

    elapsed_seconds = time.monotonic() - started
    max_rss = max(rss_samples) if rss_samples else 0
    rss_growth = estimate_rss_growth(rss_samples)
    return ResourceStats(
        elapsed_seconds=elapsed_seconds,
        cpu_time_seconds=cpu_time_seconds,
        max_rss_bytes=max_rss,
        rss_growth_bytes=rss_growth,
        samples=len(rss_samples),
    )


def estimate_rss_growth(samples: list[int]) -> int:
    if len(samples) < 6:
        return 0
    split = len(samples) // 2
    first_avg = sum(samples[:split]) / split
    second_avg = sum(samples[split:]) / (len(samples) - split)
    return max(0, int(second_avg - first_avg))


def count_jsonl(path: Path) -> int:
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def analyze_processed_output(path: Path) -> dict:
    processed_events = 0
    actions = 0
    screenshots = 0
    action_screenshot_pairs = 0
    screenshot_action_screenshot_triples = 0
    action_types: set[str] = set()
    previous_type: str | None = None
    before_previous_type: str | None = None

    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            event = json.loads(line)
            event_type = event.get("type", "unknown")
            processed_events += 1
            if event_type == "screenshot":
                screenshots += 1
                if previous_type and previous_type != "screenshot":
                    action_screenshot_pairs += 1
                if before_previous_type == "screenshot" and previous_type and previous_type != "screenshot":
                    screenshot_action_screenshot_triples += 1
            else:
                actions += 1
                action_types.add(str(event_type))

            before_previous_type = previous_type
            previous_type = str(event_type)

    return {
        "processed_events": processed_events,
        "actions": actions,
        "screenshots": screenshots,
        "action_types": sorted(action_types),
        "action_screenshot_pairs": action_screenshot_pairs,
        "screenshot_action_screenshot_triples": screenshot_action_screenshot_triples,
    }


def exe_name(name: str) -> str:
    return f"{name}.exe" if sys.platform == "win32" else name


if __name__ == "__main__":
    raise SystemExit(main())
