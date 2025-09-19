import json
import traceback
import uuid
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException
from utils.cache import Cache
from utils.logger import logger
from utils.config import config
from utils.auth_utils import verify_thread_access
from services import redis
from services.supabase import DBConnection
from services.llm import make_llm_api_call
from run_agent_background import update_agent_run_status, _cleanup_redis_response_list

# Global variables (will be set by initialize function)
db = None
instance_id = None

# Helper for version service
async def _get_version_service():
    from .handlers.versioning.version_service import get_version_service
    return await get_version_service()

async def cleanup():
    """Clean up resources and stop running agents on shutdown."""
    logger.debug("Starting cleanup of agent API resources")

    # Use the instance_id to find and clean up this instance's keys
    try:
        if instance_id: # Ensure instance_id is set
            running_keys = await redis.keys(f"active_run:{instance_id}:*")
            logger.debug(f"Found {len(running_keys)} running agent runs for instance {instance_id} to clean up")

            for key in running_keys:
                # Key format: active_run:{instance_id}:{agent_run_id}
                parts = key.split(":")
                if len(parts) == 3:
                    agent_run_id = parts[2]
                    await stop_agent_run_with_helpers(agent_run_id, error_message=f"Instance {instance_id} shutting down")
                else:
                    logger.warning(f"Unexpected key format found: {key}")
        else:
            logger.warning("Instance ID not set, cannot clean up instance-specific agent runs.")

    except Exception as e:
        logger.error(f"Failed to clean up running agent runs: {str(e)}")

    # Close Redis connection
    await redis.close()
    logger.debug("Completed cleanup of agent API resources")

async def stop_agent_run_with_helpers(agent_run_id: str, error_message: Optional[str] = None):
    """Update database and publish stop signal to Redis."""
    logger.debug(f"Stopping agent run: {agent_run_id}")
    client = await db.client
    final_status = "failed" if error_message else "stopped"

    # Attempt to fetch final responses from Redis
    response_list_key = f"agent_run:{agent_run_id}:responses"
    all_responses = []
    try:
        all_responses_json = await redis.lrange(response_list_key, 0, -1)
        all_responses = [json.loads(r) for r in all_responses_json]
        logger.debug(f"Fetched {len(all_responses)} responses from Redis for DB update on stop/fail: {agent_run_id}")
    except Exception as e:
        logger.error(f"Failed to fetch responses from Redis for {agent_run_id} during stop/fail: {e}")
        # Try fetching from DB as a fallback? Or proceed without responses? Proceeding without for now.

    # Update the agent run status in the database
    update_success = await update_agent_run_status(
        client, agent_run_id, final_status, error=error_message
    )

    if not update_success:
        logger.error(f"Failed to update database status for stopped/failed run {agent_run_id}")
        raise HTTPException(status_code=500, detail="Failed to update agent run status in database")

    # Send STOP signal to the global control channel
    global_control_channel = f"agent_run:{agent_run_id}:control"
    try:
        await redis.publish(global_control_channel, "STOP")
        logger.debug(f"Published STOP signal to global channel {global_control_channel}")
    except Exception as e:
        logger.error(f"Failed to publish STOP signal to global channel {global_control_channel}: {str(e)}")

    # Find all instances handling this agent run and send STOP to instance-specific channels
    try:
        instance_keys = await redis.keys(f"active_run:*:{agent_run_id}")
        logger.debug(f"Found {len(instance_keys)} active instance keys for agent run {agent_run_id}")

        for key in instance_keys:
            # Key format: active_run:{instance_id}:{agent_run_id}
            parts = key.split(":")
            if len(parts) == 3:
                instance_id_from_key = parts[1]
                instance_control_channel = f"agent_run:{agent_run_id}:control:{instance_id_from_key}"
                try:
                    await redis.publish(instance_control_channel, "STOP")
                    logger.debug(f"Published STOP signal to instance channel {instance_control_channel}")
                except Exception as e:
                    logger.warning(f"Failed to publish STOP signal to instance channel {instance_control_channel}: {str(e)}")
            else:
                 logger.warning(f"Unexpected key format found: {key}")

        # Clean up the response list immediately on stop/fail
        await _cleanup_redis_response_list(agent_run_id)

    except Exception as e:
        logger.error(f"Failed to find or signal active instances for {agent_run_id}: {str(e)}")

    logger.debug(f"Successfully initiated stop process for agent run: {agent_run_id}")

