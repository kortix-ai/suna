import structlog
from typing import Optional
from core.agentpress.tool import Tool
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger


class AgentBuilderBaseTool(Tool):
    def __init__(self, thread_manager: ThreadManager, db_connection, agent_id: str):
        super().__init__()
        self.thread_manager = thread_manager
        self.db = db_connection
        self.agent_id = agent_id
    
    async def _get_current_account_id(self) -> str:
        try:
            context_vars = structlog.contextvars.get_contextvars()
            thread_id = context_vars.get('thread_id')
            
            if not thread_id:
                raise ValueError("No thread_id available from execution context")
            
            client = await self.db.client
            
            thread_result = await client.table('threads').select('account_id').eq('thread_id', thread_id).limit(1).execute()
            if not thread_result.data:
                raise ValueError(f"Could not find thread with ID: {thread_id}")
            
            account_id = thread_result.data[0]['account_id']
            if not account_id:
                raise ValueError("Thread has no associated account_id")
            
            return account_id
            
        except Exception as e:
            logger.error(f"Error getting current account_id: {e}")
            raise

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