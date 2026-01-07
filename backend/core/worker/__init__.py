"""
Background task utilities for memory and categorization.

Agent runs execute directly via executor.py - this module only handles
memory/categorization background tasks.
"""

from .tasks import (
    StreamName,
    TaskMessage,
    MemoryExtractionTask,
    MemoryEmbeddingTask,
    MemoryConsolidationTask,
    CategorizationTask,
    StaleProjectsTask,
    parse_task_message,
)

from .background_tasks import (
    start_memory_extraction as dispatch_memory_extraction,
    start_memory_embedding as dispatch_memory_embedding,
    start_memory_consolidation as dispatch_memory_consolidation,
    start_categorization as dispatch_categorization,
    start_stale_projects as dispatch_stale_projects,
)

from .helpers import initialize