async def get_agent_run_with_access_check(client, agent_run_id: str, user_id: str):
    agent_run = await client.table('agent_runs').select('*, threads(account_id)').eq('id', agent_run_id).execute()
    if not agent_run.data:
        raise HTTPException(status_code=404, detail="Agent run not found")

    agent_run_data = agent_run.data[0]
    thread_id = agent_run_data['thread_id']
    account_id = agent_run_data['threads']['account_id']
    if account_id == user_id:
        return agent_run_data
    await verify_thread_access(client, thread_id, user_id)
    return agent_run_data

async def generate_and_update_project_name(project_id: str, prompt: str):
    """Generates a project name using an LLM and updates the database."""
    logger.debug(f"Starting background task to generate name for project: {project_id}")
    try:
        db_conn = DBConnection()
        client = await db_conn.client

        model_name = "openai/gpt-5-nano"
        system_prompt = "You are a helpful assistant that generates extremely concise titles (2-4 words maximum) for chat threads based on the user's message. Respond with only the title, no other text or punctuation."
        user_message = f"Generate an extremely brief title (2-4 words only) for a chat thread that starts with this message: \"{prompt}\""
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}]

        logger.debug(f"Calling LLM ({model_name}) for project {project_id} naming.")
        response = await make_llm_api_call(messages=messages, model_name=model_name, max_tokens=20, temperature=0.7)

        generated_name = None
        if response and response.get('choices') and response['choices'][0].get('message'):
            raw_name = response['choices'][0]['message'].get('content', '').strip()
            cleaned_name = raw_name.strip('\'" \n\t')
            if cleaned_name:
                generated_name = cleaned_name
                logger.debug(f"LLM generated name for project {project_id}: '{generated_name}'")
            else:
                logger.warning(f"LLM returned an empty name for project {project_id}.")
        else:
            logger.warning(f"Failed to get valid response from LLM for project {project_id} naming. Response: {response}")

        if generated_name:
            update_result = await client.table('projects').update({"name": generated_name}).eq("project_id", project_id).execute()
            if hasattr(update_result, 'data') and update_result.data:
                logger.debug(f"Successfully updated project {project_id} name to '{generated_name}'")
            else:
                logger.error(f"Failed to update project {project_id} name in database. Update result: {update_result}")
        else:
            logger.warning(f"No generated name, skipping database update for project {project_id}.")

    except Exception as e:
        logger.error(f"Error in background naming task for project {project_id}: {str(e)}\n{traceback.format_exc()}")
    finally:
        # No need to disconnect DBConnection singleton instance here
        logger.debug(f"Finished background naming task for project: {project_id}")

