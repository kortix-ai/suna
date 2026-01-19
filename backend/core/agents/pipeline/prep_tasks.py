import asyncio
import time
from typing import Dict, Any, List, Optional, Tuple

from core.utils.logger import logger
from core.utils.config import config, EnvMode

from core.agents.pipeline.context import (
    PipelineContext,
    BillingResult,
    LimitsResult,
    MessagesResult,
    PromptResult,
    ToolsResult,
    MCPResult,
)

async def prep_billing(account_id: str, wait_for_cache_ms: int = 3000) -> BillingResult:
    if config.ENV_MODE == EnvMode.LOCAL:
        return BillingResult(can_run=True, message="Local mode", balance=999999)
    
    start = time.time()
    
    try:
        from core.billing.credits.integration import billing_integration
        can_run, message, _ = await billing_integration.check_and_reserve_credits(
            account_id, wait_for_cache_ms=wait_for_cache_ms
        )
        
        elapsed_ms = (time.time() - start) * 1000
        logger.debug(f"⏱️ [PREP] Billing check: {elapsed_ms:.1f}ms")
        
        return BillingResult(
            can_run=can_run,
            message=message,
            error_code="INSUFFICIENT_CREDITS" if not can_run else None
        )
    except Exception as e:
        logger.error(f"Billing check failed: {e}")
        return BillingResult(
            can_run=False,
            message=f"Billing check failed: {str(e)[:100]}",
            error_code="BILLING_ERROR"
        )


async def prep_limits(account_id: str, skip_check: bool = False) -> LimitsResult:
    if skip_check or config.ENV_MODE == EnvMode.LOCAL:
        return LimitsResult(can_run=True, message="Limits check skipped")
    
    start = time.time()
    
    try:
        from core.cache.runtime_cache import get_cached_running_runs, get_cached_tier_info
        
        tier_info = await get_cached_tier_info(account_id)
        concurrent_limit = tier_info.get('concurrent_runs', 1) if tier_info else 1
        
        cached_runs = await get_cached_running_runs(account_id)
        if cached_runs is not None:
            running_count = len(cached_runs) if isinstance(cached_runs, list) else cached_runs
        else:
            from core.utils.limits_repo import count_running_agent_runs
            run_details = await count_running_agent_runs(account_id)
            running_count = run_details.get('count', 0)
        
        elapsed_ms = (time.time() - start) * 1000
        logger.debug(f"⏱️ [PREP] Limits check: {elapsed_ms:.1f}ms")
        
        if running_count >= concurrent_limit:
            return LimitsResult(
                can_run=False,
                message=f"Maximum of {concurrent_limit} concurrent runs. You have {running_count} running.",
                concurrent_runs=running_count,
                concurrent_limit=concurrent_limit,
                error_code="AGENT_RUN_LIMIT_EXCEEDED"
            )
        
        return LimitsResult(
            can_run=True,
            message="Within limits",
            concurrent_runs=running_count,
            concurrent_limit=concurrent_limit
        )
    except Exception as e:
        logger.error(f"Limits check failed: {e}")
        return LimitsResult(
            can_run=True,
            message=f"Limits check failed (allowing): {str(e)[:100]}"
        )


async def prep_messages(
    thread_id: str,
    prefetch_task: Optional[asyncio.Task] = None
) -> MessagesResult:
    start = time.time()
    from_cache = False
    
    try:
        if prefetch_task and not prefetch_task.done():
            try:
                messages = await asyncio.wait_for(prefetch_task, timeout=5.0)
                if messages is not None:
                    from_cache = True
            except (asyncio.TimeoutError, Exception):
                messages = None
        elif prefetch_task and prefetch_task.done():
            try:
                messages = prefetch_task.result()
                from_cache = True
            except Exception:
                messages = None
        else:
            messages = None
        
        if messages is None:
            from core.agentpress.thread_manager.services.messages.fetcher import MessageFetcher
            fetcher = MessageFetcher()
            messages = await fetcher.get_llm_messages(thread_id)
        
        elapsed_ms = (time.time() - start) * 1000
        logger.debug(f"⏱️ [PREP] Messages fetch: {elapsed_ms:.1f}ms ({len(messages)} messages, cache={from_cache})")
        
        return MessagesResult(
            messages=messages,
            count=len(messages),
            from_cache=from_cache,
            fetch_time_ms=elapsed_ms
        )
    except Exception as e:
        logger.error(f"Message fetch failed: {e}")
        return MessagesResult(
            messages=[],
            count=0,
            from_cache=False,
            fetch_time_ms=(time.time() - start) * 1000
        )


