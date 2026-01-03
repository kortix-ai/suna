"""
Unified agent service - single entry point for starting agent runs and agent CRUD operations.

This module consolidates:
- Agent start logic (ensuring consistent behavior for both new threads and existing threads)
- Agent listing/filtering operations
"""
import asyncio
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

from core.utils.logger import logger, structlog
from core.services.supabase import DBConnection
from core.services import redis
from core.temporal.client import get_temporal_client
from core.temporal.workflows import AgentRunWorkflow, TASK_QUEUE_AGENT_RUNS
from core.ai_models import model_manager
from core import agent_runs as agent_runs_module
from core.utils.pagination import PaginationService, PaginationParams, PaginatedResponse, PaginationMeta

db = DBConnection()


class AgentFilters:
    """Filters for agent listing queries."""
    def __init__(
        self,
        search: Optional[str] = None,
        has_default: Optional[bool] = None,
        has_mcp_tools: Optional[bool] = None,
        has_agentpress_tools: Optional[bool] = None,
        tools: Optional[List[str]] = None,
        content_type: Optional[str] = None,
        sort_by: str = "created_at",
        sort_order: str = "desc"
    ):
        self.search = search
        self.has_default = has_default
        self.has_mcp_tools = has_mcp_tools
        self.has_agentpress_tools = has_agentpress_tools
        self.tools = tools or []
        self.content_type = content_type
        self.sort_by = sort_by
        self.sort_order = sort_order


class AgentService:
    """Service for agent CRUD operations."""
    
    def __init__(self, db_client):
        self.db_client = db_client
    
    async def get_agents_paginated(
        self,
        user_id: str,
        pagination_params: PaginationParams,
        filters: AgentFilters
    ) -> PaginatedResponse[Dict[str, Any]]:
        """Get paginated list of agents with filters."""
        logger.debug(f"[AGENT_FLOW] AgentService: Getting agents (user_id: {user_id}, page: {pagination_params.page}, filters: {filters.__dict__})")
        
        try:
            # Build base query with count='exact' for pagination
            # This allows the pagination service to get total count from result.count
            query = self.db_client.table('agents').select('*', count='exact')
            
            # Filter by account_id (user's agents)
            query = query.eq('account_id', user_id)
            
            # Apply filters
            if filters.search:
                query = query.ilike('name', f'%{filters.search}%')
            
            if filters.has_default is not None:
                if filters.has_default:
                    query = query.eq('metadata->>is_suna_default', 'true')
                else:
                    # Filter out default agents - exclude those where is_suna_default is 'true'
                    query = query.neq('metadata->>is_suna_default', 'true')
            
            # Note: MCP tools and AgentPress tools filtering would require checking agent versions
            # For now, we'll skip these complex filters as they require joining with versions table
            
            # Apply sorting
            if filters.sort_by == "name":
                query = query.order('name', desc=(filters.sort_order == "desc"))
            elif filters.sort_by == "created_at":
                query = query.order('created_at', desc=(filters.sort_order == "desc"))
            elif filters.sort_by == "updated_at":
                query = query.order('updated_at', desc=(filters.sort_order == "desc"))
            else:
                # Default to created_at
                query = query.order('created_at', desc=(filters.sort_order == "desc"))
            
            # Use pagination service
            result = await PaginationService.paginate_database_query(
                base_query=query,
                params=pagination_params
            )
            
            logger.debug(f"[AGENT_FLOW] AgentService: Found {len(result.data)} agents (total: {result.pagination.total_items})")
            
            return result
            
        except Exception as e:
            logger.error(f"[AGENT_FLOW] AgentService: Error fetching agents: {e}", exc_info=True)
            raise


