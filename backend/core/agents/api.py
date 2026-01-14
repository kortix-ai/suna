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
    """Check billing and limits in parallel."""
    from core.utils.limits_checker import (
        check_agent_run_limit, 
        check_project_count_limit,
        check_thread_limit as _check_thread_limit
    )
    
    async def check_billing():
        if model_name == "mock-ai":
            return (True, None, {})
        return await billing_integration.check_model_and_billing_access(account_id, model_name, client)
    
    async def check_agent_runs():
        if config.ENV_MODE == EnvMode.LOCAL:
            return {'can_start': True}
        return await check_agent_run_limit(account_id)
    
    async def check_projects():
        if config.ENV_MODE == EnvMode.LOCAL or not check_project_limit:
            return {'can_create': True}
        return await check_project_count_limit(account_id)
    
    async def check_threads():
        if config.ENV_MODE == EnvMode.LOCAL or not check_thread_limit:
            return {'can_create': True}
        return await _check_thread_limit(account_id)
    
    billing_result, agent_run_result, project_result, thread_result = await asyncio.gather(
        check_billing(), check_agent_runs(), check_projects(), check_threads()
    )
    
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
    if not agent_run_result.get('can_start', True):
        running_ids = [str(tid) for tid in agent_run_result.get('running_thread_ids', [])]
        raise HTTPException(status_code=402, detail={
            "message": f"Maximum of {agent_run_result['limit']} concurrent runs. You have {agent_run_result['running_count']} running.",
            "running_thread_ids": running_ids,
            "running_count": agent_run_result['running_count'],
            "limit": agent_run_result['limit'],
            "error_code": "AGENT_RUN_LIMIT_EXCEEDED"
        })

    # Check project limit
    if check_project_limit and not project_result.get('can_create', True):
        raise HTTPException(status_code=402, detail={
            "message": f"Maximum of {project_result['limit']} projects allowed.",
            "current_count": project_result['current_count'],
            "limit": project_result['limit'],
            "error_code": "PROJECT_LIMIT_EXCEEDED"
        })
    
    # Check thread limit
    if check_thread_limit and not thread_result.get('can_create', True):
        raise HTTPException(status_code=402, detail={
            "message": f"Maximum of {thread_result['limit']} threads allowed.",
            "current_count": thread_result['current_count'],
            "limit": thread_result['limit'],
            "error_code": "THREAD_LIMIT_EXCEEDED"
        })


async def _get_effective_model(model_name: Optional[str], agent_config: Optional[dict], client, account_id: str) -> str:
    """Determine effective model to use."""
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


