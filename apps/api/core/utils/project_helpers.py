"""Project-related helper functions.

CONVEX MIGRATION STATUS: MIGRATED - USING HTTP FOR PROJECTS TABLE
=================================================================
This module uses HTTP calls to Supabase REST API for the 'projects' table
which is not yet in the Convex schema. The Convex schema currently includes:
- threads, agents, messages, memories, triggers

No Supabase client imports - uses direct HTTP calls instead.

TODO: Add 'projects' table to Convex schema for full migration.
"""
import json
import traceback
import httpx
from core.utils.config import config
from core.services.llm import make_llm_api_call
from core.utils.logger import logger
from core.utils.icon_generator import RELEVANT_ICONS

# Project categories for analytics classification (based on actual usage data)
PROJECT_CATEGORIES = [
    "Research & Information Gathering",
    "Business & Marketing",
    "Code & Programming",
    "Web Development",
    "Content Creation",
    "Presentations",
    "Image Generation",
    "Other"
]


async def _get_supabase_client():
    """Get HTTP client configured for Supabase REST API."""
    supabase_url = config.SUPABASE_URL
    supabase_service_key = config.SUPABASE_SERVICE_ROLE_KEY

    if not supabase_url or not supabase_service_key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured")

    return httpx.AsyncClient(
        base_url=f"{supabase_url}/rest/v1",
        headers={
            "apikey": supabase_service_key,
            "Authorization": f"Bearer {supabase_service_key}",
            "Content-Type": "application/json"
        },
        timeout=10.0
    )


async def generate_and_update_project_name(project_id: str, prompt: str):
    """
    Generates a project name and icon using an LLM and updates the database via HTTP.

    Category is set separately by the periodic categorization job after 30 mins of inactivity.

    Args:
        project_id: The project ID to update
        prompt: The initial user prompt to base the name/icon on
    """
    logger.info(f"Starting background task to generate name and icon for project: {project_id}")

    try:
        model_name = "openai/gpt-5-nano-2025-08-07"

        relevant_icons = RELEVANT_ICONS
        system_prompt = f"""You are a helpful assistant that generates extremely concise titles (2-4 words maximum) and selects appropriate icons for chat threads.

        Available Lucide React icons to choose from:
        {', '.join(relevant_icons)}

        Respond with a JSON object containing:
        - "title": A concise 2-4 word title for the thread
        - "icon": The most appropriate icon name from the list above

        Example response:
        {{"title": "Code Review Help", "icon": "code"}}"""

        user_message = f"Generate an extremely brief title (2-4 words only) and select the most appropriate icon for this chat thread that starts with this message: \"{prompt}\""
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}]

        logger.debug(f"Calling LLM ({model_name}) for project {project_id} naming and icon selection.")
        response = await make_llm_api_call(
            messages=messages,
            model_name=model_name,
            max_tokens=1000,
            temperature=0.7,
            response_format={"type": "json_object"},
            stream=False
        )

        generated_name = None
        selected_icon = None

        if response and response.get('choices') and response['choices'][0].get('message'):
            raw_content = response['choices'][0]['message'].get('content', '').strip()
            try:
                parsed_response = json.loads(raw_content)

                if isinstance(parsed_response, dict):
                    title = parsed_response.get('title', '').strip()
                    if title:
                        generated_name = title.strip('\'" \n\t')
                        logger.debug(f"LLM generated name for project {project_id}: '{generated_name}'")

                    icon = parsed_response.get('icon', '').strip()
                    if icon and icon in relevant_icons:
                        selected_icon = icon
                        logger.debug(f"LLM selected icon for project {project_id}: '{selected_icon}'")
                    else:
                        logger.warning(f"LLM selected invalid icon '{icon}' for project {project_id}, using default 'message-circle'")
                        selected_icon = "message-circle"
                else:
                    logger.warning(f"LLM returned non-dict JSON for project {project_id}: {parsed_response}")

            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse LLM JSON response for project {project_id}: {e}. Raw content: {raw_content}")
                cleaned_content = raw_content.strip('\'" \n\t{}')
                if cleaned_content:
                    generated_name = cleaned_content[:50]
                selected_icon = "message-circle"
        else:
            logger.warning(f"Failed to get valid response from LLM for project {project_id} naming. Response: {response}")

        if generated_name:
            update_data = {"name": generated_name}
            if selected_icon:
                update_data["icon_name"] = selected_icon

            logger.info(f"Storing project {project_id} with title: '{generated_name}', icon: '{selected_icon}'")

            # Update via HTTP to Supabase REST API
            try:
                async with await _get_supabase_client() as client:
                    response = await client.patch(
                        f"/projects?project_id=eq.{project_id}",
                        json=update_data,
                        headers={"Prefer": "return=minimal"}
                    )
                    response.raise_for_status()
                    logger.debug(f"Successfully updated project {project_id} with title and icon")
            except Exception as e:
                logger.error(f"Failed to update project {project_id} in database: {e}")
        else:
            logger.warning(f"No generated name, skipping database update for project {project_id}.")

    except Exception as e:
        logger.error(f"Error in background naming task for project {project_id}: {str(e)}\n{traceback.format_exc()}")
    finally:
        logger.debug(f"Finished background naming and icon selection task for project: {project_id}")
