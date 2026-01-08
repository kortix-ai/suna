from enum import Enum
from typing import Optional, Dict, Any, List
from datetime import datetime
from dataclasses import dataclass

class MemoryType(str, Enum):
    FACT = "fact"
    PREFERENCE = "preference"
    CONTEXT = "context"
    CONVERSATION_SUMMARY = "conversation_summary"

class ExtractionQueueStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"

@dataclass
class MemoryItem:
    memory_id: str
    account_id: str
    content: str
    memory_type: MemoryType
    embedding: Optional[List[float]] = None
    source_thread_id: Optional[str] = None
    confidence_score: float = 0.8
    metadata: Dict[str, Any] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    
    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}
        if isinstance(self.memory_type, str):
            self.memory_type = MemoryType(self.memory_type)
        if isinstance(self.created_at, str):
            self.created_at = datetime.fromisoformat(self.created_at.replace('Z', '+00:00'))
        if isinstance(self.updated_at, str):
            self.updated_at = datetime.fromisoformat(self.updated_at.replace('Z', '+00:00'))

@dataclass
class ExtractedMemory:
    content: str
    memory_type: MemoryType
    confidence_score: float
    metadata: Dict[str, Any] = None
    
    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}
        if isinstance(self.memory_type, str):
            self.memory_type = MemoryType(self.memory_type)
