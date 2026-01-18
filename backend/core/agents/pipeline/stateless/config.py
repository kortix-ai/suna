"""
Centralized configuration for stateless pipeline.
All resource limits and intervals in one place for easy tuning.
"""
from typing import ClassVar
from dataclasses import dataclass


@dataclass
class StatelessConfig:
    """Centralized configuration for stateless pipeline execution."""
    
    # Message & State Limits
    MAX_MESSAGES: ClassVar[int] = 50
    MAX_TOOL_RESULTS: ClassVar[int] = 20
    MAX_PENDING_WRITES: ClassVar[int] = 100
    MAX_STEPS: ClassVar[int] = 100
    MAX_DURATION_SECONDS: ClassVar[int] = 3600  # 1 hour
    
    # Background Task Intervals
    FLUSH_INTERVAL_SECONDS: ClassVar[float] = 5.0
    HEARTBEAT_INTERVAL_SECONDS: ClassVar[int] = 10
    RECOVERY_SWEEP_INTERVAL_SECONDS: ClassVar[int] = 30
    
    # Timeouts & TTLs
    HEARTBEAT_TTL_SECONDS: ClassVar[int] = 30
    CLAIM_TTL_SECONDS: ClassVar[int] = 3600
    ORPHAN_THRESHOLD_SECONDS: ClassVar[int] = 60
    STUCK_RUN_THRESHOLD_SECONDS: ClassVar[int] = 7200  # 2 hours
    
    # Resource Limits (Prevent Unbounded Growth)
    MAX_THREAD_LOCKS: ClassVar[int] = 100
    MAX_FLUSH_TASKS: ClassVar[int] = 10
    MAX_CONTENT_LENGTH: ClassVar[int] = 100_000  # 100KB accumulated content
    
    # Cleanup Timeouts
    TASK_CANCEL_TIMEOUT_SECONDS: ClassVar[float] = 2.0
    TOOL_CLEANUP_TIMEOUT_SECONDS: ClassVar[float] = 5.0
    
    # Health Check Thresholds
    PENDING_WRITES_WARNING_THRESHOLD: ClassVar[int] = 80
    FLUSH_LATENCY_WARNING_THRESHOLD_SECONDS: ClassVar[float] = 10.0
    ACTIVE_RUNS_WARNING_THRESHOLD: ClassVar[int] = 500


# Singleton instance
config = StatelessConfig()
