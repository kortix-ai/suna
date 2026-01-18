"""
Agent runs API endpoints.

Thin API layer - delegates to core modules:
- File handling: core/files/upload_handler.py
- Execution: core/run/agent_runner.py
"""

import asyncio
import json
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException, Depends, Request, File, UploadFile, Form
from fastapi.responses import StreamingResponse

from core.utils.auth_utils import (
    verify_and_get_user_id_from_jwt, 
    get_user_id_from_stream_auth, 
    verify_and_authorize_thread_access
)
from core.utils.logger import logger, structlog
from core.billing.credits.integration import billing_integration
from core.utils.config import config, EnvMode
from core.services import redis
from core.ai_models import model_manager
from core.api_models import UnifiedAgentStartResponse
from core.services.supabase import DBConnection

# Import from new modules
from core.agents.runner import execute_agent_run
from core.files import (
    handle_staged_files_for_thread,
    get_staged_files_for_thread,
)

db = DBConnection()
router = APIRouter(tags=["agent-runs"])

# Store cancellation events for stop mechanism (in-memory, per instance)
_cancellation_events: Dict[str, asyncio.Event] = {}


# ============================================================================
# Helper Functions
# ============================================================================

async def _get_agent_run_with_access_check(agent_run_id: str, user_id: str, require_write_access: bool = False):
    """Get agent run with access check."""
    from core.agents import repo as agents_repo
    
    agent_run_data = await agents_repo.get_agent_run_with_thread(agent_run_id)
    if not agent_run_data:
        raise HTTPException(status_code=404, detail="Worker run not found")

    thread_id = agent_run_data['thread_id']
    account_id = agent_run_data['thread_account_id']
    metadata = agent_run_data.get('metadata', {}) or {}
    actual_user_id = metadata.get('actual_user_id')
    
    if actual_user_id == user_id or account_id == user_id:
        return agent_run_data
    
    client = await db.client
    await verify_and_authorize_thread_access(client, thread_id, user_id, require_write_access=require_write_access)
    return agent_run_data


