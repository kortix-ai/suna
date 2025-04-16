import asyncio
import json
import os
import sys
import traceback
from dotenv import load_dotenv
load_dotenv()

# Ensure the backend directory is in the Python path
backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import logging # Import logging module
from agentpress.thread_manager import ThreadManager
from services.supabase import DBConnection
from agent.run import run_agent
from utils.logger import logger

# Set logging level to DEBUG specifically for this test script
logger.setLevel(logging.DEBUG)
# Optionally, adjust handler levels if needed (e.g., for console output)
for handler in logger.handlers:
    if isinstance(handler, logging.StreamHandler): # Target console handler
        handler.setLevel(logging.DEBUG)

async def test_agent_limited_iterations():
    """
    Test running the agent for a maximum of 3 iterations in non-streaming mode
    and print the collected response chunks.
    """
    print("\n" + "="*80)
    print("🧪 TESTING AGENT RUN WITH MAX ITERATIONS (max_iterations=3, stream=False)")
    print("="*80 + "\n")

    # Load environment variables
    load_dotenv()

    # Initialize ThreadManager and DBConnection
    thread_manager = ThreadManager()
    db_connection = DBConnection()
    client = await db_connection.client

    thread_id = None
    project_id = None

    try:
        # --- Test Setup ---
        print("🔧 Setting up test environment (Project & Thread)...")

        # Get user's personal account (replace with a specific test account if needed)
        # Using a hardcoded account ID for consistency in tests
        account_id = "a5fe9cb6-4812-407e-a61c-fe95b7320c59" # Replace if necessary
        logger.info(f"Using Account ID: {account_id}")

        if not account_id:
            print("❌ Error: Could not determine Account ID.")
            return

        # Find or create a test project
        project_name = "test_simple_dat"
        project_result = await client.table('projects').select('*').eq('name', project_name).eq('account_id', account_id).execute()

        if project_result.data and len(project_result.data) > 0:
            project_id = project_result.data[0]['project_id']
            print(f"🔄 Using existing test project: {project_id}")
        else:
            project_result = await client.table('projects').insert({
                "name": project_name,
                "account_id": account_id
            }).execute()
            project_id = project_result.data[0]['project_id']
            print(f"✨ Created new test project: {project_id}")

        # Create a new thread for this test
        thread_result = await client.table('threads').insert({
            'project_id': project_id,
            'account_id': account_id
        }).execute()
        thread_id = thread_result.data[0]['thread_id']
        print(f"🧵 Created new test thread: {thread_id}")

        # Add an initial user message to kick off the agent
        initial_message = ("Hello " * 123) + "\\n\\nHow many times did the word 'Hello' appear in the previous text?"
        print(f"\\n💬 Adding initial user message: Preview='{initial_message[:50]}...'") # Print only a preview
        await thread_manager.add_message(
            thread_id=thread_id,
            type="user",
            content={
                "role": "user",
                "content": initial_message
            },
            is_llm_message=True
        )
        print("✅ Initial message added.")

        # --- Run Agent ---
        print("\n🔄 Running agent (max_iterations=3, stream=False)...")
        all_chunks = []
        agent_run_generator = run_agent(
            thread_id=thread_id,
            project_id=project_id,
            stream=False,  # Non-streaming
            thread_manager=thread_manager,
            max_iterations=5 # Limit iterations
        )

        async for chunk in agent_run_generator:
            chunk_type = chunk.get('type', 'unknown')
            print(f"  📦 Received chunk: type='{chunk_type}'")
            all_chunks.append(chunk)

        print("\n✅ Agent run finished.")

        # --- Print Results ---
        print("\n📄 Full collected response chunks:")
        # Use json.dumps for pretty printing the list of dictionaries
        print(json.dumps(all_chunks, indent=2, default=str)) # Use default=str for non-serializable types like datetime

    except Exception as e:
        print(f"\n❌ An error occurred during the test: {e}")
        traceback.print_exc()
    finally:
        # Optional: Clean up the created thread and project
        print("\n🧹 Cleaning up test resources...")
        if thread_id:
            await client.table('threads').delete().eq('thread_id', thread_id).execute()
            print(f"🗑️ Deleted test thread: {thread_id}")
        if project_id and not project_result.data: # Only delete if we created it
            await client.table('projects').delete().eq('project_id', project_id).execute()
            print(f"🗑️ Deleted test project: {project_id}")

    print("\n" + "="*80)
    print("🏁 TEST COMPLETE")
    print("="*80 + "\n")


if __name__ == "__main__":
    # Ensure the logger is configured
    logger.info("Starting test_agent_max_iterations script...")
    try:
        asyncio.run(test_agent_limited_iterations())
        print("\n✅ Test script completed successfully.")
        sys.exit(0)
    except KeyboardInterrupt:
        print("\n\n❌ Test interrupted by user.")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ Error running test script: {e}")
        traceback.print_exc()
        sys.exit(1)

# before result 
# 2025-04-16 19:20:20,494 - DEBUG - Response: ModelResponse(id='chatcmpl-2c5c1418-4570-435c-8d31-5c7ef63a1a68', created=1744827620, model='claude-3-7-sonnet-20250219', object='chat.completion', system_fingerprint=None, choices=[Choices(finish_reason='stop', index=0, message=Message(content='I\'ll update the existing todo.md file and then proceed with counting the "Hello" occurrences.\n\n<full-file-rewrite file_path="todo.md">\n# Hello Count Task\n\n## Setup\n- [ ] Create a file to store the input text\n- [ ] Create a script to count occurrences of "Hello"\n\n## Analysis\n- [ ] Run the script to count occurrences\n- [ ] Verify the results\n\n## Delivery\n- [ ] Provide the final count to the user\n</full-file-rewrite>', role='assistant', tool_calls=None, function_call=None, provider_specific_fields={'citations': None, 'thinking_blocks': None}))], usage=Usage(completion_tokens=125, prompt_tokens=14892, total_tokens=15017, completion_tokens_details=None, prompt_tokens_details=PromptTokensDetailsWrapper(audio_tokens=None, cached_tokens=0, text_tokens=None, image_tokens=None), cache_creation_input_tokens=0, cache_read_input_tokens=0))



# after result
# read cache should > 0 (and it does)