async def _load_agent_config(client, agent_id: Optional[str], account_id: str, user_id: str, is_new_thread: bool = False) -> Optional[dict]:
    """Load agent configuration from database or cache."""
    from .agent_loader import get_agent_loader
    import time
    
    t_start = time.time()
    loader = await get_agent_loader()
    
    if agent_id:
        from core.runtime_cache import get_static_suna_config, get_cached_user_mcps
        
        static_config = get_static_suna_config()
        cached_mcps = await get_cached_user_mcps(agent_id)
        
        if static_config and cached_mcps is not None:
            from core.agent_loader import AgentData
            agent_data = AgentData(
                agent_id=agent_id,
                name="Kortix",
                description=None,
                account_id=account_id,
                is_default=True,
                is_public=False,
                tags=[],
                icon_name=None,
                icon_color=None,
                icon_background=None,
                created_at="",
                updated_at="",
                current_version_id=None,
                version_count=1,
                metadata={'is_suna_default': True},
                system_prompt=static_config['system_prompt'],
                model=static_config['model'],
                agentpress_tools=static_config['agentpress_tools'],
                configured_mcps=cached_mcps.get('configured_mcps', []),
                custom_mcps=cached_mcps.get('custom_mcps', []),
                triggers=cached_mcps.get('triggers', []),
                is_suna_default=True,
                centrally_managed=True,
                config_loaded=True,
                restrictions=static_config['restrictions']
            )
            logger.debug(f"⚡ [FAST PATH] Suna config from memory + Redis MCPs: {(time.time() - t_start)*1000:.1f}ms")
        else:
            agent_data = await loader.load_agent(agent_id, user_id, load_config=True)
            logger.debug(f"Using agent {agent_data.name} ({agent_id}) version {agent_data.version_name}")
    else:
        logger.debug(f"[AGENT LOAD] Loading default agent")
        
        if is_new_thread:
            from core.utils.ensure_suna import ensure_suna_installed
            await ensure_suna_installed(account_id)
        
        default_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).eq('metadata->>is_suna_default', 'true').maybe_single().execute()
        
        if default_agent and default_agent.data:
            agent_data = await loader.load_agent(default_agent.data['agent_id'], user_id, load_config=True)
            logger.debug(f"Using default agent: {agent_data.name} ({agent_data.agent_id}) version {agent_data.version_name}")
        else:
            logger.warning(f"[AGENT LOAD] No default agent found for account {account_id}, searching for shared Suna")
            agent_data = await agent_runs_module._find_shared_suna_agent(client)
            
            if not agent_data:
                any_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).limit(1).maybe_single().execute()
                
                if any_agent and any_agent.data:
                    agent_data = await loader.load_agent(any_agent.data['agent_id'], user_id, load_config=True)
                    logger.info(f"[AGENT LOAD] Using fallback agent: {agent_data.name} ({agent_data.agent_id})")
                else:
                    logger.error(f"[AGENT LOAD] No agents found for account {account_id}")
                    raise ValueError("No agents available. Please create an agent first.")
    
    agent_config = agent_data.to_dict() if agent_data else None
    
    if agent_config:
        logger.debug(f"Using agent {agent_config['agent_id']} for this agent run")
    
    return agent_config


async def _get_effective_model(model_name: Optional[str], agent_config: Optional[dict], client, account_id: str) -> str:
    """Determine the effective model to use for this agent run."""
    if model_name:
        logger.debug(f"Using user-selected model: {model_name}")
        return model_name
    elif agent_config and agent_config.get('model'):
        effective_model = agent_config['model']
        logger.debug(f"No model specified by user, using agent's configured model: {effective_model}")
        return effective_model
    else:
        effective_model = await model_manager.get_default_model_for_user(client, account_id)
        logger.debug(f"Using default model for user: {effective_model}")
        return effective_model