async def _check_billing_and_limits(
    client, 
    account_id: str, 
    model_name: Optional[str], 
    check_project_limit: bool = False, 
    check_thread_limit: bool = False
):
    import time
    from core.billing.subscriptions import subscription_service
    from core.utils.limits_repo import get_all_limits_counts
    from core.cache.runtime_cache import get_cached_tier_info
    
    t_start = time.time()
    
    # Skip all checks in local mode
    if config.ENV_MODE == EnvMode.LOCAL:
        return
    
    # Step 1: Get tier info ONCE (with caching)
    # Note: subscription_service.get_user_subscription_tier already handles caching internally
    tier_info = await get_cached_tier_info(account_id)
    if not tier_info:
        tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=False)
        # No need to call set_cached_tier_info here - it's already done inside get_user_subscription_tier
    
    tier_name = tier_info.get('name', 'free')
    
    # Step 2: Run billing check and limits check in parallel
    async def check_billing():
        if model_name == "mock-ai":
            return (True, None, {})
        
        # Check model access
        from core.billing.shared.config import is_model_allowed
        if not is_model_allowed(tier_name, model_name):
            available_models = tier_info.get('models', [])
            return False, f"Your current subscription plan does not include access to {model_name}. Please upgrade your subscription.", {
                "allowed_models": available_models,
                "tier_info": tier_info,
                "tier_name": tier_name,
                "error_type": "model_access_denied",
                "error_code": "MODEL_ACCESS_DENIED"
            }
        
        # Check credits
        can_run, message, reservation_id = await billing_integration.check_and_reserve_credits(account_id)
        if not can_run:
            return False, f"Billing check failed: {message}", {
                "tier_info": tier_info,
                "error_type": "insufficient_credits"
            }
        
        return True, "Access granted", {"tier_info": tier_info, "reservation_id": reservation_id}
    
    async def check_all_limits():
        """Get all limits in a single DB query."""
        # Use the optimized single-query function
        counts = await get_all_limits_counts(account_id)
        
        # Get tier limits
        concurrent_limit = tier_info.get('concurrent_runs', 1)
        project_limit = tier_info.get('project_limit', 3)
        thread_limit = tier_info.get('thread_limit', 10)
        
        return {
            'agent_runs': {
                'can_start': counts['running_runs_count'] < concurrent_limit,
                'running_count': counts['running_runs_count'],
                'limit': concurrent_limit,
            },
            'projects': {
                'can_create': counts['project_count'] < project_limit,
                'current_count': counts['project_count'],
                'limit': project_limit,
            },
            'threads': {
                'can_create': counts['thread_count'] < thread_limit,
                'current_count': counts['thread_count'],
                'limit': thread_limit,
            }
        }
    
    # Run both in parallel
    billing_result, limits_result = await asyncio.gather(
        check_billing(), check_all_limits()
    )
    
    logger.debug(f"⚡ Billing + limits check completed in {(time.time() - t_start) * 1000:.1f}ms")
    
    # Process billing result
    can_proceed, error_message, context = billing_result
    if not can_proceed:
        error_type = context.get("error_type")
        if error_type == "model_access_denied":
            raise HTTPException(status_code=402, detail={
                "message": error_message, 
                "tier_name": context.get("tier_name"),
                "error_code": "MODEL_ACCESS_DENIED"
            })
        elif error_type == "insufficient_credits":
            raise HTTPException(status_code=402, detail={
                "message": error_message,
                "error_code": "INSUFFICIENT_CREDITS"
            })
        else:
            raise HTTPException(status_code=500, detail={"message": error_message})
    
    # Check agent run limit
    agent_run_result = limits_result['agent_runs']
    if not agent_run_result.get('can_start', True):
        # Need to fetch running thread IDs for the error response
        from core.utils.limits_repo import count_running_agent_runs
        run_details = await count_running_agent_runs(account_id)
        running_ids = [str(tid) for tid in run_details.get('running_thread_ids', [])]
        raise HTTPException(status_code=402, detail={
            "message": f"Maximum of {agent_run_result['limit']} concurrent runs. You have {agent_run_result['running_count']} running.",
            "running_thread_ids": running_ids,
            "running_count": agent_run_result['running_count'],
            "limit": agent_run_result['limit'],
            "error_code": "AGENT_RUN_LIMIT_EXCEEDED"
        })

    # Check project limit
    project_result = limits_result['projects']
    if check_project_limit and not project_result.get('can_create', True):
        raise HTTPException(status_code=402, detail={
            "message": f"Maximum of {project_result['limit']} projects allowed.",
            "current_count": project_result['current_count'],
            "limit": project_result['limit'],
            "error_code": "PROJECT_LIMIT_EXCEEDED"
        })
    
    # Check thread limit
    thread_result = limits_result['threads']
    if check_thread_limit and not thread_result.get('can_create', True):
        raise HTTPException(status_code=402, detail={
            "message": f"Maximum of {thread_result['limit']} threads allowed.",
            "current_count": thread_result['current_count'],
            "limit": thread_result['limit'],
            "error_code": "THREAD_LIMIT_EXCEEDED"
        })


async def _check_concurrent_runs_limit(account_id: str):
    from core.cache.runtime_cache import get_cached_running_runs, get_cached_tier_info
    from core.billing.subscriptions import subscription_service
    
    tier_info = await get_cached_tier_info(account_id)
    if not tier_info:
        concurrent_limit = 1
    else:
        concurrent_limit = tier_info.get('concurrent_runs', 1)
    
    cached_runs = await get_cached_running_runs(account_id)
    if cached_runs is not None:
        running_count = len(cached_runs) if isinstance(cached_runs, list) else cached_runs
        if running_count >= concurrent_limit:
            from core.utils.limits_repo import count_running_agent_runs
            run_details = await count_running_agent_runs(account_id)
            running_ids = [str(tid) for tid in run_details.get('running_thread_ids', [])]
            raise HTTPException(status_code=402, detail={
                "message": f"Maximum of {concurrent_limit} concurrent runs. You have {running_count} running.",
                "running_thread_ids": running_ids,
                "running_count": running_count,
                "limit": concurrent_limit,
                "error_code": "AGENT_RUN_LIMIT_EXCEEDED"
            })
        return
    
    from core.utils.limits_repo import count_running_agent_runs
    run_details = await count_running_agent_runs(account_id)
    running_count = run_details.get('count', 0)
    
    if running_count >= concurrent_limit:
        running_ids = [str(tid) for tid in run_details.get('running_thread_ids', [])]
        raise HTTPException(status_code=402, detail={
            "message": f"Maximum of {concurrent_limit} concurrent runs. You have {running_count} running.",
            "running_thread_ids": running_ids,
            "running_count": running_count,
            "limit": concurrent_limit,
            "error_code": "AGENT_RUN_LIMIT_EXCEEDED"
        })


