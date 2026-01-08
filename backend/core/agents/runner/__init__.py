from typing import Optional, AsyncGenerator, Dict, Any, TYPE_CHECKING
import asyncio

if TYPE_CHECKING:
    from langfuse.client import StatefulTraceClient

from core.agents.runner.config import AgentConfig
from core.agents.runner.tool_manager import ToolManager
from core.agents.runner.mcp_manager import MCPManager
from core.agents.runner.prompt_manager import PromptManager
from core.agents.runner.agent_runner import (
    AgentRunner,
    execute_agent_run,
    stream_status_message,
    ensure_project_metadata_cached,
    update_agent_run_status,
)

__all__ = [
    'AgentConfig',
    'ToolManager',
    'MCPManager',
    'PromptManager',
    'AgentRunner',
    'run_agent',
    'execute_agent_run',
    'stream_status_message',
    'ensure_project_metadata_cached',
    'update_agent_run_status',
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
