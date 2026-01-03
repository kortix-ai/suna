"""
Task message types for Redis Streams worker.

Defines all task message classes and parsing logic.
"""

import json
import time
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional, Dict, Any, List


class StreamName(str, Enum):
    """Stream names for different task types."""
    AGENT_RUNS = "suna:agent-runs:v1"
    THREAD_INIT = "suna:thread-init:v1"
    MEMORY = "suna:memory:v1"
    CATEGORIZATION = "suna:categorization:v1"


@dataclass
class TaskMessage:
    """Base class for all task messages."""
    task_type: str
    enqueued_at: float = field(default_factory=time.time)
    
    def to_dict(self) -> Dict[str, str]:
        """Convert to Redis stream fields (all strings)."""
        result = {}
        for key, value in asdict(self).items():
            if value is None:
                result[key] = ""
            elif isinstance(value, (list, dict)):
                result[key] = json.dumps(value)
            else:
                result[key] = str(value)
        return result
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "TaskMessage":
        """Parse from Redis stream fields."""
        raise NotImplementedError("Subclasses must implement from_dict")


@dataclass
class AgentRunTask(TaskMessage):
    """Task for running an agent."""
    task_type: str = "agent_run"
    agent_run_id: str = ""
    thread_id: str = ""
    instance_id: str = ""
    project_id: str = ""
    model_name: str = ""
    agent_id: Optional[str] = None
    account_id: Optional[str] = None
    request_id: Optional[str] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "AgentRunTask":
        return cls(
            agent_run_id=data.get("agent_run_id", ""),
            thread_id=data.get("thread_id", ""),
            instance_id=data.get("instance_id", ""),
            project_id=data.get("project_id", ""),
            model_name=data.get("model_name", ""),
            agent_id=data.get("agent_id") or None,
            account_id=data.get("account_id") or None,
            request_id=data.get("request_id") or None,
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class ThreadInitTask(TaskMessage):
    """Task for initializing a thread."""
    task_type: str = "thread_init"
    thread_id: str = ""
    project_id: str = ""
    account_id: str = ""
    prompt: str = ""
    agent_id: Optional[str] = None
    model_name: Optional[str] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "ThreadInitTask":
        return cls(
            thread_id=data.get("thread_id", ""),
            project_id=data.get("project_id", ""),
            account_id=data.get("account_id", ""),
            prompt=data.get("prompt", ""),
            agent_id=data.get("agent_id") or None,
            model_name=data.get("model_name") or None,
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class MemoryExtractionTask(TaskMessage):
    """Task for extracting memories from a conversation."""
    task_type: str = "memory_extraction"
    thread_id: str = ""
    account_id: str = ""
    message_ids: List[str] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, str]:
        result = super().to_dict()
        result["message_ids"] = json.dumps(self.message_ids)
        return result
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "MemoryExtractionTask":
        message_ids = json.loads(data.get("message_ids", "[]"))
        return cls(
            thread_id=data.get("thread_id", ""),
            account_id=data.get("account_id", ""),
            message_ids=message_ids,
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class MemoryEmbeddingTask(TaskMessage):
    """Task for embedding and storing memories."""
    task_type: str = "memory_embedding"
    account_id: str = ""
    thread_id: str = ""
    extracted_memories: List[Dict[str, Any]] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, str]:
        result = super().to_dict()
        result["extracted_memories"] = json.dumps(self.extracted_memories)
        return result
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "MemoryEmbeddingTask":
        memories = json.loads(data.get("extracted_memories", "[]"))
        return cls(
            account_id=data.get("account_id", ""),
            thread_id=data.get("thread_id", ""),
            extracted_memories=memories,
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class MemoryConsolidationTask(TaskMessage):
    """Task for consolidating memories."""
    task_type: str = "memory_consolidation"
    account_id: str = ""
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "MemoryConsolidationTask":
        return cls(
            account_id=data.get("account_id", ""),
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class CategorizationTask(TaskMessage):
    """Task for categorizing a project."""
    task_type: str = "categorization"
    project_id: str = ""
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "CategorizationTask":
        return cls(
            project_id=data.get("project_id", ""),
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class StaleProjectsTask(TaskMessage):
    """Task for processing stale projects."""
    task_type: str = "stale_projects"
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "StaleProjectsTask":
        return cls(
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


# Task type to class mapping
TASK_CLASSES = {
    "agent_run": AgentRunTask,
    "thread_init": ThreadInitTask,
    "memory_extraction": MemoryExtractionTask,
    "memory_embedding": MemoryEmbeddingTask,
    "memory_consolidation": MemoryConsolidationTask,
    "categorization": CategorizationTask,
    "stale_projects": StaleProjectsTask,
}


def parse_task_message(data: Dict[str, str]) -> TaskMessage:
    """Parse a task message from Redis stream fields."""
    task_type = data.get("task_type", "")
    task_class = TASK_CLASSES.get(task_type)
    if not task_class:
        raise ValueError(f"Unknown task type: {task_type}")
    return task_class.from_dict(data)

