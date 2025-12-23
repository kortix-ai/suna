from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional, Literal
from datetime import datetime
from enum import Enum


class LayerType(str, Enum):
    WORKING = "working"
    RECENT = "recent"
    HISTORICAL = "historical"
    ARCHIVED = "archived"


class ImportanceLevel(str, Enum):
    NORMAL = "normal"
    HIGH = "high"
    PINNED = "pinned"


@dataclass
class ContextChunk:
    content: str
    source: str
    tokens: int
    priority: float = 0.5
    created_at: Optional[datetime] = None
    message_id: Optional[str] = None
    embedding: Optional[List[float]] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    layer: Optional[LayerType] = None
    relevance_score: float = 0.0
    importance: ImportanceLevel = ImportanceLevel.NORMAL
    tool_call_group_id: Optional[str] = None
    
    def to_message(self) -> Dict[str, Any]:
        msg = {
            "role": self.metadata.get("role", "user"),
            "content": self.content,
        }
        if self.message_id:
            msg["message_id"] = self.message_id
        if "tool_call_id" in self.metadata:
            msg["tool_call_id"] = self.metadata["tool_call_id"]
        if "tool_calls" in self.metadata:
            msg["tool_calls"] = self.metadata["tool_calls"]
        if "name" in self.metadata:
            msg["name"] = self.metadata["name"]
        return msg
    
    def is_pinned(self) -> bool:
        return self.importance == ImportanceLevel.PINNED
    
    def is_high_importance(self) -> bool:
        return self.importance in (ImportanceLevel.HIGH, ImportanceLevel.PINNED)
    
    def has_tool_calls(self) -> bool:
        return bool(self.metadata.get("tool_calls"))
    
    def get_tool_call_id(self) -> Optional[str]:
        return self.metadata.get("tool_call_id")


@dataclass
class LayerConfig:
    messages: Optional[int] = None
    tokens: int = 10000
    compression_level: Literal["none", "light", "heavy", "extreme"] = "none"
    
    def __post_init__(self):
        if self.tokens < 0:
            raise ValueError("tokens must be non-negative")


@dataclass
class LayersConfig:
    working: LayerConfig = field(default_factory=lambda: LayerConfig(messages=15, tokens=60000, compression_level="none"))
    recent: LayerConfig = field(default_factory=lambda: LayerConfig(messages=40, tokens=50000, compression_level="light"))
    historical: LayerConfig = field(default_factory=lambda: LayerConfig(messages=150, tokens=30000, compression_level="heavy"))
    archived: LayerConfig = field(default_factory=lambda: LayerConfig(tokens=10000, compression_level="extreme"))
    
    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "LayersConfig":
        return cls(
            working=LayerConfig(**d.get("working", {})),
            recent=LayerConfig(**d.get("recent", {})),
            historical=LayerConfig(**d.get("historical", {})),
            archived=LayerConfig(**d.get("archived", {})),
        )
    
    def get_layer(self, layer_type: LayerType) -> LayerConfig:
        return getattr(self, layer_type.value)
    
    def total_tokens(self) -> int:
        return self.working.tokens + self.recent.tokens + self.historical.tokens + self.archived.tokens


@dataclass
class SourceConfig:
    type: str
    name: str
    priority: int = 50
    config: Dict[str, Any] = field(default_factory=dict)


@dataclass
class LayerStats:
    layer: LayerType
    messages: int
    tokens: int
    chunks: int
    compression_applied: bool = False


@dataclass
class CompileRules:
    include_system_prompt: bool = True
    include_recent_messages: bool = True
    include_thread_memory: bool = True
    time_decay: str = "14d"
    relevance_threshold: float = 0.3
    deduplicate: bool = True
    use_semantic_ranking: bool = True


@dataclass
class CompileResult:
    messages: List[Dict[str, Any]]
    system_prompt: Optional[Dict[str, Any]]
    token_count: int
    layer_stats: Dict[str, LayerStats]
    sources_used: Dict[str, int]
    chunks_by_layer: Dict[LayerType, List[ContextChunk]]
    compression_stats: Dict[str, Any] = field(default_factory=dict)
    
    def get_prepared_messages(self) -> List[Dict[str, Any]]:
        if self.system_prompt:
            return [self.system_prompt] + self.messages
        return self.messages
    
    def summary(self) -> str:
        layer_summary = ", ".join(
            f"{k}: {v.tokens}t/{v.messages}m" 
            for k, v in self.layer_stats.items()
        )
        source_summary = ", ".join(
            f"{k}: {v}t" 
            for k, v in self.sources_used.items()
        )
        return f"Total: {self.token_count} tokens | Layers: [{layer_summary}] | Sources: [{source_summary}]"


@dataclass
class ToolCallGroup:
    assistant_chunk: ContextChunk
    tool_chunks: List[ContextChunk]
    group_id: str
    
    @property
    def total_tokens(self) -> int:
        return self.assistant_chunk.tokens + sum(c.tokens for c in self.tool_chunks)
    
    @property
    def all_chunks(self) -> List[ContextChunk]:
        return [self.assistant_chunk] + self.tool_chunks
    
    def is_complete(self) -> bool:
        tool_calls = self.assistant_chunk.metadata.get("tool_calls", [])
        expected_ids = {tc.get("id") for tc in tool_calls if isinstance(tc, dict)}
        actual_ids = {c.get_tool_call_id() for c in self.tool_chunks}
        return expected_ids == actual_ids


@dataclass
class MessageGroup:
    messages: List[Dict[str, Any]]
    tokens: int
    is_tool_call_group: bool = False
    tool_call_ids: List[str] = field(default_factory=list)
    
    def to_chunks(self, source: str) -> List[ContextChunk]:
        chunks = []
        for msg in self.messages:
            content = msg.get("content", "")
            if isinstance(content, list):
                text_parts = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text_parts.append(block.get("text", ""))
                content = " ".join(text_parts)
            
            chunks.append(ContextChunk(
                content=content if isinstance(content, str) else str(content),
                source=source,
                tokens=0,
                message_id=msg.get("message_id"),
                metadata={
                    "role": msg.get("role"),
                    "tool_call_id": msg.get("tool_call_id"),
                    "tool_calls": msg.get("tool_calls"),
                    "name": msg.get("name"),
                },
                created_at=msg.get("created_at"),
            ))
        return chunks
