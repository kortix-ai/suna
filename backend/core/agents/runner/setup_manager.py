import asyncio
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import structlog

from core.services import redis
from core.utils.config import config, EnvMode

logger = structlog.get_logger(__name__)


async def prepopulate_caches_for_new_thread(
    thread_id: str,
    project_id: str,
    message_content: str,
    image_contexts: List[Dict[str, Any]],
    mode: Optional[str],
) -> None:
    from core.cache.runtime_cache import set_cached_message_history, get_cached_project_metadata, set_cached_project_metadata
    
    if message_content and message_content.strip():
        initial_messages = [{
            "role": "user",
            "content": message_content,
            "message_id": str(uuid.uuid4())
        }]
        await set_cached_message_history(thread_id, initial_messages)
    
    has_images = len(image_contexts) > 0
    cache_key = f"thread_has_images:{thread_id}"
    await redis.set(cache_key, "1" if has_images else "0", ex=7200 if has_images else 300)
    
    if mode:
        existing = await get_cached_project_metadata(project_id)
        existing_sandbox = existing.get('sandbox', {}) if existing else {}
        project_metadata = {**existing_sandbox, "mode": mode}
        await set_cached_project_metadata(project_id, project_metadata)


async def invalidate_caches_for_existing_thread(thread_id: str) -> None:
    from core.cache.runtime_cache import invalidate_message_history_cache
    await invalidate_message_history_cache(thread_id)
    logger.debug(f"🗑️ Invalidated message cache for thread {thread_id}")


async def append_user_message_to_cache(thread_id: str, message_content: str) -> bool:
    from core.cache.runtime_cache import append_to_cached_message_history
    import uuid
    
    if not message_content or not message_content.strip():
        return False
    
    message = {
        "role": "user",
        "content": message_content,
        "message_id": str(uuid.uuid4())
    }
    return await append_to_cached_message_history(thread_id, message)


async def write_user_message_for_existing_thread(
    thread_id: str,
    message_content: str,
) -> None:
    from core.threads import repo as threads_repo
    
    if not message_content or not message_content.strip():
        return
    
    msg_start = time.time()
    await threads_repo.create_message_full(
        message_id=str(uuid.uuid4()),
        thread_id=thread_id,
        message_type="user",
        content={"role": "user", "content": message_content},
        is_llm_message=True
    )
    logger.debug(f"⏱️ User message written: {(time.time() - msg_start)*1000:.1f}ms")


async def prewarm_user_context(account_id: str) -> None:
    try:
        from core.cache.runtime_cache import get_cached_user_context, set_cached_user_context
        
        cached = await get_cached_user_context(account_id)
        if cached is not None:
            return
        
        from core.services.supabase import DBConnection
        db = DBConnection()
        client = await db.client
        
        async def fetch_locale():
            try:
                from core.utils.user_locale import get_user_locale
                return await get_user_locale(account_id, client)
            except Exception:
                return None
        
        async def fetch_username():
            try:
                user = await client.auth.admin.get_user_by_id(account_id)
                if user and user.user:
                    user_metadata = user.user.user_metadata or {}
                    email = user.user.email
                    return (
                        user_metadata.get('full_name') or
                        user_metadata.get('name') or
                        user_metadata.get('display_name') or
                        (email.split('@')[0] if email else None)
                    )
                return None
            except Exception:
                return None
        
        locale, username = await asyncio.gather(fetch_locale(), fetch_username())
        
        context_parts = []
        if locale:
            from core.utils.user_locale import get_locale_context_prompt
            locale_prompt = get_locale_context_prompt(locale)
            context_parts.append(f"\n\n{locale_prompt}\n")
        if username:
            username_info = f"\n\n=== USER INFORMATION ===\n"
            username_info += f"The user's name is: {username}\n"
            username_info += "Use this information to personalize your responses and address the user appropriately.\n"
            context_parts.append(username_info)
        
        context_str = ''.join(context_parts) if context_parts else ""
        await set_cached_user_context(account_id, context_str)
        logger.debug(f"⚡ Pre-warmed user context for {account_id}")
    except Exception as e:
        logger.debug(f"⚠️ Failed to pre-warm user context: {e}")


async def prewarm_credit_balance(account_id: str) -> None:
    try:
        from core.billing.credits.manager import credit_manager
        await credit_manager.get_balance(account_id)
        logger.debug(f"⚡ Pre-warmed credit balance for {account_id}")
    except Exception as e:
        logger.debug(f"⚠️ Failed to pre-warm credit balance: {e}")


