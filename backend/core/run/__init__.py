from typing import Optional, AsyncGenerator, Dict, Any, TYPE_CHECKING
import asyncio

if TYPE_CHECKING:
    from langfuse.client import StatefulTraceClient

from core.run.config import AgentConfig
from core.run.tool_manager import ToolManager
from core.run.mcp_manager import MCPManager
from core.run.prompt_manager import PromptManager
from core.run.agent_runner import AgentRunner

__all__ = [
    'AgentConfig',
    'ToolManager',
    'MCPManager',
    'PromptManager',
    'AgentRunner',
    'run_agent'
]

async def run_agent(
    thread_id: str,
    project_id: str,
    thread_manager: Optional[Any] = None,
    native_max_auto_continues: int = 25,
    max_iterations: int = 100,
    model_name: Optional[str] = None,
    agent_config: Optional[dict] = None,    
    trace: Optional['StatefulTraceClient'] = None,
    cancellation_event: Optional[asyncio.Event] = None,
    account_id: Optional[str] = None
) -> AsyncGenerator[Dict[str, Any], None]:
    effective_model = model_name
    
    config = AgentConfig(
        thread_id=thread_id,
        project_id=project_id,
        native_max_auto_continues=native_max_auto_continues,
        max_iterations=max_iterations,
        model_name=effective_model,
        agent_config=agent_config,
        trace=trace,
        account_id=account_id
    )
    
    runner = AgentRunner(config)
    async for chunk in runner.run(cancellation_event=cancellation_event):
        yield chunk
