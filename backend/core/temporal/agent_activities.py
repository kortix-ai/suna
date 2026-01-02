from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
import json
import asyncio
import time
from temporalio import activity

from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.services import redis


@dataclass
class AgentRunInput:
    agent_run_id: str
    thread_id: str
    project_id: str
    model_name: str
    agent_id: Optional[str] = None
    account_id: Optional[str] = None
    instance_id: str = ""


@dataclass
class AgentRunOutput:
    status: str
    error_message: Optional[str] = None
    total_responses: int = 0
    complete_tool_called: bool = False
    duration_seconds: float = 0.0


REDIS_STREAM_TTL_SECONDS = 600

db = DBConnection()


def create_redis_keys(agent_run_id: str, instance_id: str) -> Dict[str, str]:
    return {
        'response_stream': f"agent_run:{agent_run_id}:stream",
        'instance_active': f"active_run:{instance_id}:{agent_run_id}"
    }


def check_terminating_tool_call(response: Dict[str, Any]) -> Optional[str]:
    if response.get('type') != 'status':
        return None
    
    metadata = response.get('metadata', {})
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (json.JSONDecodeError, TypeError):
            metadata = {}
    
    if not metadata.get('agent_should_terminate'):
        return None
    
    content = response.get('content', {})
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            content = {}
    
    if isinstance(content, dict):
        function_name = content.get('function_name')
        if function_name in ['ask', 'complete']:
            return function_name
    
    return None