async def create_new_thread_records(
    project_id: str,
    thread_id: str,
    account_id: str,
    prompt: str,
    agent_run_id: str,
    message_content: str,
    agent_config: dict,
    metadata: Optional[Dict[str, Any]],
    memory_enabled: Optional[bool],
) -> None:
    from core.threads import repo as threads_repo
    from core.cache.runtime_cache import delete_pending_thread, increment_thread_count_cache
    from core.utils.project_helpers import generate_and_update_project_name
    from core.utils.thread_name_generator import generate_and_update_thread_name
    
    placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
    
    await threads_repo.create_thread_with_message_and_run(
        project_id=project_id,
        thread_id=thread_id,
        account_id=account_id,
        project_name=placeholder_name,
        thread_name="New Chat",
        agent_run_id=agent_run_id,
        message_content=message_content,
        agent_id=agent_config.get("agent_id"),
        agent_version_id=agent_config.get("agent_version_id"),
        run_metadata=metadata,
        memory_enabled=memory_enabled
    )
    
    await delete_pending_thread(thread_id)
    
    asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))
    if prompt:
        asyncio.create_task(generate_and_update_thread_name(thread_id=thread_id, prompt=prompt))
    asyncio.create_task(increment_thread_count_cache(account_id))


async def create_agent_run_record(
    agent_run_id: str,
    thread_id: str,
    agent_config: Optional[dict],
    effective_model: str,
    account_id: str,
    extra_metadata: Optional[Dict[str, Any]] = None
) -> str:
    from core.agents import repo as agents_repo
    from core.utils.instance import get_instance_id
    
    run_metadata = {
        "model_name": effective_model,
        "actual_user_id": account_id,
        "instance_id": get_instance_id()
    }
    if extra_metadata:
        run_metadata.update(extra_metadata)
    if agent_config:
        run_metadata["agent_config"] = {
            k: v for k, v in agent_config.items()
            if k not in ("system_prompt",)
        }
    
    await agents_repo.create_agent_run_with_id(
        agent_run_id=agent_run_id,
        thread_id=thread_id,
        agent_id=agent_config.get("agent_id") if agent_config else None,
        agent_version_id=agent_config.get("agent_version_id") if agent_config else None,
        metadata=run_metadata
    )
    return agent_run_id


async def create_image_messages(
    thread_id: str,
    image_contexts: List[Dict[str, Any]],
) -> None:
    from core.threads import repo as threads_repo
    
    if not image_contexts:
        return
    
    await threads_repo.set_thread_has_images(thread_id)
    
    for img in image_contexts:
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
                metadata={
                    "file_path": img['filename'],
                    "mime_type": img['mime_type'],
                    "source": "user_upload"
                }
            )
        except Exception:
            pass


async def check_concurrent_runs_limit(
    account_id: str,
    agent_run_id: str,
    cancellation_event: asyncio.Event,
    skip_check: bool = False,
) -> None:
    if skip_check or config.ENV_MODE == EnvMode.LOCAL:
        return
    
    try:
        from core.agents.api import _check_concurrent_runs_limit
        await _check_concurrent_runs_limit(account_id)
    except Exception as e:
        from fastapi import HTTPException
        if isinstance(e, HTTPException):
            logger.warning(f"⚠️ Concurrent runs limit exceeded for {account_id}")
            error_detail = e.detail if isinstance(e.detail, dict) else {"message": str(e.detail)}
            error_msg = {
                "type": "error",
                "error": error_detail.get("message", "Concurrent runs limit exceeded"),
                "error_code": error_detail.get("error_code", "AGENT_RUN_LIMIT_EXCEEDED"),
                "agent_run_id": agent_run_id
            }
            stream_key = f"agent_run:{agent_run_id}:stream"
            await redis.stream_add(stream_key, {"data": json.dumps(error_msg)}, maxlen=50)
            cancellation_event.set()


async def notify_setup_error(
    agent_run_id: str,
    error: Exception,
) -> None:
    stream_key = f"agent_run:{agent_run_id}:stream"
    
    try:
        error_msg = {
            "type": "error",
            "error": f"Failed to start agent: {str(error)[:200]}",
            "agent_run_id": agent_run_id
        }
        await redis.stream_add(stream_key, {"data": json.dumps(error_msg)}, maxlen=50)
        
        status_msg = {
            "type": "status",
            "status": "failed",
            "message": f"Setup failed: {str(error)[:100]}"
        }
        await redis.stream_add(stream_key, {"data": json.dumps(status_msg)}, maxlen=50)
    except Exception:
        pass
    
    try:
        from core.agents import repo as agents_repo
        await agents_repo.update_agent_run_status(agent_run_id, "failed")
    except Exception:
        pass
