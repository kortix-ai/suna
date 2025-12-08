from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.agentpress.thread_manager import ThreadManager
from typing import List
import json

@tool_metadata(
    display_name="Internal Utilities",
    description="Internal tool loading, MCP integration, and message expansion",
    icon="Maximize",
    color="bg-gray-100 dark:bg-gray-800/50",
    weight=100,
    visible=False,
    usage_guide="""
### INTERNAL UTILITIES

**initialize_tools() - JIT Tool Activation:**
- INTERNAL operation - completely invisible to users
- Activates tools on-demand using SPARK algorithm
- Loads detailed usage documentation for YOU (not the user)
- Supports batch loading: initialize_tools(["tool1", "tool2", "tool3"])

**CRITICAL USAGE:**
- Call silently at the start of every task
- Analyze user request → Determine ALL needed tools → Load in ONE batch
- Users NEVER see this operation or its output
- DO NOT mention tool loading in your responses to users

**discover_mcp_tools(filter) - MCP Schema Discovery:**
- Get schemas for external MCP tools (Gmail, Twitter, Slack, etc.)
- ALWAYS check conversation history first - schemas persist forever
- Batch discover ALL tools needed in ONE call
- Example: discover_mcp_tools(filter="GMAIL_SEND_MESSAGE,TWITTER_CREATION_OF_A_POST")

**execute_mcp_tool(tool_name, args) - MCP Tool Execution:**
- Execute external integration tools
- Requires schema in conversation history (discover first if needed)
- Example: execute_mcp_tool(tool_name="GMAIL_SEND_MESSAGE", args={"to": "user@example.com", ...})

**expand_message(message_id) - Message Expansion:**
- View full content of truncated messages
- Use when previous messages were shortened
- Retrieve complete message history

**Most operations are internal and transparent to users.**
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
            "name": "discover_mcp_tools", 
            "description": "Get schemas for external MCP tools (Gmail, Twitter, Slack, etc.). CRITICAL WORKFLOW: (1) Check conversation history FIRST - if tool schemas already exist, skip discovery! (2) If NOT in history: Discover ALL needed tools in ONE batch call. (3) Schemas are cached in conversation forever - NEVER discover same tools twice!",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "string",
                        "description": "Comma-separated list of ALL tools needed (e.g., 'GMAIL_SEND_MESSAGE,TWITTER_CREATION_OF_A_POST,SLACK_SEND_MESSAGE') OR toolkit name (e.g., 'gmail'). CRITICAL: List ALL tools in ONE call, never call discover multiple times for the same task!"
                    }
                },
                "required": ["filter"]
            }
        }
    }) 
    async def discover_mcp_tools(self, filter: str) -> ToolResult:
        return await self._discover_tools(filter)

    @openapi_schema({
        "type": "function", 
        "function": {
            "name": "execute_mcp_tool", 
            "description": "Execute external MCP tool (Gmail, Twitter, Slack, etc.). PREREQUISITE: Tool schema MUST be in conversation history (use discover_mcp_tools first if needed). Use exact tool name and parameters from the discovered schema.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tool_name": {
                        "type": "string",
                        "description": "Exact tool name from discovered schema (e.g., 'GMAIL_SEND_MESSAGE', 'TWITTER_CREATION_OF_A_POST'). Must match schema in conversation history."
                    },
                    "args": {
                        "type": "object", 
                        "description": "Arguments matching discovered schema parameters. Use exact parameter names from schema in conversation history. Use empty object {} if no parameters required."
                    }
                },
                "required": ["tool_name", "args"]
            }
        }
    }) 
    async def execute_mcp_tool(self, tool_name: str, args: dict) -> ToolResult:
        return await self._call_tool(tool_name, args)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "initialize_tools",
            "description": "Initialize tools needed for your task. Loads the detailed usage guides and activates the tools so they're ready to use. Call this at the start with ALL tools you'll need.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tool_names": {
                        "oneOf": [
                            {
                                "type": "string",
                                "description": "Single tool name to initialize (e.g., 'browser_tool', 'sb_files_tool')"
                            },
                            {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Multiple tool names to initialize in one batch call"
                            }
                        ],
                        "description": "Tool name(s) to initialize. Can be a single string or array of strings."
                    }
                },
                "required": ["tool_names"]
            }
        }
    })
    async def initialize_tools(self, tool_names: str | List[str]) -> ToolResult:
        import asyncio
        import time
        from core.tools.tool_guide_registry import get_tool_guide, get_tool_guide_registry
        from core.jit import JITLoader
        from core.utils.logger import logger
        
        start = time.time()
        
        if isinstance(tool_names, str):
            tool_names = [tool_names]
        
        logger.info(f"🔧 [INIT TOOLS] Initializing tools: {tool_names}")
        
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
            logger.error(f"❌ [INIT TOOLS] Tools not found: {not_found}")
            return self.fail_response(
                f"Tools not found: {', '.join(not_found)}. Available tools: {available}"
            )
        
        project_id = getattr(self.thread_manager, 'project_id', None)
        jit_config = getattr(self.thread_manager, 'jit_config', None)
        
        logger.info(f"⚡ [INIT TOOLS] Parallel activation of {len(valid_tool_names)} tools")
        activation_start = time.time()
        
        activation_tasks = [
            JITLoader.activate_tool(tool_name, self.thread_manager, project_id, jit_config=jit_config)
            for tool_name in valid_tool_names
        ]
        
        activation_results = await asyncio.gather(*activation_tasks, return_exceptions=True)
        logger.info(f"⏱️ [INIT TOOLS] Parallel activation completed in {(time.time() - activation_start) * 1000:.1f}ms")
        
        from core.jit.result_types import ActivationSuccess, ActivationError
        
        guides = []
        activation_failures = []
        
        for tool_name, result in zip(valid_tool_names, activation_results):
            if isinstance(result, Exception):
                activation_failures.append(tool_name)
                logger.warning(f"⚠️  [INIT TOOLS] Failed to activate '{tool_name}': {result}")
            elif isinstance(result, ActivationError):
                activation_failures.append(tool_name)
                logger.warning(f"⚠️  [INIT TOOLS] {result.to_user_message()}")
            elif isinstance(result, ActivationSuccess):
                logger.debug(f"✅ [INIT TOOLS] {result}")
        
        from core.jit.tool_cache import get_tool_cache
        
        tool_cache = get_tool_cache()
        cached_guides = await tool_cache.get_multiple(valid_tool_names)
        
        guides = []
        guides_to_cache = {}
        
        for tool_name in valid_tool_names:
            cached_guide = cached_guides.get(tool_name)
            if cached_guide:
                guides.append(cached_guide)
                logger.debug(f"✅ [CACHE HIT] {tool_name}")
            else:
                guide = get_tool_guide(tool_name)
                if guide:
                    guides.append(guide)
                    guides_to_cache[tool_name] = guide
                    logger.debug(f"❌ [CACHE MISS] {tool_name}")
                else:
                    info = registry.get_tool_info(tool_name)
                    logger.warning(f"⚠️  [INIT TOOLS] Tool '{tool_name}' has no detailed guide")
                    fallback_guide = f"## {info[0]}\n\nNo detailed guide available. Basic description: {info[1]}"
                    guides.append(fallback_guide)
                    guides_to_cache[tool_name] = fallback_guide
        
        if guides_to_cache:
            await tool_cache.set_multiple(guides_to_cache)
            logger.info(f"💾 [CACHE STORE] Cached {len(guides_to_cache)} new guides")
        
        if activation_failures:
            logger.error(f"❌ [INIT TOOLS] Failed to activate some tools: {activation_failures}")
        
        total_guide_size = sum(len(g) for g in guides)
        total_time = (time.time() - start) * 1000
        logger.info(f"✅ [INIT TOOLS] Returned {len(guides)} guide(s) in {total_time:.1f}ms, total size: {total_guide_size:,} chars")
        logger.info(f"🎯 [INIT TOOLS] Tools now available for use: {[t for t in valid_tool_names if t not in activation_failures]}")
        
        result = self.success_response({
            "status": "success",
            "message": f"Loaded {len(guides)} tool guide(s). Tools are now available for use.",
            "guides": "\n\n---\n\n".join(guides),
            "activated_tools": [t for t in tool_names if t not in activation_failures],
            "_internal": True
        })
        
        return result

    async def _discover_tools(self, filter: str = None) -> ToolResult:
        from core.agentpress.mcp_registry import get_mcp_registry
        from core.utils.logger import logger
        
        mcp_registry = get_mcp_registry()
        
        mcp_loader = getattr(self.thread_manager, 'mcp_loader', None)
        if mcp_loader:
            loader_tool_count = len(mcp_loader.tool_map) if mcp_loader.tool_map else 0
            registry_tool_count = len(mcp_registry._tools)
            
            if not mcp_registry._initialized or loader_tool_count > registry_tool_count:
                from core.agentpress.mcp_registry import init_mcp_registry_from_loader
                logger.info(f"🔄 [MCP REGISTRY] Syncing registry: loader has {loader_tool_count} tools, registry has {registry_tool_count}")
                init_mcp_registry_from_loader(mcp_loader)
                mcp_registry._initialized = True
                
                account_id = getattr(self.thread_manager, 'account_id', None)
                warmed = await mcp_registry.prewarm_schemas(account_id)
                if warmed > 0:
                    logger.info(f"⚡ [MCP REGISTRY] Pre-warmed {warmed} schemas from Redis cache")
        
        account_id = getattr(self.thread_manager, 'account_id', None)
        discovery_info = await mcp_registry.get_discovery_info(filter, load_schemas=True, account_id=account_id)
        
        logger.info(f"🔍 [MCP DISCOVERY] Found {discovery_info['total_count']} MCP tools across {len(discovery_info['toolkits'])} toolkits with full schemas")
        
        return self.success_response(discovery_info)

    async def _call_tool(self, tool_name: str, args: dict) -> ToolResult:
        from core.utils.logger import logger
        
        if not tool_name:
            return self.fail_response("tool_name required for call action")
        
        if args is None:
            args = {}
        
        if isinstance(args, str):
            try:
                import json
                args = json.loads(args)
                logger.info(f"🔧 [ARGS FIX] Converted string args to JSON object for {tool_name}")
            except json.JSONDecodeError:
                logger.warning(f"⚠️  [ARGS FIX] Failed to parse args string: {args}")
                args = {}
        
        native_tools = ['web_search', 'image_search', 'create_file', 'read_file', 'edit_file', 'create_slide', 'browser_navigate', 'shell_command', 'scrape_webpage']
        if tool_name in native_tools:
            return self.fail_response(f"Tool '{tool_name}' is a native tool. Use initialize_tools(['{tool_name}_tool']) first, then call {tool_name}() directly.")

        integration_labels = {
            'TWITTER_': 'Accessing Twitter',
            'GMAIL_': 'Accessing Gmail',  
            'SLACK_': 'Accessing Slack',
            'GITHUB_': 'Accessing GitHub',
            'GOOGLESHEETS_': 'Accessing Google Sheets',
            'LINEAR_': 'Accessing Linear',
            'NOTION_': 'Accessing Notion'
        }
        
        friendly_status = f'Executing {tool_name}'
        for prefix, label in integration_labels.items():
            if tool_name.startswith(prefix):
                friendly_status = label
                break
        
        logger.info(f"🔧 [MCP_ACTION] {friendly_status}")
        from core.agentpress.mcp_registry import get_mcp_registry, MCPExecutionContext
        
        mcp_registry = get_mcp_registry()
        mcp_loader = getattr(self.thread_manager, 'mcp_loader', None)
        if mcp_loader:
            # Always sync registry with current request's mcp_loader to avoid race conditions
            loader_tool_count = len(mcp_loader.tool_map) if mcp_loader.tool_map else 0
            registry_tool_count = len(mcp_registry._tools)
            
            if not mcp_registry._initialized or loader_tool_count > registry_tool_count:
                from core.agentpress.mcp_registry import init_mcp_registry_from_loader
                logger.info(f"🔄 [MCP REGISTRY] Syncing registry for execute: loader has {loader_tool_count} tools, registry has {registry_tool_count}")
                init_mcp_registry_from_loader(mcp_loader)
                mcp_registry._initialized = True
                
                account_id = getattr(self.thread_manager, 'account_id', None)
                await mcp_registry.prewarm_schemas(account_id)
        
        execution_context = MCPExecutionContext(self.thread_manager)
        
        return await mcp_registry.execute_tool(tool_name, args, execution_context)

if __name__ == "__main__":
    import asyncio

    async def test_expand_message_tool():
        expand_message_tool = ExpandMessageTool()

        expand_message_result = await expand_message_tool.expand_message(
            message_id="004ab969-ef9a-4656-8aba-e392345227cd"
        )
        print("Expand message result:", expand_message_result)

    asyncio.run(test_expand_message_tool())