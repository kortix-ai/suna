from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.agentpress.thread_manager import ThreadManager
from typing import List
import json

@tool_metadata(
    display_name="Utility Tools",
    description="Expand messages and load tool guides",
    icon="Maximize",
    color="bg-gray-100 dark:bg-gray-800/50",
    weight=100,
    visible=False
)
class ExpandMessageTool(Tool):
    def __init__(self, thread_id: str, thread_manager: ThreadManager):
        super().__init__()
        self.thread_manager = thread_manager
        self.thread_id = thread_id

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "expand_message",
            "description": "Expand a message from the previous conversation with the user. Use this tool to expand a message that was truncated in the earlier conversation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message_id": {
                        "type": "string",
                        "description": "The ID of the message to expand. Must be a UUID."
                    }
                },
                "required": ["message_id"]
            }
        }
    })
    async def expand_message(self, message_id: str) -> ToolResult:
        """Expand a message from the previous conversation with the user.

        Args:
            message_id: The ID of the message to expand

        Returns:
            ToolResult indicating the message was successfully expanded
        """
        try:
            client = await self.thread_manager.db.client
            message = await client.table('messages').select('*').eq('message_id', message_id).eq('thread_id', self.thread_id).execute()

            if not message.data or len(message.data) == 0:
                return self.fail_response(f"Message with ID {message_id} not found in thread {self.thread_id}")

            message_data = message.data[0]
            message_content = message_data['content']
            final_content = message_content
            if isinstance(message_content, dict) and 'content' in message_content:
                final_content = message_content['content']
            elif isinstance(message_content, str):
                try:
                    parsed_content = json.loads(message_content)
                    if isinstance(parsed_content, dict) and 'content' in parsed_content:
                        final_content = parsed_content['content']
                except json.JSONDecodeError:
                    pass

            return self.success_response({"status": "Message expanded successfully.", "message": final_content})
        except Exception as e:
            return self.fail_response(f"Error expanding message: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "load_tool_guide",
            "description": "Load the detailed usage guide for a specific tool. Use this to understand how to use a tool effectively before calling it. The guide contains comprehensive documentation, examples, and best practices.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tool_names": {
                        "oneOf": [
                            {
                                "type": "string",
                                "description": "Single tool name to load guide for (e.g., 'browser_tool', 'sb_files_tool')"
                            },
                            {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Multiple tool names to load guides for in one call"
                            }
                        ],
                        "description": "Tool name(s) to load guides for. Can be a single string or array of strings."
                    }
                },
                "required": ["tool_names"]
            }
        }
    })
    async def load_tool_guide(self, tool_names: str | List[str]) -> ToolResult:
        """Load detailed usage guides for one or more tools.

        Args:
            tool_names: Single tool name or list of tool names

        Returns:
            ToolResult with the usage guide(s)
        """
        from core.tools.tool_guide_registry import get_tool_guide, get_tool_guide_registry
        
        if isinstance(tool_names, str):
            tool_names = [tool_names]
        
        registry = get_tool_guide_registry()
        guides = []
        not_found = []
        
        for tool_name in tool_names:
            guide = get_tool_guide(tool_name)
            if guide:
                guides.append(guide)
            elif registry.has_tool(tool_name):
                info = registry.get_tool_info(tool_name)
                guides.append(f"## {info[0]}\n\nNo detailed guide available. Basic description: {info[1]}")
            else:
                not_found.append(tool_name)
        
        if not_found:
            available = ", ".join(registry.get_all_tool_names())
            return self.fail_response(
                f"Tools not found: {', '.join(not_found)}. Available tools: {available}"
            )
        
        return self.success_response("\n\n---\n\n".join(guides))

if __name__ == "__main__":
    import asyncio

    async def test_expand_message_tool():
        expand_message_tool = ExpandMessageTool()

        # Test expand message
        expand_message_result = await expand_message_tool.expand_message(
            message_id="004ab969-ef9a-4656-8aba-e392345227cd"
        )
        print("Expand message result:", expand_message_result)

    asyncio.run(test_expand_message_tool())