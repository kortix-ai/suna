from core.agents.pipeline.context import PipelineContext
from core.utils.logger import logger


class ManagerInitializer:
    @staticmethod
    async def init_managers(ctx: PipelineContext):
        from core.agentpress.thread_manager import ThreadManager
        from core.jit.config import JITConfig
        from core.services.langfuse import langfuse

        jit_config = JITConfig.from_run_context(
            agent_config=ctx.agent_config, 
            disabled_tools=[]
        )

        trace = langfuse.trace(
            name="stateless_run",
            id=ctx.agent_run_id,
            session_id=ctx.thread_id,
            metadata={"project_id": ctx.project_id}
        )

        thread_manager = ThreadManager(
            trace=trace,
            agent_config=ctx.agent_config,
            project_id=ctx.project_id,
            thread_id=ctx.thread_id,
            account_id=ctx.account_id,
            jit_config=jit_config
        )

        tool_registry = thread_manager.tool_registry

        from core.agents.runner.tool_manager import ToolManager
        tool_manager = ToolManager(
            thread_manager, 
            ctx.project_id, 
            ctx.thread_id, 
            ctx.agent_config
        )
        tool_manager.register_core_tools()

        if ctx.agent_config and (ctx.agent_config.get("custom_mcps") or ctx.agent_config.get("configured_mcps")):
            try:
                from core.agents.runner.mcp_manager import MCPManager
                mcp_manager = MCPManager(thread_manager, ctx.account_id)
                await mcp_manager.initialize_jit_loader(ctx.agent_config, cache_only=True)
                
                tool_count = 0
                if hasattr(thread_manager, 'mcp_loader') and thread_manager.mcp_loader:
                    tool_count = len(thread_manager.mcp_loader.tool_map) if hasattr(thread_manager.mcp_loader, 'tool_map') else 0
                logger.info(f"⚡ [STATELESS MCP] Initialized MCP loader with {tool_count} tools")
            except Exception as e:
                logger.warning(f"⚠️ [STATELESS MCP] MCP init failed (non-fatal): {e}")

        return thread_manager, tool_registry

    @staticmethod
    async def load_prompt_and_tools(ctx: PipelineContext, state, tool_registry, thread_manager):
        from core.agents.pipeline import prep_tasks
        
        prompt = await prep_tasks.prep_prompt(
            model_name=ctx.model_name,
            agent_config=ctx.agent_config,
            thread_id=ctx.thread_id,
            account_id=ctx.account_id,
            tool_registry=tool_registry,
            mcp_loader=getattr(thread_manager, 'mcp_loader', None),
            client=await thread_manager.db.client if thread_manager else None
        )
        if prompt:
            state.system_prompt = prompt.system_prompt

        tools = await prep_tasks.prep_tools(tool_registry)
        if tools:
            state.tool_schemas = tools.schemas
