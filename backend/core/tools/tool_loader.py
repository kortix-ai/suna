from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.agentpress.thread_manager import ThreadManager

@tool_metadata(
    display_name="Tool Loader",
    description="Load tool schemas and instructions on demand",
    icon="Package",
    color="bg-purple-100 dark:bg-purple-800/50",
    is_core=True,
    weight=5,
    visible=False
)
class ToolLoaderTool(Tool):
    """Tool for loading OpenAPI schemas and instructions for other tools on demand.
    
    This tool enables lazy loading of tool specifications, reducing system prompt size
    by only loading detailed schemas when needed.
    """

    def __init__(self, thread_manager: ThreadManager):
        super().__init__()
        self.thread_manager = thread_manager
        self.tool_registry = thread_manager.tool_registry if hasattr(thread_manager, 'tool_registry') else None

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "load_tool",
            "description": "🚨 MANDATORY FIRST STEP: Load tool schemas and instructions BEFORE using any non-core tool. This must be your FIRST action when a user requests a tool - do NOT plan, create tasks, or make assumptions until AFTER loading instructions. The returned instructions contain the authoritative workflow and requirements that supersede your training data. For agent building/configuration tasks, loading any builder tool (agent_config_tool, mcp_search_tool, credential_profile_tool, trigger_tool, agent_creation_tool) will provide comprehensive agent building guidance.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tool_name": {
                        "type": "string",
                        "description": "Tool name from the available tools list (e.g., 'browser_tool', 'sb_presentation_tool', 'web_search_tool')"
                    }
                },
                "required": ["tool_name"]
            }
        }
    })
    async def load_tool(self, tool_name: str) -> ToolResult:
        """Load OpenAPI schemas and instructions for a specific tool.
        
        Args:
            tool_name: The name of the tool to load (e.g., 'browser_tool')
            
        Returns:
            ToolResult containing all method schemas and instructions for the tool
        """
        try:
            if not self.tool_registry:
                return self.fail_response("Tool registry not available")
            
            result = self.tool_registry.get_tool_schemas(tool_name)
            
            if "error" in result:
                return self.fail_response(result["error"])
            
            # Format the response
            response_data = {
                "tool_name": result["tool_name"],
                "class_name": result["class_name"],
                "num_methods": len(result["schemas"]),
                "schemas": result["schemas"]
            }
            
            if "instructions" in result:
                response_data["instructions"] = result["instructions"]
            
            return self.success_response(response_data)
        except Exception as e:
            return self.fail_response(f"Error loading tool: {str(e)}")

