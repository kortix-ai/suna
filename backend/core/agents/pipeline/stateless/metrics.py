import time
import threading
from typing import Dict, Any, List
from dataclasses import dataclass, field
from collections import deque


@dataclass
class Counter:
    name: str
    value: int = 0

    def inc(self, n: int = 1) -> None:
        self.value += n

    def get(self) -> int:
        return self.value


@dataclass
class Gauge:
    name: str
    value: float = 0.0

    def set(self, v: float) -> None:
        self.value = v

    def inc(self, n: float = 1.0) -> None:
        self.value += n

    def dec(self, n: float = 1.0) -> None:
        self.value -= n

    def get(self) -> float:
        return self.value


@dataclass
class Histogram:
    name: str
    buckets: List[float] = field(default_factory=lambda: [0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0, 30.0, 60.0])
    observations: deque = field(default_factory=lambda: deque(maxlen=1000))

    def observe(self, v: float) -> None:
        self.observations.append(v)

    def count(self) -> int:
        return len(self.observations)

    def sum(self) -> float:
        return sum(self.observations)

    def avg(self) -> float:
        return self.sum() / self.count() if self.observations else 0.0

    def percentile(self, p: float) -> float:
        if not self.observations:
            return 0.0
        s = sorted(self.observations)
        i = int(len(s) * p / 100)
        return s[min(i, len(s) - 1)]


class Metrics:
    def __init__(self):
        self._lock = threading.Lock()

        self.active_runs = Gauge("suna_active_runs")
        self.owned_runs = Gauge("suna_owned_runs")
        self.pending_writes = Gauge("suna_pending_writes")

        self.runs_started = Counter("suna_runs_started")
        self.runs_completed = Counter("suna_runs_completed")
        self.runs_failed = Counter("suna_runs_failed")
        self.runs_recovered = Counter("suna_runs_recovered")
        self.writes_flushed = Counter("suna_writes_flushed")

        self.run_duration = Histogram("suna_run_duration_seconds", [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600])
        self.flush_latency = Histogram("suna_flush_latency_seconds", [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0])
        self.step_latency = Histogram("suna_step_latency_seconds", [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0])

    def record_run_started(self) -> None:
        self.runs_started.inc()
        self.active_runs.inc()

    def record_run_completed(self, duration: float) -> None:
        self.runs_completed.inc()
        self.active_runs.dec()
        self.run_duration.observe(duration)

    def record_run_failed(self, duration: float) -> None:
        self.runs_failed.inc()
        self.active_runs.dec()
        self.run_duration.observe(duration)

    def record_run_recovered(self) -> None:
        self.runs_recovered.inc()

    def record_writes_flushed(self, count: int, latency: float) -> None:
        self.writes_flushed.inc(count)
        self.flush_latency.observe(latency)

    def record_step(self, latency: float) -> None:
        self.step_latency.observe(latency)

    def update_buffer(self, pending: int) -> None:
        self.pending_writes.set(pending)

    def update_ownership(self, owned: int) -> None:
        self.owned_runs.set(owned)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "active_runs": self.active_runs.get(),
            "owned_runs": self.owned_runs.get(),
            "pending_writes": self.pending_writes.get(),
            "runs_started": self.runs_started.get(),
            "runs_completed": self.runs_completed.get(),
            "runs_failed": self.runs_failed.get(),
            "runs_recovered": self.runs_recovered.get(),
            "writes_flushed": self.writes_flushed.get(),
            "run_duration_avg": self.run_duration.avg(),
            "run_duration_p99": self.run_duration.percentile(99),
            "flush_latency_avg": self.flush_latency.avg(),
            "flush_latency_p99": self.flush_latency.percentile(99),
            "step_latency_avg": self.step_latency.avg(),
            "step_latency_p99": self.step_latency.percentile(99),
        }

    def to_prometheus(self) -> str:
        lines = []

        for g in [self.active_runs, self.owned_runs, self.pending_writes]:
            lines.append(f"# TYPE {g.name} gauge")
            lines.append(f"{g.name} {g.get()}")

        for c in [self.runs_started, self.runs_completed, self.runs_failed, self.runs_recovered, self.writes_flushed]:
            lines.append(f"# TYPE {c.name} counter")
            lines.append(f"{c.name} {c.get()}")

        for h in [self.run_duration, self.flush_latency, self.step_latency]:
            lines.append(f"# TYPE {h.name} histogram")
            lines.append(f"{h.name}_count {h.count()}")
            lines.append(f"{h.name}_sum {h.sum()}")

        return "\n".join(lines)

    def check_health(self) -> Dict[str, Any]:
        alerts = []

        if self.pending_writes.get() > 80:
            alerts.append({"level": "warning", "metric": "pending_writes", "value": self.pending_writes.get()})

        if self.flush_latency.percentile(99) > 10.0:
            alerts.append({"level": "warning", "metric": "flush_latency_p99", "value": self.flush_latency.percentile(99)})

        if self.active_runs.get() > 500:
            alerts.append({"level": "warning", "metric": "active_runs", "value": self.active_runs.get()})

        return {
            "healthy": len([a for a in alerts if a.get("level") == "critical"]) == 0,
            "alerts": alerts,
            "metrics": self.to_dict(),
        }


metrics = Metrics()
