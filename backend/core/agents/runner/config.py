from dataclasses import dataclass
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from langfuse.client import StatefulTraceClient

@dataclass
class AgentConfig:
    thread_id: str
    project_id: str
    native_max_auto_continues: int = 25
    max_iterations: int = 100
    model_name: Optional[str] = None
    agent_config: Optional[dict] = None
    trace: Optional['StatefulTraceClient'] = None
    account_id: Optional[str] = None