async def _get_effective_model(model_name: Optional[str], agent_config: Optional[dict], client, account_id: str) -> str:
    if model_name:
        return model_name
    elif agent_config and agent_config.get('model'):
        return agent_config['model']
    else:
        return await model_manager.get_default_model_for_user(client, account_id)


async def _create_agent_run_record(
    thread_id: str, 
    agent_config: Optional[dict], 
    effective_model: str, 
    actual_user_id: str,
    extra_metadata: Optional[Dict[str, Any]] = None
) -> str:
    """Create agent run record in database."""
    from core.agents import repo as agents_repo
    from core.utils.instance import get_instance_id
    
    # Include instance_id for multi-instance awareness
    run_metadata = {
        "model_name": effective_model, 
        "actual_user_id": actual_user_id,
        "instance_id": get_instance_id()
    }
    if extra_metadata:
        run_metadata.update(extra_metadata)
    
    agent_run = await agents_repo.create_agent_run(
        thread_id=thread_id,
        agent_id=agent_config.get('agent_id') if agent_config else None,
        agent_version_id=agent_config.get('current_version_id') if agent_config else None,
        metadata=run_metadata
    )

    agent_run_id = agent_run['id']
    structlog.contextvars.bind_contextvars(agent_run_id=agent_run_id)

    # Invalidate caches
    try:
        from core.cache.runtime_cache import invalidate_running_runs_cache
        await invalidate_running_runs_cache(actual_user_id)
    except Exception:
        pass
    
    try:
        from core.billing.shared.cache_utils import invalidate_account_state_cache
        await invalidate_account_state_cache(actual_user_id)
    except Exception:
        pass

    return agent_run_id


async def start_agent_run(
    account_id: str,
    prompt: str,
    agent_id: Optional[str] = None,
    model_name: Optional[str] = None,
    thread_id: Optional[str] = None,
    project_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    skip_limits_check: bool = False,
    staged_files: Optional[List[Dict[str, Any]]] = None,
    memory_enabled: Optional[bool] = None,
    is_optimistic: bool = False,
    emit_timing: bool = False,
    mode: Optional[str] = None,
) -> Dict[str, Any]:
    from core.agents.config import load_agent_config_fast
    from core.agents.pipeline.slot_manager import (
        reserve_slot,
        check_thread_limit,
        check_project_limit,
    )
    from core.agents.pipeline.time_estimator import time_estimator
    from core.agents.pipeline.ux_streaming import stream_ack, stream_estimate
    
    total_start = time.time()
    is_new_thread = thread_id is None or is_optimistic
    
    logger.info(f"🚀 start_agent_run: is_optimistic={is_optimistic}, is_new_thread={is_new_thread}")
    
    agent_config = await load_agent_config_fast(agent_id, account_id, user_id=account_id)
    
    if model_name:
        effective_model = model_name
    elif agent_config and agent_config.get('model'):
        effective_model = agent_config['model']
    else:
        effective_model = "anthropic/claude-sonnet-4-20250514"
    
    if not is_new_thread and not project_id:
        from core.threads import repo as threads_repo
        project_id = await threads_repo.get_thread_project_id(thread_id)
    
    if is_new_thread and not skip_limits_check:
        thread_check, project_check = await asyncio.gather(
            check_thread_limit(account_id, skip=skip_limits_check),
            check_project_limit(account_id, skip=skip_limits_check),
        )
        
        if not thread_check.allowed:
            logger.warning(f"⚠️ Thread limit exceeded for {account_id}: {thread_check.current_count}/{thread_check.limit}")
            raise HTTPException(
                status_code=402,
                detail={
                    "message": thread_check.message,
                    "current_count": thread_check.current_count,
                    "limit": thread_check.limit,
                    "error_code": thread_check.error_code or "THREAD_LIMIT_EXCEEDED"
                }
            )
        
        if not project_check.allowed:
            logger.warning(f"⚠️ Project limit exceeded for {account_id}: {project_check.current_count}/{project_check.limit}")
            raise HTTPException(
                status_code=402,
                detail={
                    "message": project_check.message,
                    "current_count": project_check.current_count,
                    "limit": project_check.limit,
                    "error_code": project_check.error_code or "PROJECT_LIMIT_EXCEEDED"
                }
            )
    
    if is_new_thread:
        if not project_id:
            project_id = str(uuid.uuid4())
        if not thread_id:
            thread_id = str(uuid.uuid4())
    
    agent_run_id = str(uuid.uuid4())
    
    slot_reservation = await reserve_slot(
        account_id=account_id,
        agent_run_id=agent_run_id,
        skip=skip_limits_check
    )
    
    if not slot_reservation.acquired:
        logger.warning(f"⚠️ Slot rejected for {agent_run_id}: {slot_reservation.message}")
        raise HTTPException(
            status_code=402,
            detail={
                "message": slot_reservation.message,
                "running_count": slot_reservation.slot_count,
                "limit": slot_reservation.limit,
                "error_code": slot_reservation.error_code or "AGENT_RUN_LIMIT_EXCEEDED"
            }
        )
    
    cancellation_event = asyncio.Event()
    _cancellation_events[agent_run_id] = cancellation_event
    
    stream_key = f"agent_run:{agent_run_id}:stream"
    
    asyncio.create_task(stream_ack(stream_key, agent_run_id))
    
    has_mcp = bool(agent_config and agent_config.get('mcp_servers'))
    estimate = time_estimator.estimate(
        model_name=effective_model,
        has_mcp=has_mcp,
        is_continuation=False
    )
    asyncio.create_task(stream_estimate(
        stream_key,
        estimate.estimated_seconds,
        estimate.confidence,
        estimate.breakdown.to_dict()
    ))

    if is_new_thread:
        from core.cache.runtime_cache import set_pending_thread, set_agent_run_stream_data
        await set_pending_thread(
            thread_id=thread_id,
            project_id=project_id,
            account_id=account_id,
            agent_run_id=agent_run_id,
            prompt=prompt
        )
        await set_agent_run_stream_data(
            agent_run_id=agent_run_id,
            thread_id=thread_id,
            account_id=account_id,
            status="running",
            metadata=metadata
        )
    else:
        from core.cache.runtime_cache import set_agent_run_stream_data
        await set_agent_run_stream_data(
            agent_run_id=agent_run_id,
            thread_id=thread_id,
            account_id=account_id,
            status="running",
            metadata=metadata
        )

    setup_time_ms = round((time.time() - total_start) * 1000, 1)
    logger.info(f"⚡ [FAST RESPONSE] Returning in {setup_time_ms}ms (thread={thread_id}, run={agent_run_id})")
    
    asyncio.create_task(_background_setup_and_execute(
        account_id=account_id,
        prompt=prompt,
        thread_id=thread_id,
        project_id=project_id,
        agent_run_id=agent_run_id,
        agent_config=agent_config,
        effective_model=effective_model,
        metadata=metadata,
        staged_files=staged_files,
        memory_enabled=memory_enabled,
        is_new_thread=is_new_thread,
        mode=mode,
        cancellation_event=cancellation_event,
        skip_limits_check=skip_limits_check,
    ))
    
    return {
        "thread_id": thread_id,
        "agent_run_id": agent_run_id,
        "project_id": project_id,
        "status": "running",
        "timing_breakdown": {"setup_ms": setup_time_ms} if emit_timing else None,
    }


