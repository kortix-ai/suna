from typing import ClassVar
from dataclasses import dataclass

@dataclass
class StatelessConfig:

    MAX_MESSAGES: ClassVar[int] = 50
    MAX_TOOL_RESULTS: ClassVar[int] = 20
    MAX_PENDING_WRITES: ClassVar[int] = 100
    MAX_STEPS: ClassVar[int] = 100
    MAX_DURATION_SECONDS: ClassVar[int] = 3600
    
    FLUSH_INTERVAL_SECONDS: ClassVar[float] = 5.0
    HEARTBEAT_INTERVAL_SECONDS: ClassVar[int] = 15
    RECOVERY_SWEEP_INTERVAL_SECONDS: ClassVar[int] = 60
    
    HEARTBEAT_TTL_SECONDS: ClassVar[int] = 45
    CLAIM_TTL_SECONDS: ClassVar[int] = 3600
    ORPHAN_THRESHOLD_SECONDS: ClassVar[int] = 90
    STUCK_RUN_THRESHOLD_SECONDS: ClassVar[int] = 7200

    MAX_THREAD_LOCKS: ClassVar[int] = 100
    MAX_FLUSH_TASKS: ClassVar[int] = 10
    MAX_CONTENT_LENGTH: ClassVar[int] = 100_000
    
    TASK_CANCEL_TIMEOUT_SECONDS: ClassVar[float] = 2.0
    TOOL_CLEANUP_TIMEOUT_SECONDS: ClassVar[float] = 5.0
    
    PENDING_WRITES_WARNING_THRESHOLD: ClassVar[int] = 80
    FLUSH_LATENCY_WARNING_THRESHOLD_SECONDS: ClassVar[float] = 10.0
    ACTIVE_RUNS_WARNING_THRESHOLD: ClassVar[int] = 1000

config = StatelessConfig()
