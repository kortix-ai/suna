"""
Agent run lifecycle tracking for cleanup failure diagnosis.

Usage:
    from core.utils.lifecycle_tracker import log_run_start, log_run_cleanup, log_cleanup_error

    log_run_start(agent_run_id, thread_id)
    # ... run executes ...
    log_cleanup_error(agent_run_id, "redis_expire", e)  # if any cleanup step fails
    log_run_cleanup(agent_run_id, success=True, final_status="completed")
"""

from typing import Optional, Dict, List
import time
from core.utils.logger import logger

# Track active runs: agent_run_id -> (start_time, thread_id)
_active_runs: Dict[str, tuple] = {}


def log_run_start(agent_run_id: str, thread_id: str) -> None:
    """Log when an agent run starts execution."""
    _active_runs[agent_run_id] = (time.time(), thread_id)
    logger.info(
        f"[LIFECYCLE] START agent_run={agent_run_id} "
        f"thread={thread_id} active_count={len(_active_runs)}"
    )


def log_cleanup_error(agent_run_id: str, step: str, error: Exception) -> None:
    """Log when a specific cleanup step fails."""
    logger.error(
        f"[LIFECYCLE] CLEANUP_ERROR agent_run={agent_run_id} "
        f"step={step} error={type(error).__name__}: {str(error)[:100]}"
    )


def log_run_cleanup(
    agent_run_id: str, 
    success: bool, 
    reason: Optional[str] = None, 
    final_status: Optional[str] = None,
    cleanup_errors: Optional[List[str]] = None
) -> None:
    """Log when an agent run cleanup completes (success or failure)."""
    start_info = _active_runs.pop(agent_run_id, None)
    if start_info:
        duration = time.time() - start_info[0]
        thread_id = start_info[1]
    else:
        duration = 0.0
        thread_id = "unknown"
    
    if success:
        logger.info(
            f"[LIFECYCLE] CLEANUP_OK agent_run={agent_run_id} "
            f"thread={thread_id} status={final_status} "
            f"duration={duration:.1f}s active_count={len(_active_runs)}"
        )
    else:
        errors_str = f" errors={cleanup_errors}" if cleanup_errors else ""
        logger.error(
            f"[LIFECYCLE] CLEANUP_FAIL agent_run={agent_run_id} "
            f"thread={thread_id} reason={reason}{errors_str} "
            f"duration={duration:.1f}s active_count={len(_active_runs)}"
        )


def get_active_runs() -> Dict[str, float]:
    """Get currently active runs with their start times (for watchdog)."""
    return {rid: info[0] for rid, info in _active_runs.items()}


def get_stale_runs(max_age_seconds: int = 3600) -> List[str]:
    """Get agent_run_ids that have been running longer than max_age_seconds."""
    now = time.time()
    return [
        rid for rid, info in _active_runs.items()
        if (now - info[0]) > max_age_seconds
    ]