# ============================================================================
# Core Agent Start Logic
# ============================================================================

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
    mode: Optional[str] = None,  # Mode: slides, sheets, docs, canvas, video, research
) -> Dict[str, Any]:
    """Start an agent run - core business logic."""
    from core.agents.config import load_agent_config
    from core.threads import repo as threads_repo
    from core.utils.project_helpers import generate_and_update_project_name
    
    # Timing instrumentation for stress testing
    timing_breakdown = {}
    total_start = time.time()
    
    client = await db.client
    is_new_thread = thread_id is None or is_optimistic
    now_iso = datetime.now(timezone.utc).isoformat()
    
    logger.info(f"🚀 start_agent_run: is_optimistic={is_optimistic}, is_new_thread={is_new_thread}")
    
    image_contexts_to_inject = []
    final_message_content = prompt
    
    # Parallel: load config + check limits
    step_start = time.time()
    
    async def load_config():
        return await load_agent_config(agent_id, account_id, user_id=account_id, client=client, is_new_thread=is_new_thread)
    
    async def check_limits():
        if not skip_limits_check:
            await _check_billing_and_limits(client, account_id, model_name or "default", 
                                           check_project_limit=is_new_thread, check_thread_limit=is_new_thread)
    
    agent_config, _ = await asyncio.gather(load_config(), check_limits())
    timing_breakdown["load_config_ms"] = round((time.time() - step_start) * 1000, 1)
    
    step_start = time.time()
    effective_model = await _get_effective_model(model_name, agent_config, client, account_id)
    timing_breakdown["get_model_ms"] = round((time.time() - step_start) * 1000, 1)
    
    # For existing threads, fetch project_id
    if not is_new_thread and not project_id:
        project_id = await threads_repo.get_thread_project_id(thread_id)
    
    # Create project/thread for new threads
    if is_new_thread:
        if not project_id:
            project_id = str(uuid.uuid4())
        if not thread_id:
            thread_id = str(uuid.uuid4())
        
        placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
        
        step_start = time.time()
        await threads_repo.create_project_and_thread(
            project_id=project_id,
            thread_id=thread_id,
            account_id=account_id,
            project_name=placeholder_name,
            thread_name="New Chat",
            status="pending",
            memory_enabled=memory_enabled
        )
        timing_breakdown["create_project_and_thread_ms"] = round((time.time() - step_start) * 1000, 1)
        
        from core.cache.runtime_cache import set_cached_project_metadata, increment_thread_count_cache
        from core.utils.thread_name_generator import generate_and_update_thread_name
        
        # Cache project metadata with mode if provided
        project_metadata = {"mode": mode} if mode else {}
        asyncio.create_task(set_cached_project_metadata(project_id, project_metadata))
        asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))
        if prompt:
            asyncio.create_task(generate_and_update_thread_name(thread_id=thread_id, prompt=prompt))
        asyncio.create_task(increment_thread_count_cache(account_id))
        
        if project_id != thread_id:
            async def migrate_file_cache():
                try:
                    old_key = f"file_context:{project_id}"
                    new_key = f"file_context:{thread_id}"
                    cached = await redis.get(old_key)
                    if cached:
                        await redis.set(new_key, cached, ex=3600)
                        await redis.delete(old_key)
                except Exception:
                    pass
            asyncio.create_task(migrate_file_cache())
        
        structlog.contextvars.bind_contextvars(thread_id=thread_id, project_id=project_id, account_id=account_id)
        
        if staged_files:
            final_message_content, image_contexts_to_inject = await handle_staged_files_for_thread(
                staged_files=staged_files,
                thread_id=thread_id,
                project_id=project_id,
                prompt=prompt,
                account_id=account_id
            )
    
    elif not is_new_thread and staged_files:
        final_message_content, image_contexts_to_inject = await handle_staged_files_for_thread(
            staged_files=staged_files,
            thread_id=thread_id,
            project_id=project_id,
            prompt=prompt,
            account_id=account_id
        )
    
    async def create_message():
        if not final_message_content or not final_message_content.strip():
            return
        await threads_repo.create_message_full(
            message_id=str(uuid.uuid4()),
            thread_id=thread_id,
            message_type="user",
            content={"role": "user", "content": final_message_content},
            is_llm_message=True
        )
    
    async def create_agent_run():
        return await _create_agent_run_record(thread_id, agent_config, effective_model, account_id, metadata)
    
    async def update_thread_status():
        await threads_repo.update_thread_status(
            thread_id=thread_id,
            status="ready",
            initialization_started_at=now_iso,
            initialization_completed_at=now_iso
        )
    
    step_start = time.time()
    _, agent_run_id, _ = await asyncio.gather(create_message(), create_agent_run(), update_thread_status())
    timing_breakdown["create_message_and_run_ms"] = round((time.time() - step_start) * 1000, 1)
    
    # Insert image contexts in background
    if image_contexts_to_inject:
        async def insert_images():
            await threads_repo.set_thread_has_images(thread_id)
            for img in image_contexts_to_inject:
                try:
                    await threads_repo.create_message_full(
                        message_id=str(uuid.uuid4()),
                        thread_id=thread_id,
                        message_type="image_context",
                        content={
                            "role": "user",
                            "content": [
                                {"type": "text", "text": f"[Image: {img['filename']}]"},
                                {"type": "image_url", "image_url": {"url": img['url']}}
                            ]
                        },
                        is_llm_message=True,
                        metadata={"file_path": img['filename'], "mime_type": img['mime_type'], "source": "user_upload"}
                    )
                except Exception:
                    pass
        asyncio.create_task(insert_images())
    
    # Execute agent run as background task
    cancellation_event = asyncio.Event()
    _cancellation_events[agent_run_id] = cancellation_event
    
    async def execute_run():
        from core.utils.lifecycle_tracker import log_run_start, log_run_cleanup
        
        log_run_start(agent_run_id, thread_id)
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
                is_new_thread=is_new_thread
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
            # Track _cancellation_events cleanup
            was_in_events = _cancellation_events.pop(agent_run_id, None) is not None
            if not was_in_events:
                cleanup_errors.append("not_in_cancellation_events")
                logger.warning(
                    f"[LIFECYCLE] agent_run={agent_run_id} "
                    f"was NOT in _cancellation_events at cleanup"
                )
            
            # Log final cleanup status
            log_run_cleanup(
                agent_run_id, 
                success=(cleanup_reason is None),
                reason=cleanup_reason,
                final_status=final_status,
                cleanup_errors=cleanup_errors if cleanup_errors else None
            )
    
    asyncio.create_task(execute_run())
    logger.info(f"✅ Started agent run {agent_run_id} as background task")
    
    # Calculate total setup time
    timing_breakdown["total_setup_ms"] = round((time.time() - total_start) * 1000, 1)
    
    return {
        "thread_id": thread_id,
        "agent_run_id": agent_run_id,
        "project_id": project_id,
        "status": "running",
        "timing_breakdown": timing_breakdown if emit_timing else None,
    }