async def _create_agent_run_record(
    client,
    thread_id: str,
    agent_config: Optional[dict],
    effective_model: str,
    actual_user_id: str,
    extra_metadata: Optional[Dict[str, Any]] = None
) -> str:
    """Create agent_run record in database."""
    logger.debug(f"[AGENT_FLOW] STEP 4.1: Preparing agent_run metadata (model: {effective_model}, agent_id: {agent_config.get('agent_id') if agent_config else None})")
    run_metadata = {
        "model_name": effective_model,
        "actual_user_id": actual_user_id
    }
    
    if extra_metadata:
        run_metadata.update(extra_metadata)
        logger.debug(f"[AGENT_FLOW] STEP 4.2: Added extra metadata: {list(extra_metadata.keys())}")
    
    logger.debug(f"[AGENT_FLOW] STEP 4.3: Inserting agent_run record into DB")
    agent_run = await client.table('agent_runs').insert({
        "thread_id": thread_id,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_config.get('agent_id') if agent_config else None,
        "agent_version_id": agent_config.get('current_version_id') if agent_config else None,
        "metadata": run_metadata
    }).execute()

    agent_run_id = agent_run.data[0]['id']
    structlog.contextvars.bind_contextvars(agent_run_id=agent_run_id)
    logger.debug(f"[AGENT_FLOW] STEP 4.4: Agent run record inserted: {agent_run_id}")

    try:
        from core.runtime_cache import invalidate_running_runs_cache
        await invalidate_running_runs_cache(actual_user_id)
    except Exception as cache_error:
        logger.warning(f"Failed to invalidate running runs cache: {cache_error}")
    
    try:
        from core.billing.shared.cache_utils import invalidate_account_state_cache
        await invalidate_account_state_cache(actual_user_id)
    except Exception as cache_error:
        logger.warning(f"Failed to invalidate account-state cache: {cache_error}")

    return agent_run_id