async def _background_setup_and_execute(
    account_id: str,
    prompt: str,
    thread_id: str,
    project_id: str,
    agent_run_id: str,
    agent_config: dict,
    effective_model: str,
    metadata: Optional[Dict[str, Any]],
    staged_files: Optional[List[Dict[str, Any]]],
    memory_enabled: Optional[bool],
    is_new_thread: bool,
    mode: Optional[str],
    cancellation_event: asyncio.Event,
    skip_limits_check: bool = False,
):
    from core.utils.lifecycle_tracker import log_run_start, log_run_cleanup
    from core.agents.runner.setup_manager import (
        prepopulate_caches_for_new_thread,
        append_user_message_to_cache,
        write_user_message_for_existing_thread,
        prewarm_user_context,
        create_new_thread_records,
        create_agent_run_record,
        create_image_messages,
        notify_setup_error,
    )
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id, 
        thread_id=thread_id, 
        project_id=project_id,
        account_id=account_id
    )
    
    try:
        final_message_content = prompt
        image_contexts_to_inject = []
        
        if is_new_thread and staged_files:
            from core.threads import repo as threads_repo
            placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
            logger.debug(f"⚡ [BG] Creating project row first (before sandbox claim)")
            try:
                await threads_repo.create_project(project_id, account_id, placeholder_name)
            except Exception as e:
                logger.debug(f"Project creation skipped (may already exist): {e}")
        
        if staged_files:
            final_message_content, image_contexts_to_inject = await handle_staged_files_for_thread(
                staged_files=staged_files,
                thread_id=thread_id,
                project_id=project_id,
                prompt=prompt,
                account_id=account_id
            )
        
        if is_new_thread:
            await prepopulate_caches_for_new_thread(
                thread_id=thread_id,
                project_id=project_id,
                message_content=final_message_content,
                image_contexts=image_contexts_to_inject,
                mode=mode,
            )
            cache_updated = False
        else:
            cache_updated = await append_user_message_to_cache(thread_id, final_message_content)
            if not cache_updated:
                logger.debug(f"⚠️ Cache miss for thread {thread_id}, writing message to DB first")
                await write_user_message_for_existing_thread(thread_id, final_message_content)
        
        logger.debug(f"⚡ [BG] Caches ready, starting agent + DB writes in parallel")
        
        asyncio.create_task(prewarm_user_context(account_id))
        
        from core.agents.runner.setup_manager import prewarm_credit_balance
        credit_prewarm_task = asyncio.create_task(prewarm_credit_balance(account_id))
        
        async def do_db_writes():
            db_start = time.time()
            try:
                if is_new_thread:
                    await create_new_thread_records(
                        project_id=project_id,
                        thread_id=thread_id,
                        account_id=account_id,
                        prompt=prompt,
                        agent_run_id=agent_run_id,
                        message_content=final_message_content,
                        agent_config=agent_config,
                        metadata=metadata,
                        memory_enabled=memory_enabled,
                    )
                    from core.agents.pipeline.slot_manager import (
                        increment_thread_count,
                        increment_project_count,
                    )
                    await asyncio.gather(
                        increment_thread_count(account_id),
                        increment_project_count(account_id),
                    )
                else:
                    if cache_updated:
                        await write_user_message_for_existing_thread(thread_id, final_message_content)
                    await create_agent_run_record(
                        agent_run_id=agent_run_id,
                        thread_id=thread_id,
                        agent_config=agent_config,
                        effective_model=effective_model,
                        account_id=account_id,
                        extra_metadata=metadata,
                    )
                
                await create_image_messages(thread_id, image_contexts_to_inject)
                logger.debug(f"⏱️ [BG] DB writes completed: {(time.time() - db_start)*1000:.1f}ms")
            except Exception as e:
                logger.error(f"❌ [BG] DB write failed: {e}")
        
        log_run_start(agent_run_id, thread_id)
        
        db_task = asyncio.create_task(do_db_writes())
        logger.info(f"✅ [BG] Starting agent execution")
        
        cleanup_reason = None
        final_status = "unknown"
        cleanup_errors = []
        
        try:
            await execute_agent_run(
                agent_run_id=agent_run_id,
                thread_id=thread_id,
                project_id=project_id,
                model_name=effective_model,
                agent_config=agent_config,
                account_id=account_id,
                cancellation_event=cancellation_event,
                is_new_thread=is_new_thread,
                user_message=final_message_content
            )
            final_status = "completed"
        except asyncio.CancelledError:
            final_status = "cancelled"
            cleanup_reason = "Task cancelled"
        except Exception as e:
            final_status = "failed"
            cleanup_reason = f"{type(e).__name__}: {str(e)[:100]}"
            logger.error(f"[LIFECYCLE] EXCEPTION agent_run={agent_run_id} error={cleanup_reason}")
        finally:
            # CRITICAL: Release the slot we reserved at the start
            try:
                from core.agents.pipeline.slot_manager import release_slot
                await release_slot(account_id, agent_run_id)
            except Exception as slot_err:
                logger.error(f"[SLOT] Failed to release slot for {agent_run_id}: {slot_err}")
                cleanup_errors.append(f"slot_release: {slot_err}")
            
            try:
                await asyncio.wait_for(db_task, timeout=30.0)
            except asyncio.TimeoutError:
                logger.warning(f"⚠️ [BG] DB writes timed out after 30s")
            except Exception as e:
                logger.warning(f"⚠️ [BG] DB writes failed: {e}")
            
            was_in_events = _cancellation_events.pop(agent_run_id, None) is not None
            if not was_in_events:
                cleanup_errors.append("not_in_cancellation_events")
            
            log_run_cleanup(
                agent_run_id, 
                success=(cleanup_reason is None),
                reason=cleanup_reason,
                final_status=final_status,
                cleanup_errors=cleanup_errors if cleanup_errors else None
            )
    
    except Exception as e:
        logger.error(f"❌ [BG] Setup failed for agent_run={agent_run_id}: {e}")
        # Release slot on setup failure too
        try:
            from core.agents.pipeline.slot_manager import release_slot
            await release_slot(account_id, agent_run_id)
        except Exception:
            pass
        _cancellation_events.pop(agent_run_id, None)
        await notify_setup_error(agent_run_id, e)


