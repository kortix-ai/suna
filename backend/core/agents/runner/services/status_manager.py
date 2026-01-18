from typing import Optional, Dict, Any

from core.utils.logger import logger


async def ensure_project_metadata_cached(project_id: str) -> None:
    from core.cache.runtime_cache import get_cached_project_metadata, set_cached_project_metadata
    from core.threads import repo as threads_repo

    cached_project = await get_cached_project_metadata(project_id)
    if cached_project is not None:
        return

    try:
        project_data = await threads_repo.get_project_with_sandbox(project_id)

        if not project_data:
            logger.warning(f"Project {project_id} not found, caching empty metadata")
            await set_cached_project_metadata(project_id, {})
            return

        sandbox_info = {}
        if project_data.get('resource_external_id'):
            resource_config = project_data.get('resource_config') or {}
            sandbox_info = {
                'sandbox_id': project_data['resource_external_id'],
                **resource_config
            }

        await set_cached_project_metadata(project_id, sandbox_info)
        logger.debug(f"✅ Cached project metadata for {project_id}")

    except Exception as e:
        logger.warning(f"Failed to fetch project metadata for {project_id}: {e}")
        await set_cached_project_metadata(project_id, {})


async def update_agent_run_status(
    agent_run_id: str,
    status: str,
    error: Optional[str] = None,
    account_id: Optional[str] = None,
) -> bool:
    from core.agents import repo as agents_repo

    try:
        success = await agents_repo.update_agent_run_status(
            agent_run_id=agent_run_id,
            status=status,
            error=error
        )

        if success:
            if account_id:
                try:
                    from core.cache.runtime_cache import invalidate_running_runs_cache
                    await invalidate_running_runs_cache(account_id)
                except:
                    pass

                try:
                    from core.billing.shared.cache_utils import invalidate_account_state_cache
                    await invalidate_account_state_cache(account_id)
                except:
                    pass

            logger.info(f"✅ Updated agent run {agent_run_id} status to '{status}'")
            return True
        else:
            logger.error(f"Failed to update agent run status: {agent_run_id}")
            return False

    except Exception as e:
        logger.error(f"Failed to update agent run status for {agent_run_id}: {e}")
        return False


async def send_completion_notification(
    thread_id: str,
    agent_config: Optional[Dict[str, Any]],
    complete_tool_called: bool
):
    if not complete_tool_called:
        return

    try:
        from core.notifications.notification_service import notification_service
        from core.threads import repo as threads_repo

        thread_info = await threads_repo.get_project_and_thread_info(thread_id)
        if thread_info:
            task_name = thread_info.get('project_name') or 'Task'
            user_id = thread_info.get('account_id')
            if user_id:
                await notification_service.send_task_completion_notification(
                    account_id=user_id,
                    task_name=task_name,
                    thread_id=thread_id,
                    agent_name=agent_config.get('name') if agent_config else None,
                    result_summary="Task completed successfully"
                )
    except Exception as e:
        logger.warning(f"Failed to send completion notification: {e}")