async def load_agent_config(agent_id: Optional[str], account_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not agent_id:
        return None
    
    try:
        from core.runtime_cache import (
            get_static_suna_config, 
            get_cached_user_mcps,
            get_cached_agent_config
        )
        
        static_config = get_static_suna_config()
        cached_mcps = await get_cached_user_mcps(agent_id)
        
        if static_config and cached_mcps is not None:
            return {
                'agent_id': agent_id,
                'system_prompt': static_config['system_prompt'],
                'model': static_config['model'],
                'agentpress_tools': static_config['agentpress_tools'],
                'centrally_managed': static_config['centrally_managed'],
                'is_suna_default': static_config['is_suna_default'],
                'restrictions': static_config['restrictions'],
                'configured_mcps': cached_mcps.get('configured_mcps', []),
                'custom_mcps': cached_mcps.get('custom_mcps', []),
                'triggers': cached_mcps.get('triggers', []),
            }
        
        cached_config = await get_cached_agent_config(agent_id)
        if cached_config:
            return cached_config
        
        if account_id:
            from core.agent_loader import get_agent_loader
            loader = await get_agent_loader()
            agent_data = await loader.load_agent(agent_id, account_id, load_config=True)
            return agent_data.to_dict()
        
        from core.agent_loader import get_agent_loader
        loader = await get_agent_loader()
        agent_data = await loader.load_agent(agent_id, agent_id, load_config=True)
        return agent_data.to_dict()
        
    except Exception as e:
        logger.warning(f"Failed to fetch agent config for agent_id {agent_id}: {e}")
        return None


async def get_thread_data(client, thread_id: str) -> dict:
    try:
        thread_info = await client.table('threads').select('project_id').eq('thread_id', thread_id).maybe_single().execute()
        if thread_info and thread_info.data:
            project_id = thread_info.data.get('project_id')
            if project_id:
                project_info = await client.table('projects').select('name').eq('project_id', project_id).maybe_single().execute()
                task_name = 'Task'
                if project_info and project_info.data:
                    task_name = project_info.data.get('name', 'Task')
                
                return {
                    'task_name': task_name,
                    'task_url': f"/projects/{project_id}/thread/{thread_id}"
                }
    except Exception as e:
        logger.warning(f"Failed to get notification data for thread {thread_id}: {e}")
    
    return {
        'task_name': 'Task',
        'task_url': f"/thread/{thread_id}"
    }


async def send_completion_notification(client, thread_id: str, agent_config: Optional[Dict[str, Any]], complete_tool_called: bool):
    if not complete_tool_called:
        return
    
    try:
        from core.notifications.notification_service import notification_service
        thread_info = await client.table('threads').select('account_id').eq('thread_id', thread_id).maybe_single().execute()
        if thread_info and thread_info.data:
            user_id = thread_info.data.get('account_id')
            if user_id:
                notification_data = await get_thread_data(client, thread_id)
                await notification_service.send_task_completion_notification(
                    account_id=user_id,
                    task_name=notification_data['task_name'],
                    thread_id=thread_id,
                    agent_name=agent_config.get('name') if agent_config else None,
                    result_summary="Task completed successfully"
                )
    except Exception as notif_error:
        logger.warning(f"Failed to send completion notification: {notif_error}")


async def send_failure_notification(client, thread_id: str, error_message: str):
    try:
        from core.notifications.notification_service import notification_service
        thread_info = await client.table('threads').select('account_id').eq('thread_id', thread_id).maybe_single().execute()
        if thread_info and thread_info.data:
            user_id = thread_info.data.get('account_id')
            if user_id:
                notification_data = await get_thread_data(client, thread_id)
                await notification_service.send_task_failed_notification(
                    account_id=user_id,
                    task_name=notification_data['task_name'],
                    task_url=notification_data['task_url'],
                    failure_reason=error_message,
                    first_name='User',
                    thread_id=thread_id
                )
    except Exception as notif_error:
        logger.warning(f"Failed to send failure notification: {notif_error}")


async def update_agent_run_status(
    client,
    agent_run_id: str,
    status: str,
    error: Optional[str] = None,
    account_id: Optional[str] = None,
) -> bool:
    try:
        update_data = {
            "status": status,
            "completed_at": datetime.now(timezone.utc).isoformat()
        }
        if error:
            update_data["error"] = error

        for retry in range(3):
            try:
                update_result = await client.table('agent_runs').update(update_data).eq("id", agent_run_id).execute()
                if hasattr(update_result, 'data') and update_result.data:
                    if account_id:
                        try:
                            from core.runtime_cache import invalidate_running_runs_cache
                            await invalidate_running_runs_cache(account_id)
                        except Exception:
                            pass
                        try:
                            from core.billing.shared.cache_utils import invalidate_account_state_cache
                            await invalidate_account_state_cache(account_id)
                        except Exception:
                            pass
                    return True
            except Exception as db_error:
                logger.error(f"Database error on retry {retry}: {str(db_error)}")
                if retry < 2:
                    await asyncio.sleep(0.5 * (2 ** retry))
        return False
    except Exception as e:
        logger.error(f"Unexpected error updating agent run status: {str(e)}")
        return False


async def cleanup_redis_keys(agent_run_id: str, instance_id: Optional[str] = None):
    keys_to_delete = [
        f"agent_run:{agent_run_id}:stream",
        f"agent_run_lock:{agent_run_id}",
    ]
    if instance_id:
        keys_to_delete.append(f"active_run:{instance_id}:{agent_run_id}")
    
    for key in keys_to_delete:
        try:
            await redis.delete(key)
        except Exception as e:
            logger.warning(f"Failed to delete Redis key {key}: {e}")


@activity.defn(name="run_agent")
async def run_agent_activity(input: AgentRunInput) -> AgentRunOutput:
    worker_start = time.time()
    
    logger.info(f"[Temporal] Starting agent run: {input.agent_run_id} for thread: {input.thread_id}")
    
    await db.initialize()
    await redis.initialize_async()
    client = await db.client
    
    redis_keys = create_redis_keys(input.agent_run_id, input.instance_id)
    
    try:
        await redis.set(redis_keys['instance_active'], "running", ex=redis.REDIS_KEY_TTL)
    except Exception:
        pass
    
    final_status = "running"
    error_message = None
    complete_tool_called = False
    total_responses = 0
    agent_config = None
    
    start_time = datetime.now(timezone.utc)
    
    try:
        from core.ai_models import model_manager
        effective_model = model_manager.resolve_model_id(input.model_name)
        logger.info(f"[Temporal] Using model: {effective_model}")
        
        agent_config = await load_agent_config(input.agent_id, input.account_id)
        
        from core.tool_output_streaming_context import set_tool_output_streaming_context, clear_tool_output_streaming_context
        set_tool_output_streaming_context(
            agent_run_id=input.agent_run_id,
            stream_key=redis_keys['response_stream']
        )
        
        from core.services.langfuse import langfuse
        trace = langfuse.trace(
            name="agent_run",
            id=input.agent_run_id,
            session_id=input.thread_id,
            metadata={"project_id": input.project_id, "instance_id": input.instance_id, "temporal": True}
        )
        
        cancellation_event = asyncio.Event()
        
        from core.run import run_agent
        agent_gen = run_agent(
            thread_id=input.thread_id,
            project_id=input.project_id,
            model_name=effective_model,
            agent_config=agent_config,
            trace=trace,
            cancellation_event=cancellation_event,
            account_id=input.account_id,
        )
        
        stream_key = redis_keys['response_stream']
        stream_ttl_set = False
        last_heartbeat = time.time()
        
        async for response in agent_gen:
            if activity.is_cancelled():
                logger.warning(f"[Temporal] Agent run {input.agent_run_id} cancelled via Temporal")
                final_status = "stopped"
                error_message = "Cancelled via Temporal"
                cancellation_event.set()
                break
            
            if time.time() - last_heartbeat > 10:
                activity.heartbeat(f"processed {total_responses} responses")
                last_heartbeat = time.time()
            
            response_json = json.dumps(response)
            try:
                await redis.stream_add(stream_key, {"data": response_json}, maxlen=200, approximate=True)
                if not stream_ttl_set:
                    await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
                    stream_ttl_set = True
            except Exception as e:
                logger.warning(f"Failed to write to stream: {e}")
            
            total_responses += 1
            
            if total_responses % 50 == 0:
                try:
                    await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
                except Exception:
                    pass
            
            terminating_tool = check_terminating_tool_call(response)
            if terminating_tool == 'complete':
                complete_tool_called = True
            
            if response.get('type') == 'status':
                status_val = response.get('status')
                if status_val in ['completed', 'failed', 'stopped', 'error']:
                    final_status = status_val if status_val != 'error' else 'failed'
                    if status_val in ['failed', 'stopped', 'error']:
                        error_message = response.get('message', f"Run ended with status: {status_val}")
                    break
        
        if final_status == "running":
            final_status = "completed"
            completion_message = {"type": "status", "status": "completed", "message": "Agent run completed successfully"}
            try:
                await redis.stream_add(stream_key, {'data': json.dumps(completion_message)}, maxlen=200, approximate=True)
            except Exception:
                pass
        
        clear_tool_output_streaming_context()
        
        await update_agent_run_status(client, input.agent_run_id, final_status, error=error_message, account_id=input.account_id)
        
        if final_status == "completed":
            await send_completion_notification(client, input.thread_id, agent_config, complete_tool_called)
        elif final_status == "failed" and error_message:
            await send_failure_notification(client, input.thread_id, error_message)
        
        duration = (datetime.now(timezone.utc) - start_time).total_seconds()
        logger.info(f"[Temporal] Agent run {input.agent_run_id} finished with status: {final_status} (duration: {duration:.2f}s)")
        
        return AgentRunOutput(
            status=final_status,
            error_message=error_message,
            total_responses=total_responses,
            complete_tool_called=complete_tool_called,
            duration_seconds=duration,
        )
        
    except Exception as e:
        import traceback
        error_message = str(e)
        traceback_str = traceback.format_exc()
        logger.error(f"[Temporal] Agent run {input.agent_run_id} failed: {error_message}\n{traceback_str}")
        
        error_response = {"type": "status", "status": "error", "message": error_message}
        try:
            await redis.stream_add(redis_keys['response_stream'], {'data': json.dumps(error_response)}, maxlen=200, approximate=True)
        except Exception:
            pass
        
        await update_agent_run_status(client, input.agent_run_id, "failed", error=f"{error_message}\n{traceback_str}", account_id=input.account_id)
        await send_failure_notification(client, input.thread_id, error_message)
        
        raise
        
    finally:
        await cleanup_redis_keys(input.agent_run_id, input.instance_id)
        
        try:
            import gc
            gc.collect()
        except Exception:
            pass