# ============================================================================
# API Endpoints
# ============================================================================

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
    mode: Optional[str] = Form(None),  # Mode: slides, sheets, docs, canvas, video, research
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Start an agent run. Files must be staged via /files/stage first."""
    client = await db.client
    account_id = user_id
    is_optimistic = optimistic and optimistic.lower() == 'true'
    
    # Get staged files if file_ids provided
    staged_files_data = None
    if file_ids:
        target_id = thread_id or project_id or str(uuid.uuid4())
        staged_files_data = await get_staged_files_for_thread(file_ids, user_id, target_id)
    
    # Validation
    if is_optimistic:
        if not thread_id or not project_id:
            raise HTTPException(status_code=400, detail="thread_id and project_id required for optimistic mode")
        # Allow empty prompt if file_ids provided (file-only submission)
        if (not prompt or not prompt.strip()) and not file_ids:
            raise HTTPException(status_code=400, detail="prompt or file_ids required for optimistic mode")
        try:
            uuid.UUID(thread_id)
            uuid.UUID(project_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid UUID format")
    
    if not is_optimistic and not thread_id and (not prompt or not prompt.strip()) and not file_ids:
        raise HTTPException(status_code=400, detail="prompt or file_ids required when creating new thread")
    
    # Resolve model
    if model_name is None:
        model_name = await model_manager.get_default_model_for_user(client, account_id)
    elif model_name != "mock-ai":
        model_name = model_manager.resolve_model_id(model_name)
    
    memory_enabled_bool = memory_enabled.lower() == 'true' if memory_enabled else None
    
    # Check for admin bypass header (for stress testing)
    # Must verify user is super_admin before trusting the header
    skip_limits = False
    emit_timing = False
    if request.headers.get("X-Skip-Limits", "").lower() == "true":
        from core.endpoints.user_roles_repo import get_user_admin_role
        role_info = await get_user_admin_role(user_id)
        if role_info.get('role') == 'super_admin':
            skip_limits = True
            # Also check for timing emission (stress test feature)
            emit_timing = request.headers.get("X-Emit-Timing", "").lower() == "true"
    
    try:
        # Verify access for existing threads
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
        # Include timing breakdown for stress testing (only when emit_timing is True)
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
    """List agent runs for a thread."""
    from core.agents.repo import get_thread_agent_runs as repo_get_thread_runs
    
    client = await db.client
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    agent_runs = await repo_get_thread_runs(thread_id)
    return {"agent_runs": agent_runs}


@router.get("/agent-run/{agent_run_id}", summary="Get Agent Run", operation_id="get_agent_run")
async def get_agent_run(agent_run_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Get agent run details."""
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
    request: Request = None
):
    """Stream agent run responses via SSE."""
    user_id = await get_user_id_from_stream_auth(request, token)
    agent_run_data = await _get_agent_run_with_access_check(agent_run_id, user_id)

    stream_key = f"agent_run:{agent_run_id}:stream"

    def compare_stream_ids(id1: str, id2: str) -> int:
        """Compare Redis stream IDs. Returns -1 if id1 < id2, 0 if equal, 1 if id1 > id2."""
        try:
            t1, s1 = id1.split('-')
            t2, s2 = id2.split('-')
            if int(t1) != int(t2):
                return -1 if int(t1) < int(t2) else 1
            return -1 if int(s1) < int(s2) else (0 if int(s1) == int(s2) else 1)
        except Exception:
            return -1 if id1 < id2 else (0 if id1 == id2 else 1)

    def find_last_safe_boundary(entries):
        """Find last safe trim boundary in stream entries."""
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

    async def stream_generator(agent_run_data):
        terminate = False
        last_id = "0"

        try:
            # Initial catch-up
            entries = await redis.stream_range(stream_key)
            if entries:
                for entry_id, fields in entries:
                    response = json.loads(fields.get('data', '{}'))
                    yield f"data: {json.dumps(response)}\n\n"
                    last_id = entry_id
                    if response.get('type') == 'status' and response.get('status') in ['completed', 'failed', 'stopped', 'error']:
                        return
                
                # Trim processed entries
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
                    except Exception:
                        pass

            if agent_run_data.get('status') != 'running':
                yield f"data: {json.dumps({'type': 'status', 'status': 'completed'})}\n\n"
                return

            # Use hub for fan-out: N clients watching same stream = 1 Redis XREAD + N queues
            # This fixes connection starvation when many SSE clients connect
            timeout_count = 0
            ping_count = 0
            received_data = bool(entries)
            MAX_PINGS_WITHOUT_DATA = 4  # ~20 seconds without data = check for dead worker

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
                            yield f"data: {data}\n\n"
                            last_id = entry_id

                            try:
                                response = json.loads(data)
                                if response.get('type') == 'status' and response.get('status') in ['completed', 'failed', 'stopped', 'error']:
                                    return
                            except Exception:
                                pass
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
        stream_generator(agent_run_data), 
        media_type="text/event-stream", 
        headers={
            "Cache-Control": "no-cache, no-transform", 
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no", 
            "Content-Type": "text/event-stream",
            "Access-Control-Allow-Origin": "*"
        }
    )