async def prep_prompt(
    model_name: str,
    agent_config: Optional[Dict[str, Any]],
    thread_id: str,
    account_id: str,
    tool_registry,
    mcp_loader=None,
    client=None
) -> PromptResult:
    start = time.time()
    
    try:
        from core.agents.runner.prompt_manager import PromptManager
        
        system_prompt, memory_context = await PromptManager.build_system_prompt(
            model_name=model_name,
            agent_config=agent_config,
            thread_id=thread_id,
            mcp_wrapper_instance=None,
            client=client,
            tool_registry=tool_registry,
            xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
            user_id=account_id,
            mcp_loader=mcp_loader
        )
        
        elapsed_ms = (time.time() - start) * 1000
        logger.debug(f"⏱️ [PREP] Prompt build: {elapsed_ms:.1f}ms")
        
        return PromptResult(
            system_prompt=system_prompt,
            memory_context=memory_context,
            build_time_ms=elapsed_ms
        )
    except Exception as e:
        logger.error(f"Prompt build failed: {e}", exc_info=True)
        raise


async def prep_tools(tool_registry) -> ToolsResult:
    start = time.time()
    
    try:
        schemas = await asyncio.to_thread(tool_registry.get_openapi_schemas)
        
        elapsed_ms = (time.time() - start) * 1000
        count = len(schemas) if schemas else 0
        logger.debug(f"⏱️ [PREP] Tool schemas: {elapsed_ms:.1f}ms ({count} tools)")
        
        return ToolsResult(
            schemas=schemas,
            count=count,
            fetch_time_ms=elapsed_ms
        )
    except Exception as e:
        logger.error(f"Tool schema fetch failed: {e}")
        return ToolsResult(schemas=None, count=0)


async def prep_mcp(
    agent_config: Optional[Dict[str, Any]],
    account_id: str,
    thread_manager
) -> MCPResult:
    if not agent_config:
        return MCPResult(initialized=False)
    
    start = time.time()
    
    try:
        from core.agents.runner.mcp_manager import MCPManager
        
        mcp_manager = MCPManager(thread_manager, account_id)
        await mcp_manager.initialize_jit_loader(agent_config, cache_only=True)
        
        tool_count = 0
        if hasattr(thread_manager, 'mcp_loader') and thread_manager.mcp_loader:
            tool_count = len(thread_manager.mcp_loader.tool_map) if hasattr(thread_manager.mcp_loader, 'tool_map') else 0
        
        elapsed_ms = (time.time() - start) * 1000
        logger.debug(f"⏱️ [PREP] MCP init: {elapsed_ms:.1f}ms ({tool_count} tools)")
        
        return MCPResult(
            initialized=True,
            tool_count=tool_count,
            init_time_ms=elapsed_ms
        )
    except Exception as e:
        logger.warning(f"MCP init failed (non-fatal): {e}")
        return MCPResult(initialized=False)


async def prep_llm_connection(model_name: str) -> bool:
    try:
        from core.services.llm import prewarm_llm_connection_background
        asyncio.create_task(prewarm_llm_connection_background(model_name))
        return True
    except Exception as e:
        logger.warning(f"LLM prewarm failed: {e}")
        return False


async def prep_project_metadata(project_id: str) -> bool:
    try:
        from core.agents.runner.services import ensure_project_metadata_cached
        await ensure_project_metadata_cached(project_id)
        return True
    except Exception as e:
        logger.warning(f"Project metadata cache failed: {e}")
        return False