def merge_custom_mcps(existing_mcps: List[Dict[str, Any]], new_mcps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not new_mcps:
        return existing_mcps
    
    merged_mcps = existing_mcps.copy()
    
    for new_mcp in new_mcps:
        new_mcp_name = new_mcp.get('name')
        existing_index = None
        
        for i, existing_mcp in enumerate(merged_mcps):
            if existing_mcp.get('name') == new_mcp_name:
                existing_index = i
                break
        
        if existing_index is not None:
            merged_mcps[existing_index] = new_mcp
        else:
            merged_mcps.append(new_mcp)
    
    return merged_mcps

def initialize(
    _db: DBConnection,
    _instance_id: Optional[str] = None
):
    """Initialize the agent API with resources from the main API."""
    global db, instance_id
    db = _db
    
    # Initialize the versioning module with the same database connection
    from .handlers.versioning.api import initialize as initialize_versioning
    initialize_versioning(_db)

    # Use provided instance_id or generate a new one
    if _instance_id:
        instance_id = _instance_id
    else:
        # Generate instance ID
        instance_id = str(uuid.uuid4())[:8]

    logger.debug(f"Initialized agent API with instance ID: {instance_id}")

async def _cleanup_redis_response_list(agent_run_id: str):
    try:
        response_list_key = f"agent_run:{agent_run_id}:responses"
        await redis.delete(response_list_key)
        logger.debug(f"Cleaned up Redis response list for agent run {agent_run_id}")
    except Exception as e:
        logger.warning(f"Failed to clean up Redis response list for {agent_run_id}: {str(e)}")


async def check_for_active_project_agent_run(client, project_id: str):
    project_threads = await client.table('threads').select('thread_id').eq('project_id', project_id).execute()
    project_thread_ids = [t['thread_id'] for t in project_threads.data]

    if project_thread_ids:
        from utils.query_utils import batch_query_in
        
        active_runs = await batch_query_in(
            client=client,
            table_name='agent_runs',
            select_fields='id',
            in_field='thread_id',
            in_values=project_thread_ids,
            additional_filters={'status': 'running'}
        )
        
        if active_runs:
            return active_runs[0]['id']
    return None


async def stop_agent_run(db, agent_run_id: str, error_message: Optional[str] = None):
    logger.debug(f"Stopping agent run: {agent_run_id}")
    client = await db.client
    final_status = "failed" if error_message else "stopped"

    response_list_key = f"agent_run:{agent_run_id}:responses"
    all_responses = []
    try:
        all_responses_json = await redis.lrange(response_list_key, 0, -1)
        all_responses = [json.loads(r) for r in all_responses_json]
        logger.debug(f"Fetched {len(all_responses)} responses from Redis for DB update on stop/fail: {agent_run_id}")
    except Exception as e:
        logger.error(f"Failed to fetch responses from Redis for {agent_run_id} during stop/fail: {e}")

    update_success = await update_agent_run_status(
        client, agent_run_id, final_status, error=error_message, responses=all_responses
    )

    if not update_success:
        logger.error(f"Failed to update database status for stopped/failed run {agent_run_id}")

    global_control_channel = f"agent_run:{agent_run_id}:control"
    try:
        await redis.publish(global_control_channel, "STOP")
        logger.debug(f"Published STOP signal to global channel {global_control_channel}")
    except Exception as e:
        logger.error(f"Failed to publish STOP signal to global channel {global_control_channel}: {str(e)}")

    try:
        instance_keys = await redis.keys(f"active_run:*:{agent_run_id}")
        logger.debug(f"Found {len(instance_keys)} active instance keys for agent run {agent_run_id}")

        for key in instance_keys:
            parts = key.split(":")
            if len(parts) == 3:
                instance_id_from_key = parts[1]
                instance_control_channel = f"agent_run:{agent_run_id}:control:{instance_id_from_key}"
                try:
                    await redis.publish(instance_control_channel, "STOP")
                    logger.debug(f"Published STOP signal to instance channel {instance_control_channel}")
                except Exception as e:
                    logger.warning(f"Failed to publish STOP signal to instance channel {instance_control_channel}: {str(e)}")
            else:
                logger.warning(f"Unexpected key format found: {key}")

        await _cleanup_redis_response_list(agent_run_id)

    except Exception as e:
        logger.error(f"Failed to find or signal active instances for {agent_run_id}: {str(e)}")

    logger.debug(f"Successfully initiated stop process for agent run: {agent_run_id}")


async def check_agent_run_limit(client, account_id: str) -> Dict[str, Any]:
    """
    Check if the account has reached the limit of 3 parallel agent runs within the past 24 hours.
    
    Returns:
        Dict with 'can_start' (bool), 'running_count' (int), 'running_thread_ids' (list)
    """
    try:
        result = await Cache.get(f"agent_run_limit:{account_id}")
        if result:
            return result

        # Calculate 24 hours ago
        twenty_four_hours_ago = datetime.now(timezone.utc) - timedelta(hours=24)
        twenty_four_hours_ago_iso = twenty_four_hours_ago.isoformat()
        
        logger.debug(f"Checking agent run limit for account {account_id} since {twenty_four_hours_ago_iso}")
        
        # Get all threads for this account
        threads_result = await client.table('threads').select('thread_id').eq('account_id', account_id).execute()
        
        if not threads_result.data:
            logger.debug(f"No threads found for account {account_id}")
            return {
                'can_start': True,
                'running_count': 0,
                'running_thread_ids': []
            }
        
        thread_ids = [thread['thread_id'] for thread in threads_result.data]
        logger.debug(f"Found {len(thread_ids)} threads for account {account_id}")
        
        # Query for running agent runs within the past 24 hours for these threads
        from utils.query_utils import batch_query_in
        
        running_runs = await batch_query_in(
            client=client,
            table_name='agent_runs',
            select_fields='id, thread_id, started_at',
            in_field='thread_id',
            in_values=thread_ids,
            additional_filters={
                'status': 'running',
                'started_at_gte': twenty_four_hours_ago_iso
            }
        )
        
        running_count = len(running_runs)
        running_thread_ids = [run['thread_id'] for run in running_runs]
        
        logger.debug(f"Account {account_id} has {running_count} running agent runs in the past 24 hours")
        
        result = {
            'can_start': running_count < config.MAX_PARALLEL_AGENT_RUNS,
            'running_count': running_count,
            'running_thread_ids': running_thread_ids
        }
        await Cache.set(f"agent_run_limit:{account_id}", result)
        return result

    except Exception as e:
        logger.error(f"Error checking agent run limit for account {account_id}: {str(e)}")
        # In case of error, allow the run to proceed but log the error
        return {
            'can_start': True,
            'running_count': 0,
            'running_thread_ids': []
        }


async def check_agent_count_limit(client, account_id: str) -> Dict[str, Any]:
    try:
        # In local mode, allow practically unlimited custom agents
        if config.ENV_MODE.value == "local":
            return {
                'can_create': True,
                'current_count': 0,  # Return 0 to avoid showing any limit warnings
                'limit': 999999,     # Practically unlimited
                'tier_name': 'local'
            }
        
        try:
            result = await Cache.get(f"agent_count_limit:{account_id}")
            if result:
                logger.debug(f"Cache hit for agent count limit: {account_id}")
                return result
        except Exception as cache_error:
            logger.warning(f"Cache read failed for agent count limit {account_id}: {str(cache_error)}")

        agents_result = await client.table('agents').select('agent_id, metadata').eq('account_id', account_id).execute()
        
        non_suna_agents = []
        for agent in agents_result.data or []:
            metadata = agent.get('metadata', {}) or {}
            is_suna_default = metadata.get('is_suna_default', False)
            if not is_suna_default:
                non_suna_agents.append(agent)
                
        current_count = len(non_suna_agents)
        logger.debug(f"Account {account_id} has {current_count} custom agents (excluding Suna defaults)")
        
        try:
            from services.billing import get_subscription_tier
            tier_name = await get_subscription_tier(client, account_id)
            logger.debug(f"Account {account_id} subscription tier: {tier_name}")
        except Exception as billing_error:
            logger.warning(f"Could not get subscription tier for {account_id}: {str(billing_error)}, defaulting to free")
            tier_name = 'free'
        
        agent_limit = config.AGENT_LIMITS.get(tier_name, config.AGENT_LIMITS['free'])
        
        can_create = current_count < agent_limit
        
        result = {
            'can_create': can_create,
            'current_count': current_count,
            'limit': agent_limit,
            'tier_name': tier_name
        }
        
        try:
            await Cache.set(f"agent_count_limit:{account_id}", result, ttl=300)
        except Exception as cache_error:
            logger.warning(f"Cache write failed for agent count limit {account_id}: {str(cache_error)}")
        
        logger.debug(f"Account {account_id} has {current_count}/{agent_limit} agents (tier: {tier_name}) - can_create: {can_create}")
        
        return result
        
    except Exception as e:
        logger.error(f"Error checking agent count limit for account {account_id}: {str(e)}", exc_info=True)
        return {
            'can_create': True,
            'current_count': 0,
            'limit': config.AGENT_LIMITS['free'],
            'tier_name': 'free'
        }


async def check_project_count_limit(client, account_id: str) -> Dict[str, Any]:
    """
    Check if a user can create more projects based on their subscription tier.
    
    Returns:
        Dict containing:
        - can_create: bool - whether user can create another project
        - current_count: int - current number of projects
        - limit: int - maximum projects allowed for this tier
        - tier_name: str - subscription tier name
    """
    try:
        # In local mode, allow practically unlimited projects
        if config.ENV_MODE.value == "local":
            return {
                'can_create': True,
                'current_count': 0,  # Return 0 to avoid showing any limit warnings
                'limit': 999999,     # Practically unlimited
                'tier_name': 'local'
            }
        
        try:
            result = await Cache.get(f"project_count_limit:{account_id}")
            if result:
                logger.debug(f"Cache hit for project count limit: {account_id}")
                return result
        except Exception as cache_error:
            logger.warning(f"Cache read failed for project count limit {account_id}: {str(cache_error)}")

        # Count projects for this account
        projects_result = await client.table('projects').select('project_id').eq('account_id', account_id).execute()
        current_count = len(projects_result.data or [])
        logger.debug(f"Account {account_id} has {current_count} projects")
        
        try:
            from services.billing import get_subscription_tier
            tier_name = await get_subscription_tier(client, account_id)
            logger.debug(f"Account {account_id} subscription tier: {tier_name}")
        except Exception as billing_error:
            logger.warning(f"Could not get subscription tier for {account_id}: {str(billing_error)}, defaulting to free")
            tier_name = 'free'
        
        project_limit = config.PROJECT_LIMITS.get(tier_name, config.PROJECT_LIMITS['free'])
        can_create = current_count < project_limit
        
        result = {
            'can_create': can_create,
            'current_count': current_count,
            'limit': project_limit,
            'tier_name': tier_name
        }
        
        try:
            await Cache.set(f"project_count_limit:{account_id}", result, ttl=300)
        except Exception as cache_error:
            logger.warning(f"Cache write failed for project count limit {account_id}: {str(cache_error)}")
        
        logger.debug(f"Account {account_id} has {current_count}/{project_limit} projects (tier: {tier_name}) - can_create: {can_create}")
        
        return result
        
    except Exception as e:
        logger.error(f"Error checking project count limit for account {account_id}: {str(e)}", exc_info=True)
        return {
            'can_create': False,
            'current_count': 0,
            'limit': config.PROJECT_LIMITS['free'],
            'tier_name': 'free'
        }


if __name__ == "__main__":
    import asyncio
    import sys
    import os
    
    # Add the backend directory to the Python path
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    
    from services.supabase import DBConnection
    from utils.logger import logger
    
    async def test_large_thread_count():
        """Test the functions with a large number of threads to verify URI limit fixes."""
        print("🧪 Testing URI limit fixes with large thread counts...")
        
        try:
            # Initialize database connection
            db = DBConnection()
            client = await db.client
            
            # Test user ID (replace with actual user ID that has many threads)
            test_user_id = "2558d81e-5008-46d6-b7d3-8cc62d44e4f6"  # The user from the error logs
            
            print(f"📊 Testing with user ID: {test_user_id}")
            
            # Test 1: check_agent_run_limit with many threads
            print("\n1️⃣ Testing check_agent_run_limit...")
            try:
                result = await check_agent_run_limit(client, test_user_id)
                print(f"✅ check_agent_run_limit succeeded:")
                print(f"   - Can start: {result['can_start']}")
                print(f"   - Running count: {result['running_count']}")
                print(f"   - Running thread IDs: {len(result['running_thread_ids'])} threads")
            except Exception as e:
                print(f"❌ check_agent_run_limit failed: {str(e)}")
            
            # Test 2: Get a project ID to test check_for_active_project_agent_run
            print("\n2️⃣ Testing check_for_active_project_agent_run...")
            try:
                # Get a project for this user
                projects_result = await client.table('projects').select('project_id').eq('account_id', test_user_id).limit(1).execute()
                
                if projects_result.data and len(projects_result.data) > 0:
                    test_project_id = projects_result.data[0]['project_id']
                    print(f"   Using project ID: {test_project_id}")
                    
                    result = await check_for_active_project_agent_run(client, test_project_id)
                    print(f"✅ check_for_active_project_agent_run succeeded:")
                    print(f"   - Active run ID: {result}")
                else:
                    print("   ⚠️  No projects found for user, skipping this test")
            except Exception as e:
                print(f"❌ check_for_active_project_agent_run failed: {str(e)}")
            
            # Test 3: check_agent_count_limit (doesn't have URI issues but good to test)
            print("\n3️⃣ Testing check_agent_count_limit...")
            try:
                result = await check_agent_count_limit(client, test_user_id)
                print(f"✅ check_agent_count_limit succeeded:")
                print(f"   - Can create: {result['can_create']}")
                print(f"   - Current count: {result['current_count']}")
                print(f"   - Limit: {result['limit']}")
                print(f"   - Tier: {result['tier_name']}")
            except Exception as e:
                print(f"❌ check_agent_count_limit failed: {str(e)}")

            print("\n🎉 All agent utils tests completed!")
            
        except Exception as e:
            print(f"❌ Test setup failed: {str(e)}")
            import traceback
            traceback.print_exc()
    
    async def test_billing_integration():
        """Test the billing integration to make sure it works with the fixed functions."""
        print("\n💰 Testing billing integration...")
        
        try:
            from services.billing import calculate_monthly_usage, get_usage_logs
            
            db = DBConnection()
            client = await db.client
            
            test_user_id = "2558d81e-5008-46d6-b7d3-8cc62d44e4f6"
            
            print(f"📊 Testing billing functions with user: {test_user_id}")
            
            # Test calculate_monthly_usage (which uses get_usage_logs internally)
            print("\n1️⃣ Testing calculate_monthly_usage...")
            try:
                usage = await calculate_monthly_usage(client, test_user_id)
                print(f"✅ calculate_monthly_usage succeeded: ${usage:.4f}")
            except Exception as e:
                print(f"❌ calculate_monthly_usage failed: {str(e)}")
            
            # Test get_usage_logs directly with pagination
            print("\n2️⃣ Testing get_usage_logs with pagination...")
            try:
                logs = await get_usage_logs(client, test_user_id, page=0, items_per_page=10)
                print(f"✅ get_usage_logs succeeded:")
                print(f"   - Found {len(logs.get('logs', []))} log entries")
                print(f"   - Has more: {logs.get('has_more', False)}")
                print(f"   - Subscription limit: ${logs.get('subscription_limit', 0)}")
            except Exception as e:
                print(f"❌ get_usage_logs failed: {str(e)}")
                
        except ImportError as e:
            print(f"⚠️  Could not import billing functions: {str(e)}")
        except Exception as e:
            print(f"❌ Billing test failed: {str(e)}")
    
    async def test_api_functions():
        """Test the API functions that were also fixed for URI limits."""
        print("\n🔧 Testing API functions...")
        
        try:
            # Import the API functions we fixed
            import sys
            sys.path.append('/app')  # Add the app directory to path
            
            db = DBConnection()
            client = await db.client
            
            test_user_id = "2558d81e-5008-46d6-b7d3-8cc62d44e4f6"
            
            print(f"📊 Testing API functions with user: {test_user_id}")
            
            # Test 1: get_user_threads (which has the project batching fix)
            print("\n1️⃣ Testing get_user_threads simulation...")
            try:
                # Get threads for the user
                threads_result = await client.table('threads').select('*').eq('account_id', test_user_id).order('created_at', desc=True).execute()
                
                if threads_result.data:
                    print(f"   - Found {len(threads_result.data)} threads")
                    
                    # Extract unique project IDs (this is what could cause URI issues)
                    project_ids = [
                        thread['project_id'] for thread in threads_result.data[:1000]  # Limit to first 1000
                        if thread.get('project_id')
                    ]
                    unique_project_ids = list(set(project_ids)) if project_ids else []
                    
                    print(f"   - Found {len(unique_project_ids)} unique project IDs")
                    
                    if unique_project_ids:
                        # Test the batching logic we implemented
                        if len(unique_project_ids) > 100:
                            print(f"   - Would use batching for {len(unique_project_ids)} project IDs")
                        else:
                            print(f"   - Would use direct query for {len(unique_project_ids)} project IDs")
                        
                        # Actually test a small batch to verify it works
                        test_batch = unique_project_ids[:min(10, len(unique_project_ids))]
                        projects_result = await client.table('projects').select('*').in_('project_id', test_batch).execute()
                        print(f"✅ Project query test succeeded: found {len(projects_result.data or [])} projects")
                    else:
                        print("   - No project IDs to test")
                else:
                    print("   - No threads found for user")
                    
            except Exception as e:
                print(f"❌ get_user_threads test failed: {str(e)}")
            
            # Test 2: Template service simulation
            print("\n2️⃣ Testing template service simulation...")
            try:
                from templates.template_service import TemplateService
                
                # This would test the creator ID batching, but we'll just verify the import works
                print("✅ Template service import succeeded")
                
            except ImportError as e:
                print(f"⚠️  Could not import template service: {str(e)}")
            except Exception as e:
                print(f"❌ Template service test failed: {str(e)}")
                
        except Exception as e:
            print(f"❌ API functions test failed: {str(e)}")
    
    async def main():
        """Main test function."""
        print("🚀 Starting URI limit fix tests...\n")
        
        await test_large_thread_count()
        await test_billing_integration()
        await test_api_functions()
        
        print("\n✨ Test suite completed!")
    
    # Run the tests
    asyncio.run(main())