async def start_agent(
    thread_id: str,
    project_id: str,
    account_id: str,
    model_name: Optional[str] = None,
    agent_id: Optional[str] = None,
    is_new_thread: bool = False,
    extra_metadata: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Start an agent run. Single entry point for all agent starts.
    
    This function:
    1. Loads agent configuration
    2. Determines effective model
    3. Creates agent_run record in DB
    4. Pre-creates Redis stream
    5. Starts Temporal workflow
    
    Args:
        thread_id: Thread ID for this agent run
        project_id: Project ID
        account_id: Account ID
        model_name: Optional model name override
        agent_id: Optional agent ID
        is_new_thread: Whether this is a new thread (affects agent loading)
        extra_metadata: Optional extra metadata for agent_run record
    
    Returns:
        agent_run_id: The created agent run ID
    """
    import time
    t_start = time.time()
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
        project_id=project_id,
        account_id=account_id,
    )
    
    logger.info(f"[AGENT_FLOW] STEP 1: Starting agent run for thread {thread_id} (project: {project_id}, account: {account_id}, is_new_thread: {is_new_thread})")
    
    # Initialize DB if needed
    if not db._client:
        logger.debug(f"[AGENT_FLOW] STEP 1.1: Initializing DB connection")
        await db.initialize()
    client = await db.client
    logger.debug(f"[AGENT_FLOW] STEP 1.2: DB connection ready (took {(time.time() - t_start)*1000:.1f}ms)")
    
    # Load agent config
    t_config_start = time.time()
    logger.info(f"[AGENT_FLOW] STEP 2: Loading agent config (agent_id: {agent_id or 'default'})")
    agent_config = await _load_agent_config(client, agent_id, account_id, account_id, is_new_thread=is_new_thread)
    logger.info(f"[AGENT_FLOW] STEP 2: Agent config loaded (agent_id: {agent_config.get('agent_id') if agent_config else None}, took {(time.time() - t_config_start)*1000:.1f}ms)")
    
    # Resolve model name if provided
    t_model_start = time.time()
    logger.info(f"[AGENT_FLOW] STEP 3: Resolving model (provided: {model_name})")
    if model_name:
        model_name = model_manager.resolve_model_id(model_name)
        logger.debug(f"[AGENT_FLOW] STEP 3.1: Resolved model name: {model_name}")
    
    # Get effective model
    effective_model = await _get_effective_model(model_name, agent_config, client, account_id)
    logger.info(f"[AGENT_FLOW] STEP 3: Effective model determined: {effective_model} (took {(time.time() - t_model_start)*1000:.1f}ms)")
    
    # Create agent_run record
    t_db_start = time.time()
    logger.info(f"[AGENT_FLOW] STEP 4: Creating agent_run record in DB")
    agent_run_id = await _create_agent_run_record(
        client, thread_id, agent_config, effective_model, account_id, extra_metadata
    )
    logger.info(f"[AGENT_FLOW] STEP 4: Agent run record created: {agent_run_id} (took {(time.time() - t_db_start)*1000:.1f}ms)")
    
    # Pre-create Redis stream so frontend can subscribe immediately
    t_stream_start = time.time()
    stream_key = f"agent_run:{agent_run_id}:stream"
    logger.info(f"[AGENT_FLOW] STEP 5: Pre-creating Redis stream: {stream_key}")
    await redis.verify_stream_writable(stream_key)
    logger.info(f"[AGENT_FLOW] STEP 5: Redis stream pre-created successfully (took {(time.time() - t_stream_start)*1000:.1f}ms)")
    
    # Start Temporal workflow
    t_workflow_start = time.time()
    logger.info(f"[AGENT_FLOW] STEP 6: Starting Temporal workflow (agent_run_id: {agent_run_id})")
    try:
        temporal_client = await get_temporal_client()
        worker_instance_id = str(uuid.uuid4())[:8]
        request_id = structlog.contextvars.get_contextvars().get('request_id')
        logger.debug(f"[AGENT_FLOW] STEP 6.1: Temporal client ready, instance_id: {worker_instance_id}, request_id: {request_id}")
        
        workflow_id = f"agent-run-{agent_run_id}"
        logger.debug(f"[AGENT_FLOW] STEP 6.2: Starting workflow with id: {workflow_id}, task_queue: {TASK_QUEUE_AGENT_RUNS}")
        
        handle = await temporal_client.start_workflow(
            AgentRunWorkflow.run,
            args=[agent_run_id, thread_id, worker_instance_id, project_id, effective_model, agent_id, account_id, request_id],
            id=workflow_id,
            task_queue=TASK_QUEUE_AGENT_RUNS,
        )
        
        logger.info(f"[AGENT_FLOW] STEP 6: Temporal workflow started successfully (workflow_id: {handle.id}, took {(time.time() - t_workflow_start)*1000:.1f}ms)")
        
        # Verify workflow was actually created
        try:
            verify_handle = temporal_client.get_workflow_handle(workflow_id)
            verify_status = await verify_handle.describe()
            logger.debug(f"[AGENT_FLOW] STEP 6.3: Verified workflow exists - status: {verify_status.status.name if hasattr(verify_status.status, 'name') else verify_status.status}")
        except Exception as verify_err:
            logger.warning(f"[AGENT_FLOW] STEP 6.3: Could not verify workflow after start: {verify_err}")
            
    except Exception as workflow_start_error:
        error_msg = f"Failed to start Temporal workflow: {str(workflow_start_error)}"
        logger.error(f"[AGENT_FLOW] STEP 6 ERROR: {error_msg}", exc_info=True)
        
        # Update DB to reflect failure
        try:
            await client.table('agent_runs').update({
                'status': 'failed',
                'error': error_msg,
                'completed_at': datetime.now(timezone.utc).isoformat()
            }).eq('id', agent_run_id).execute()
        except Exception as db_update_err:
            logger.error(f"[AGENT_FLOW] STEP 6 ERROR: Failed to update DB after workflow start failure: {db_update_err}")
        
        raise RuntimeError(error_msg)
    logger.info(f"[AGENT_FLOW] COMPLETE: Agent start finished successfully (agent_run_id: {agent_run_id}, total time: {(time.time() - t_start)*1000:.1f}ms)")
    
    return agent_run_id