@router.post("/agent/start", response_model=UnifiedAgentStartResponse, summary="Start Agent", operation_id="unified_agent_start")
async def unified_agent_start(
    request: Request,
    thread_id: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    model_name: Optional[str] = Form(None),
    agent_id: Optional[str] = Form(None),
    file_ids: List[str] = Form(default=[]),
    optimistic: Optional[str] = Form(None),
    memory_enabled: Optional[str] = Form(None),
    mode: Optional[str] = Form(None),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    client = await db.client
    account_id = user_id
    is_optimistic = optimistic and optimistic.lower() == 'true'
    
    staged_files_data = None
    if file_ids:
        target_id = thread_id or project_id or str(uuid.uuid4())
        staged_files_data = await get_staged_files_for_thread(file_ids, user_id, target_id)
    
    if is_optimistic:
        if not thread_id or not project_id:
            raise HTTPException(status_code=400, detail="thread_id and project_id required for optimistic mode")
        if (not prompt or not prompt.strip()) and not file_ids:
            raise HTTPException(status_code=400, detail="prompt or file_ids required for optimistic mode")
        try:
            uuid.UUID(thread_id)
            uuid.UUID(project_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid UUID format")
    
    if not is_optimistic and not thread_id and (not prompt or not prompt.strip()) and not file_ids:
        raise HTTPException(status_code=400, detail="prompt or file_ids required when creating new thread")
    
    if model_name is None:
        model_name = await model_manager.get_default_model_for_user(client, account_id)
    elif model_name != "mock-ai":
        model_name = model_manager.resolve_model_id(model_name)
    
    memory_enabled_bool = memory_enabled.lower() == 'true' if memory_enabled else None
    
    skip_limits = False
    emit_timing = False
    if request.headers.get("X-Skip-Limits", "").lower() == "true":
        from core.endpoints.user_roles_repo import get_user_admin_role
        role_info = await get_user_admin_role(user_id)
        if role_info.get('role') == 'super_admin':
            skip_limits = True
            emit_timing = request.headers.get("X-Emit-Timing", "").lower() == "true"
    
    try:
        if thread_id and not is_optimistic:
            from core.threads import repo as threads_repo
            thread_data = await threads_repo.get_thread_with_project(thread_id)
            if not thread_data:
                raise HTTPException(status_code=404, detail="Thread not found")
            project_id = thread_data['project_id']
            if thread_data['account_id'] != user_id:
                await verify_and_authorize_thread_access(client, thread_id, user_id, require_write_access=True)
        
        result = await start_agent_run(
            account_id=account_id,
            prompt=prompt or "",
            agent_id=agent_id,
            model_name=model_name,
            thread_id=thread_id,
            project_id=project_id,
            staged_files=staged_files_data,
            memory_enabled=memory_enabled_bool,
            is_optimistic=is_optimistic,
            skip_limits_check=skip_limits,
            emit_timing=emit_timing,
            mode=mode,
        )
        
        response = {
            "thread_id": result["thread_id"],
            "agent_run_id": result["agent_run_id"],
            "project_id": result.get("project_id"),
            "status": result.get("status", "running")
        }
        if emit_timing and result.get("timing_breakdown"):
            response["timing_breakdown"] = result["timing_breakdown"]
        return response
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in agent start: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to start agent: {str(e)}")


@router.post("/agent-run/{agent_run_id}/stop", summary="Stop Agent Run", operation_id="stop_agent_run")
async def stop_agent(agent_run_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Stop an agent run."""
    from core.utils.run_management import stop_agent_run_with_helpers as stop_agent_run
    
    structlog.contextvars.bind_contextvars(agent_run_id=agent_run_id)
    await _get_agent_run_with_access_check(agent_run_id, user_id, require_write_access=True)
    await stop_agent_run(agent_run_id)
    return {"status": "stopped"}


@router.get("/agent-runs/{agent_run_id}/status", summary="Get Agent Run Status", operation_id="get_agent_run_status")
async def get_agent_run_status(agent_run_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Get agent run status."""
    agent_run_data = await _get_agent_run_with_access_check(agent_run_id, user_id)
    return {"status": agent_run_data['status'], "error": agent_run_data.get('error')}


@router.get("/agent-runs/active", summary="List Active Agent Runs", operation_id="list_active_agent_runs")
async def get_active_agent_runs(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """List all active agent runs for user."""
    from core.agents.repo import get_active_agent_runs as repo_get_active_runs
    
    try:
        active_runs = await repo_get_active_runs(user_id)
        return {"active_runs": active_runs}
    except Exception as e:
        logger.error(f"Error fetching active runs: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch active runs: {str(e)}")


@router.get("/thread/{thread_id}/agent-runs", summary="List Thread Agent Runs", operation_id="list_thread_agent_runs")
async def get_agent_runs(thread_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    from core.agents.repo import get_thread_agent_runs as repo_get_thread_runs
    from core.cache.runtime_cache import get_pending_thread
    from core.threads import repo as threads_repo
    
    thread = await threads_repo.get_thread_by_id(thread_id)
    
    if not thread:
        pending = await get_pending_thread(thread_id)
        if pending:
            logger.debug(f"Thread {thread_id} is pending, returning pending agent run")
            return {
                "agent_runs": [{
                    "id": pending.get('agent_run_id'),
                    "status": "running",
                    "started_at": pending.get('created_at'),
                    "completed_at": None
                }] if pending.get('agent_run_id') else [],
                "_pending": True
            }
        raise HTTPException(status_code=404, detail="Thread not found")
    
    client = await db.client
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    agent_runs = await repo_get_thread_runs(thread_id)
    return {"agent_runs": agent_runs}


@router.get("/agent-run/{agent_run_id}", summary="Get Agent Run", operation_id="get_agent_run")
async def get_agent_run(agent_run_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    from core.agents.repo import get_agent_run_by_id as repo_get_run
    
    agent_run_data = await repo_get_run(agent_run_id)
    if not agent_run_data:
        raise HTTPException(status_code=404, detail="Agent run not found")
    
    # Auth check
    thread_account_id = agent_run_data.get('thread_account_id')
    metadata = agent_run_data.get('metadata', {}) or {}
    actual_user_id = metadata.get('actual_user_id')
    
    if not (actual_user_id == user_id or thread_account_id == user_id):
        client = await db.client
        await verify_and_authorize_thread_access(client, agent_run_data['thread_id'], user_id)
    
    return {
        "id": agent_run_data['id'],
        "threadId": agent_run_data['thread_id'],
        "status": agent_run_data['status'],
        "startedAt": agent_run_data.get('started_at'),
        "completedAt": agent_run_data.get('completed_at'),
        "error": agent_run_data.get('error')
    }


@router.get("/agent-run/{agent_run_id}/stream", summary="Stream Agent Run", operation_id="stream_agent_run")
async def stream_agent_run(
    agent_run_id: str,
    token: Optional[str] = None,
    last_id: Optional[str] = None,
    request: Request = None
):
    from core.agents import repo as agents_repo
    from core.cache.runtime_cache import get_agent_run_stream_data
    
    user_id = await get_user_id_from_stream_auth(request, token)
    stream_key = f"agent_run:{agent_run_id}:stream"
    
    agent_run_data = await get_agent_run_stream_data(agent_run_id)
    
    if not agent_run_data:
        agent_run_data = await agents_repo.get_agent_run_with_thread(agent_run_id)
    
    if not agent_run_data:
        for attempt in range(15):
            await asyncio.sleep(0.2)
            agent_run_data = await get_agent_run_stream_data(agent_run_id)
            if agent_run_data:
                break

            agent_run_data = await agents_repo.get_agent_run_with_thread(agent_run_id)
            if agent_run_data:
                break
            if attempt >= 5:
                try:
                    stream_len = await redis.stream_len(stream_key)
                    if stream_len > 0:
                        continue
                except Exception:
                    pass
        
        if not agent_run_data:
            raise HTTPException(status_code=404, detail="Worker run not found")
    
    thread_id = agent_run_data['thread_id']
    account_id = agent_run_data['thread_account_id']
    
    if user_id != account_id:
        metadata = agent_run_data.get('metadata', {}) or {}
        shared_users = metadata.get('shared_users', [])
        if user_id not in shared_users:
            raise HTTPException(status_code=403, detail="Access denied")

    def compare_stream_ids(id1: str, id2: str) -> int:
        try:
            t1, s1 = id1.split('-')
            t2, s2 = id2.split('-')
            if int(t1) != int(t2):
                return -1 if int(t1) < int(t2) else 1
            return -1 if int(s1) < int(s2) else (0 if int(s1) == int(s2) else 1)
        except Exception:
            return -1 if id1 < id2 else (0 if id1 == id2 else 1)

    def find_last_safe_boundary(entries):
        last_safe = -1
        open_responses = 0

        for i, (_, fields) in enumerate(entries):
            try:
                data = json.loads(fields.get('data', '{}'))
                msg_type = data.get('type')

                if msg_type == 'llm_response_start':
                    open_responses += 1
                elif msg_type == 'llm_response_end':
                    open_responses = max(0, open_responses - 1)
                    if open_responses == 0:
                        last_safe = i
                elif msg_type == 'status' and data.get('status') in ['completed', 'failed', 'stopped', 'error']:
                    last_safe = i
            except Exception:
                continue

        if open_responses > 0:
            return -1
        return last_safe

    async def stream_generator(agent_run_data, client_last_id: Optional[str] = None):
        terminate = False
        last_id = client_last_id if client_last_id and client_last_id != "0" else "0"
        skip_catchup = client_last_id and client_last_id != "0"

        try:
            entries = []
            if not skip_catchup:
                entries = await redis.stream_range(stream_key) or []
                if entries:
                    for entry_id, fields in entries:
                        response = json.loads(fields.get('data', '{}'))
                        response['_event_id'] = entry_id
                        yield f"data: {json.dumps(response)}\n\n"
                        last_id = entry_id
                        if response.get('type') == 'status' and response.get('status') in ['completed', 'failed', 'stopped', 'error']:
                            return
                    
                    if last_id != "0":
                        try:
                            safe_idx = find_last_safe_boundary(entries)
                            if safe_idx >= 0:
                                safe_id = entries[safe_idx][0]
                                if '-' in safe_id:
                                    parts = safe_id.split('-')
                                    if len(parts) == 2:
                                        next_id = f"{parts[0]}-{int(parts[1]) + 1}"
                                        await redis.xtrim_minid(stream_key, next_id, approximate=True)
                        except Exception as e:
                            logger.warning(f"Error in stream catch-up: {e}")

            if agent_run_data.get('status') != 'running':
                yield f"data: {json.dumps({'type': 'status', 'status': 'completed'})}\n\n"
                return

            timeout_count = 0
            ping_count = 0
            received_data = bool(entries) if not skip_catchup else False
            MAX_PINGS_WITHOUT_DATA = 4

            try:
                async with redis.redis.hub.subscription(stream_key, last_id) as queue:
                    async for msg in redis.redis.hub.iter_queue(queue, timeout=0.5):
                        if terminate:
                            break

                        if msg is not None:
                            entry_id, fields = msg
                            # Dedupe: skip if we already saw this in catch-up
                            if compare_stream_ids(entry_id, last_id) <= 0:
                                continue
                            received_data = True
                            timeout_count = 0
                            ping_count = 0
                            data = fields.get('data', '{}')
                            # Include event ID in response for client tracking
                            try:
                                response = json.loads(data)
                                response['_event_id'] = entry_id
                                yield f"data: {json.dumps(response)}\n\n"
                                if response.get('type') == 'status' and response.get('status') in ['completed', 'failed', 'stopped', 'error']:
                                    return
                            except Exception:
                                yield f"data: {data}\n\n"
                            last_id = entry_id
                        else:
                            # Timeout (0.5s) - send ping every ~5 seconds
                            timeout_count += 1
                            if timeout_count >= 10:
                                timeout_count = 0
                                ping_count += 1

                                # Check for dead worker if no data received
                                if not received_data and ping_count >= MAX_PINGS_WITHOUT_DATA:
                                    from core.agents import repo as agents_repo
                                    run_check = await agents_repo.get_agent_run_status(agent_run_id)
                                    status = run_check.get('status') if run_check else None
                                    if status == 'running':
                                        await agents_repo.update_agent_run_status(agent_run_id, 'failed', error='Worker timeout')
                                        yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': 'Worker timeout'})}\n\n"
                                        return
                                    elif status in ['completed', 'failed', 'stopped']:
                                        yield f"data: {json.dumps({'type': 'status', 'status': status})}\n\n"
                                        return

                                yield f"data: {json.dumps({'type': 'ping'})}\n\n"

            except asyncio.CancelledError:
                pass
            except Exception as e:
                yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': str(e)})}\n\n"

        except Exception as e:
            logger.error(f"Stream error for {agent_run_id}: {e}", exc_info=True)
            yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        stream_generator(agent_run_data, last_id), 
        media_type="text/event-stream", 
        headers={
            "Cache-Control": "no-cache, no-transform", 
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no", 
            "Content-Type": "text/event-stream",
            "Access-Control-Allow-Origin": "*"
        }
    )
