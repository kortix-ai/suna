from core.agents.pipeline.context import PipelineContext
from core.utils.logger import logger


class ManagerInitializer:
    @staticmethod
    async def init_managers(ctx: PipelineContext):
        from core.agentpress.thread_manager import ThreadManager
        from core.jit.config import JITConfig
        from core.services.langfuse import langfuse

        # Get user tier for tool restrictions FIRST
        tier_name = 'free'
        tier_disabled_tools = []
        if ctx.account_id:
            try:
                from core.agents.pipeline.slot_manager import get_tier_limits
                from core.billing.shared.config import get_tier_disabled_tools
                tier_info = await get_tier_limits(ctx.account_id)
                tier_name = tier_info.get('name', 'free')
                tier_disabled_tools = get_tier_disabled_tools(tier_name)
                if tier_disabled_tools:
                    logger.info(f"🔒 [TIER] User tier '{tier_name}' - disabled tools: {tier_disabled_tools}")
            except Exception as e:
                logger.warning(f"Failed to get tier for tool restrictions: {e}")

        # Create JIT config with tier-disabled tools
        jit_config = JITConfig.from_run_context(
            agent_config=ctx.agent_config,
            disabled_tools=tier_disabled_tools
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
            ctx.agent_config,
            tier_disabled_tools=tier_disabled_tools
        )
        tool_manager.register_core_tools()

        await ManagerInitializer._reload_dynamic_tools(ctx, thread_manager, jit_config)

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

        return thread_manager, tool_registry, trace

    @staticmethod
    async def _reload_dynamic_tools(ctx: PipelineContext, thread_manager, jit_config):
        import asyncio
        from core.jit import JITLoader
        from core.jit.result_types import ActivationSuccess
        
        try:
            client = await thread_manager.db.client
            
            result = await client.table('threads')\
                .select('metadata')\
                .eq('thread_id', ctx.thread_id)\
                .single()\
                .execute()
            
            if not result.data:
                return
            
            metadata = result.data.get('metadata') or {}
            dynamic_tools = metadata.get('dynamic_tools', [])
            
            if not dynamic_tools:
                return
            
            logger.info(f"🔄 [RELOAD] Found {len(dynamic_tools)} previously activated tools: {dynamic_tools}")
            
            activation_tasks = [
                JITLoader.activate_tool(tool_name, thread_manager, ctx.project_id, jit_config=jit_config)
                for tool_name in dynamic_tools
            ]
            
            results = await asyncio.gather(*activation_tasks, return_exceptions=True)
            
            success_count = 0
            for tool_name, result in zip(dynamic_tools, results):
                if isinstance(result, ActivationSuccess):
                    success_count += 1
                elif isinstance(result, Exception):
                    logger.warning(f"⚠️ [RELOAD] Failed to reload '{tool_name}': {result}")
                else:
                    logger.warning(f"⚠️ [RELOAD] Failed to reload '{tool_name}': {result}")
            
            logger.info(f"✅ [RELOAD] Reloaded {success_count}/{len(dynamic_tools)} dynamic tools")
            
        except Exception as e:
            logger.warning(f"⚠️ [RELOAD] Failed to reload dynamic tools (non-fatal): {e}")

    @staticmethod
    async def load_prompt_and_tools(ctx: PipelineContext, state, tool_registry, thread_manager):
        from core.agents.pipeline import prep_tasks

        # Get disabled tools from jit_config (already fetched in init_managers)
        disabled_tools = []
        if hasattr(thread_manager, 'jit_config') and thread_manager.jit_config:
            disabled_tools = list(thread_manager.jit_config.disabled_tools)

        prompt = await prep_tasks.prep_prompt(
            model_name=ctx.model_name,
            agent_config=ctx.agent_config,
            thread_id=ctx.thread_id,
            account_id=ctx.account_id,
            tool_registry=tool_registry,
            mcp_loader=getattr(thread_manager, 'mcp_loader', None),
            client=await thread_manager.db.client if thread_manager else None,
            disabled_tools=disabled_tools
        )
        if prompt:
            state.system_prompt = prompt.system_prompt

        tools = await prep_tasks.prep_tools(tool_registry)
        if tools:
            state.tool_schemas = tools.schemas
