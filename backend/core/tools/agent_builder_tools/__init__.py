from .base_tool import AgentBuilderBaseTool
from .agent_config_tool import AgentConfigTool
from .mcp_search_tool import MCPSearchTool
from .credential_profile_tool import CredentialProfileTool
from .workflow_tool import WorkflowTool
from .trigger_tool import TriggerTool
from typing import List, Type, Dict, Any
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger


class AgentBuilderToolRegistry:
    """Registry for managing and registering agent builder tools."""
    
    def __init__(self):
        self.tools: Dict[str, Type[AgentBuilderBaseTool]] = {
            'agent_config': AgentConfigTool,
            'mcp_search': MCPSearchTool,
            'credential_profile': CredentialProfileTool,
            'workflow': WorkflowTool,
            'trigger': TriggerTool,
        }
    
    def register_tool(self, name: str, tool_class: Type[AgentBuilderBaseTool]):
        """Register a new agent builder tool."""
        self.tools[name] = tool_class
        logger.debug(f"Registered agent builder tool: {name}")
    
    def get_tool(self, name: str) -> Type[AgentBuilderBaseTool]:
        """Get a tool class by name."""
        return self.tools.get(name)
    
    def get_all_tools(self) -> Dict[str, Type[AgentBuilderBaseTool]]:
        """Get all registered tools."""
        return self.tools.copy()
    
    def register_all_tools(self, thread_manager: ThreadManager, db_connection, agent_id: str):
        
        logger.debug(f"Registering {len(self.tools)} agent builder tools")
        
        for tool_name, tool_class in self.tools.items():
            try:
                thread_manager.add_tool(
                    tool_class,
                    thread_manager=thread_manager,
                    db_connection=db_connection,
                    agent_id=agent_id
                )
                logger.debug(f"Successfully registered agent builder tool: {tool_name}")
            except Exception as e:
                logger.error(f"Failed to register agent builder tool {tool_name}: {e}")
    
    def list_available_tools(self) -> List[str]:
        """List all available tool names."""
        return list(self.tools.keys())


# Create a global registry instance
agent_builder_registry = AgentBuilderToolRegistry()

# Export commonly used items
__all__ = [
    'AgentBuilderBaseTool',
    'AgentConfigTool',
    'MCPSearchTool',
    'CredentialProfileTool',
    'WorkflowTool',
    'AgentBuilderToolRegistry',
    'agent_builder_registry'
]
