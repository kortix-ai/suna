"""
Thread name generation utility
Uses the same LLM-based approach as project name generation
"""
import json
import traceback
from core.services.supabase import DBConnection
from core.services.llm import make_llm_api_call
from .logger import logger


async def generate_and_update_thread_name(thread_id: str, prompt: str):
    """
    Generates a thread name using the same LLM approach as project name generation.
    
    This uses the same model, temperature, and pattern as generate_and_update_project_name,
    but only generates the title (no icon/category).
    
    Args:
        thread_id: The thread ID to update
        prompt: The initial user prompt to base the name on
    """
    logger.info(f"Starting background task to generate name for thread: {thread_id}")
    
    try:
        # Use singleton - already initialized at startup
        db_conn = DBConnection()
        client = await db_conn.client

        # Use same model and approach as project name generation
        model_name = "openai/gpt-5-nano-2025-08-07"
        
        system_prompt = """You are a helpful assistant that generates extremely concise titles (2-4 words maximum) for chat threads based on the user's message.

Respond with a JSON object containing:
- "title": A concise 2-4 word title for the thread

Example responses:
{"title": "Code Review Help"}
{"title": "Build Todo App"}
{"title": "Research Paper"}
{"title": "Fix Bug"}

Keep titles short, descriptive, and action-oriented when appropriate."""

        user_message = f"Generate an extremely brief title (2-4 words only) for this chat thread that starts with this message: \"{prompt}\""
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}]

        logger.debug(f"Calling LLM ({model_name}) for thread {thread_id} naming.")
        response = await make_llm_api_call(
            messages=messages, 
            model_name=model_name, 
            max_tokens=200, 
            temperature=0.7,
            response_format={"type": "json_object"},
            stream=False
        )

        generated_name = None
        
        if response and response.get('choices') and response['choices'][0].get('message'):
            raw_content = response['choices'][0]['message'].get('content', '').strip()
            try:
                parsed_response = json.loads(raw_content)
                
                if isinstance(parsed_response, dict):
                    # Extract title
                    title = parsed_response.get('title', '').strip()
                    if title:
                        generated_name = title.strip('\'" \n\t')
                        logger.debug(f"LLM generated name for thread {thread_id}: '{generated_name}'")
                else:
                    logger.warning(f"LLM returned non-dict JSON for thread {thread_id}: {parsed_response}")
                    
            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse LLM JSON response for thread {thread_id}: {e}. Raw content: {raw_content}")
                # Fallback to extracting title from raw content
                cleaned_content = raw_content.strip('\'" \n\t{}')
                if cleaned_content:
                    generated_name = cleaned_content[:50]  # Limit fallback title length
        else:
            logger.warning(f"Failed to get valid response from LLM for thread {thread_id} naming. Response: {response}")

        if generated_name:
            logger.info(f"Storing thread {thread_id} with name: '{generated_name}'")
            
            update_result = await client.table('threads').update({"name": generated_name}).eq("thread_id", thread_id).execute()
            if hasattr(update_result, 'data') and update_result.data:
                logger.debug(f"Successfully updated thread {thread_id} with name")
            else:
                logger.error(f"Failed to update thread {thread_id} in database. Update result: {update_result}")
        else:
            logger.warning(f"No generated name, skipping database update for thread {thread_id}.")

    except Exception as e:
        logger.error(f"Error in background naming task for thread {thread_id}: {str(e)}\n{traceback.format_exc()}")
    finally:
        logger.debug(f"Finished background naming task for thread: {thread_id}")

