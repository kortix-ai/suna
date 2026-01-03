"""Worker utilities for agent run processing and background tasks."""

# Task types and messages
from .tasks import (
    StreamName,
    TaskMessage,
    AgentRunTask,
    ThreadInitTask,
    MemoryExtractionTask,
    MemoryEmbeddingTask,
    MemoryConsolidationTask,
    CategorizationTask,
    StaleProjectsTask,
    parse_task_message,
)

# Dispatch functions
from .dispatcher import (
    dispatch_agent_run,
    dispatch_thread_init,
    dispatch_memory_extraction,
    dispatch_memory_embedding,
    dispatch_memory_consolidation,
    dispatch_categorization,
    dispatch_stale_projects,
)

# Consumer
from .consumer import StreamWorker, ensure_consumer_groups, reclaim_pending_messages, get_stream_info

# Handlers - imported lazily to avoid circular imports
# Use: from core.worker.handlers import get_handlers

# Agent run helpers
from .helpers import (
    initialize,
    acquire_run_lock,
    create_redis_keys,
    stream_status_message,
    load_agent_config,
    update_agent_run_status,
    process_agent_responses,
    handle_normal_completion,
    send_completion_notification,
    send_failure_notification,
    publish_final_control_signal,
    cleanup_redis_keys,
    check_terminating_tool_call,
)
