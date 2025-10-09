import structlog
from typing import Optional
from core.agentpress.tool import Tool, tool_metadata
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger

@tool_metadata(
    display_name="Agent Builder Base",
    description="Base tool for agent building functionality",
    icon="Wrench",
    color="bg-gray-100 dark:bg-gray-800/50",
    weight=900,
    visible=False
)
class AgentBuilderBaseTool(Tool):
    def __init__(self, thread_manager: ThreadManager, db_connection, agent_id: str):
        super().__init__()
        self.thread_manager = thread_manager
        self.db = db_connection
        self.agent_id = agent_id
    
    async def _get_current_account_id(self) -> str:
        """Get account_id from current thread context."""
        context_vars = structlog.contextvars.get_contextvars()
        thread_id = context_vars.get('thread_id')
        
        if not thread_id:
            raise ValueError("No thread_id available from execution context")
        
        from core.utils.auth_utils import get_account_id_from_thread
        return await get_account_id_from_thread(thread_id, self.db)

    async def _get_agent_data(self) -> Optional[dict]:
        try:
            client = await self.db.client
            result = await client.table('agents').select('*').eq('agent_id', self.agent_id).execute()
            
            if not result.data:
                return None
                
            return result.data[0]
            
        except Exception as e:
            logger.error(f"Error getting agent data: {e}")
            return None 