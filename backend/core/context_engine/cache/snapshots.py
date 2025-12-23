from typing import Dict, Any, Optional, List
from dataclasses import dataclass, field
from datetime import datetime, timezone
from core.utils.logger import logger


@dataclass
class ContextSnapshot:
    thread_id: str
    created_at: datetime
    message_count: int
    token_count: int
    layer_distribution: Dict[str, int] = field(default_factory=dict)
    sources_used: Dict[str, int] = field(default_factory=dict)
    
    @classmethod
    def create(
        cls,
        thread_id: str,
        message_count: int,
        token_count: int,
        layer_distribution: Optional[Dict[str, int]] = None,
        sources_used: Optional[Dict[str, int]] = None,
    ) -> "ContextSnapshot":
        return cls(
            thread_id=thread_id,
            created_at=datetime.now(timezone.utc),
            message_count=message_count,
            token_count=token_count,
            layer_distribution=layer_distribution or {},
            sources_used=sources_used or {},
        )
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "thread_id": self.thread_id,
            "created_at": self.created_at.isoformat(),
            "message_count": self.message_count,
            "token_count": self.token_count,
            "layer_distribution": self.layer_distribution,
            "sources_used": self.sources_used,
        }
