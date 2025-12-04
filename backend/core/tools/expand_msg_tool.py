from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.agentpress.thread_manager import ThreadManager
from typing import List
import json

@tool_metadata(
    display_name="Internal Utilities",
    description="Internal tool loading and message expansion",
    icon="Maximize",
    color="bg-gray-100 dark:bg-gray-800/50",
    weight=100,
    visible=False,
    usage_guide="""
### INTERNAL UTILITIES

**load_tool_guide() - JIT Tool Activation:**
- INTERNAL operation - completely invisible to users
- Activates tools on-demand using SPARK algorithm
- Loads detailed usage documentation for YOU (not the user)
- Supports batch loading: load_tool_guide(["tool1", "tool2", "tool3"])

**CRITICAL USAGE:**
- Call silently at the start of every task
- Analyze user request → Determine ALL needed tools → Load in ONE batch
- Users NEVER see this operation or its output
- DO NOT mention tool loading in your responses to users

**expand_message() - Message Expansion:**
- View full content of truncated messages
- Use when previous messages were shortened
- Retrieve complete message history

**Both operations are internal and transparent to users.**
"""
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
        import asyncio
        import time
        from core.tools.tool_guide_registry import get_tool_guide, get_tool_guide_registry
        from core.spark import SPARKLoader
        from core.utils.logger import logger
        
        start = time.time()
        
        if isinstance(tool_names, str):
            tool_names = [tool_names]
        
        logger.info(f"🔍 [SPARK] Agent requesting guides for: {tool_names}")
        
        registry = get_tool_guide_registry()
        not_found = []
        
        valid_tool_names = []
        for tool_name in tool_names:
            if not registry.has_tool(tool_name):
                not_found.append(tool_name)
            else:
                valid_tool_names.append(tool_name)
        
        if not_found:
            available = ", ".join(registry.get_all_tool_names())
            logger.error(f"❌ [SPARK] Tools not found: {not_found}")
            return self.fail_response(
                f"Tools not found: {', '.join(not_found)}. Available tools: {available}"
            )
        
        project_id = getattr(self.thread_manager, 'project_id', None)
        spark_config = getattr(self.thread_manager, 'spark_config', None)
        
        logger.info(f"⚡ [SPARK FAST] Parallel activation of {len(valid_tool_names)} tools")
        activation_start = time.time()
        
        activation_tasks = [
            SPARKLoader.activate_tool(tool_name, self.thread_manager, project_id, spark_config=spark_config)
            for tool_name in valid_tool_names
        ]
        
        activation_results = await asyncio.gather(*activation_tasks, return_exceptions=True)
        logger.info(f"⏱️ [SPARK FAST] Parallel activation completed in {(time.time() - activation_start) * 1000:.1f}ms")
        
        from core.spark.result_types import ActivationSuccess, ActivationError
        
        guides = []
        activation_failures = []
        
        for tool_name, result in zip(valid_tool_names, activation_results):
            if isinstance(result, Exception):
                activation_failures.append(tool_name)
                logger.warning(f"⚠️  [SPARK] Failed to activate '{tool_name}': {result}")
            elif isinstance(result, ActivationError):
                activation_failures.append(tool_name)
                logger.warning(f"⚠️  [SPARK] {result.to_user_message()}")
            elif isinstance(result, ActivationSuccess):
                logger.debug(f"✅ [SPARK] {result}")
            
            guide = get_tool_guide(tool_name)
            if guide:
                guides.append(guide)
            else:
                info = registry.get_tool_info(tool_name)
                logger.warning(f"⚠️  [SPARK] Tool '{tool_name}' has no detailed guide")
                guides.append(f"## {info[0]}\n\nNo detailed guide available. Basic description: {info[1]}")
        
        if activation_failures:
            logger.error(f"❌ [SPARK] Failed to activate some tools: {activation_failures}")
        
        total_guide_size = sum(len(g) for g in guides)
        total_time = (time.time() - start) * 1000
        logger.info(f"✅ [SPARK FAST] Returned {len(guides)} guide(s) in {total_time:.1f}ms, total size: {total_guide_size:,} chars")
        logger.info(f"🎯 [SPARK] Tools now available for use: {[t for t in valid_tool_names if t not in activation_failures]}")
        
        result = self.success_response({
            "status": "success",
            "message": f"Loaded {len(guides)} tool guide(s). Tools are now available for use.",
            "guides": "\n\n---\n\n".join(guides),
            "activated_tools": [t for t in tool_names if t not in activation_failures],
            "_internal": True
        })
        
        return result

if __name__ == "__main__":
    import asyncio

    async def test_expand_message_tool():
        expand_message_tool = ExpandMessageTool()

        expand_message_result = await expand_message_tool.expand_message(
            message_id="004ab969-ef9a-4656-8aba-e392345227cd"
        )
        print("Expand message result:", expand_message_result)

    asyncio.run(test_expand_message_tool())