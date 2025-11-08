"""
Agent setup from natural language description.
"""
import json
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from core.utils.logger import logger
from core.services.llm import make_llm_api_call
from core.utils.icon_generator import generate_icon_and_colors
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.versioning.version_service import get_version_service as _get_version_service
from core.utils.core_tools_helper import ensure_core_tools_enabled
from core.config_helper import _get_default_agentpress_tools
from core.ai_models import model_manager

from . import core_utils as utils
from .api_models import AgentResponse

router = APIRouter(tags=["agents"])


class AgentSetupFromChatRequest(BaseModel):
    description: str


class AgentSetupFromChatResponse(BaseModel):
    agent_id: str
    name: str
    system_prompt: str
    icon_name: str
    icon_color: str
    icon_background: str


async def generate_agent_name_and_prompt(description: str) -> dict:
    """
    Generate agent name and system prompt from description.
    
    Args:
        description: User's natural language description
        
    Returns:
        Dict with keys: name, system_prompt
    """
    try:
        model_name = "openai/gpt-5-nano-2025-08-07"
        
        system_prompt = """You are an AI worker configuration expert. Generate a name and system prompt for an AI worker.

Respond with JSON:
{"name": "Worker Name (2-4 words)", "system_prompt": "Detailed instructions for the worker's role and behavior"}

Example:
{"name": "Research Assistant", "system_prompt": "Act as an expert research assistant. Help users find and analyze information. Always verify facts and cite sources clearly."}"""

        user_message = f"Generate name and system prompt for:\n\n{description}"
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}]

        logger.debug(f"Calling LLM for name/prompt generation")
        response = await make_llm_api_call(
            messages=messages,
            model_name=model_name,
            max_tokens=2000,
            temperature=0.7,
            response_format={"type": "json_object"},
            stream=False
        )

        if response and response.get('choices') and response['choices'][0].get('message'):
            raw_content = response['choices'][0]['message'].get('content', '').strip()
            try:
                parsed = json.loads(raw_content)
                if 'name' in parsed and 'system_prompt' in parsed:
                    return {
                        "name": parsed['name'].strip(),
                        "system_prompt": parsed['system_prompt'].strip()
                    }
            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse name/prompt response: {e}")
        
        return {
            "name": "Custom Assistant",
            "system_prompt": f"Act as a helpful AI assistant. {description}"
        }
        
    except Exception as e:
        logger.error(f"Error generating name/prompt: {str(e)}")
        return {
            "name": "Custom Assistant",
            "system_prompt": f"Act as a helpful AI assistant. {description}"
        }


async def generate_agent_config_from_description(description: str) -> dict:
    """
    Use LLM to generate agent config (name, prompt, icon, colors) from description.
    Runs name/prompt and icon/color generation in parallel for speed.
    
    Args:
        description: User's natural language description of what the agent should do
        
    Returns:
        Dict with keys: name, system_prompt, icon_name, icon_color, icon_background
    """
    logger.debug(f"Generating agent config from description: {description[:100]}...")
    
    try:
        from core.utils.icon_generator import generate_icon_and_colors
        import asyncio
        
        # Run both LLM calls in parallel
        name_prompt_task = generate_agent_name_and_prompt(description)
        icon_task = generate_icon_and_colors(name="", description=description)
        
        # Wait for both to complete
        name_prompt_result, icon_result = await asyncio.gather(
            name_prompt_task,
            icon_task,
            return_exceptions=True
        )
        
        # Handle errors
        if isinstance(name_prompt_result, Exception):
            logger.error(f"Error in name/prompt generation: {name_prompt_result}")
            name_prompt_result = {
                "name": "Custom Assistant",
                "system_prompt": f"Act as a helpful AI assistant. {description}"
            }
        
        if isinstance(icon_result, Exception):
            logger.error(f"Error in icon generation: {icon_result}")
            icon_result = {
                "icon_name": "bot",
                "icon_color": "#FFFFFF",
                "icon_background": "#6366F1"
            }
        
        # Combine results
        result = {
            "name": name_prompt_result.get("name", "Custom Assistant"),
            "system_prompt": name_prompt_result.get("system_prompt", f"Act as a helpful AI assistant. {description}"),
            "icon_name": icon_result.get("icon_name", "bot"),
            "icon_color": icon_result.get("icon_color", "#FFFFFF"),
            "icon_background": icon_result.get("icon_background", "#6366F1")
        }
        
        logger.debug(f"Generated config: name='{result['name']}', icon={result['icon_name']}")
        return result
        
    except Exception as e:
        logger.error(f"Error generating agent config: {str(e)}")
        return {
            "name": "Custom Assistant",
            "system_prompt": f"Act as a helpful AI assistant. {description}",
            "icon_name": "bot",
            "icon_color": "#FFFFFF",
            "icon_background": "#6366F1"
        }


@router.post("/agents/setup-from-chat", response_model=AgentSetupFromChatResponse, summary="Setup Agent from Chat Description", operation_id="setup_agent_from_chat")
async def setup_agent_from_chat(
    request: AgentSetupFromChatRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Create and configure a new worker based on a natural language description.
    Uses AI to generate appropriate name, system prompt, icon, and colors.
    """
    logger.info(f"Setting up worker from chat for user {user_id}")
    
    if not request.description.strip():
        raise HTTPException(status_code=400, detail="Description cannot be empty")
    
    client = await utils.db.client
    
    # Check agent count limit
    from .core_utils import check_agent_count_limit
    limit_check = await check_agent_count_limit(client, user_id)
    
    if not limit_check['can_create']:
        error_detail = {
            "message": f"Maximum of {limit_check['limit']} workers allowed for your current plan. You have {limit_check['current_count']} agents.",
            "current_count": limit_check['current_count'],
            "limit": limit_check['limit'],
            "tier_name": limit_check['tier_name'],
            "error_code": "AGENT_LIMIT_EXCEEDED"
        }
        logger.warning(f"Agent limit exceeded for account {user_id}")
        raise HTTPException(status_code=402, detail=error_detail)
    
    try:
        # Generate complete agent configuration (name, prompt, icon, colors) in one LLM call
        config = await generate_agent_config_from_description(request.description)
        agent_name = config['name']
        system_prompt = config['system_prompt']
        
        # Create agent in database
        insert_data = {
            "account_id": user_id,
            "name": agent_name,
            "icon_name": config["icon_name"],
            "icon_color": config["icon_color"],
            "icon_background": config["icon_background"],
            "is_default": False,
            "version_count": 1
        }
        
        new_agent = await client.table('agents').insert(insert_data).execute()
        
        if not new_agent.data:
            raise HTTPException(status_code=500, detail="Failed to create worker")
        
        agent = new_agent.data[0]
        agent_id = agent['agent_id']
        
        # Create initial version with generated system prompt
        try:
            version_service = await _get_version_service()
            agentpress_tools = ensure_core_tools_enabled(_get_default_agentpress_tools())
            default_model = await model_manager.get_default_model_for_user(client, user_id)
            
            version = await version_service.create_version(
                agent_id=agent_id,
                user_id=user_id,
                system_prompt=system_prompt,
                model=default_model,
                configured_mcps=[],
                custom_mcps=[],
                agentpress_tools=agentpress_tools,
                version_name="v1",
                change_description="Initial version - created from chat"
            )
        except Exception as e:
            logger.error(f"Error creating initial version: {str(e)}")
            # Rollback: delete the agent if version creation fails
            await client.table('agents').delete().eq('agent_id', agent_id).execute()
            raise HTTPException(status_code=500, detail="Failed to create initial version")
        
        # Update agent with current version
        await client.table('agents').update({
            "current_version_id": version.version_id
        }).eq("agent_id", agent_id).execute()
        
        # Invalidate cache
        from core.utils.cache import Cache
        await Cache.invalidate(f"agent_count_limit:{user_id}")
        
        logger.info(f"Successfully created agent '{agent_name}' (ID: {agent_id}) from chat description")
        
        return AgentSetupFromChatResponse(
            agent_id=agent_id,
            name=agent_name,
            system_prompt=system_prompt,
            icon_name=config["icon_name"],
            icon_color=config["icon_color"],
            icon_background=config["icon_background"]
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error setting up agent from chat: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to setup agent: {str(e)}")
