"""
Test script for running the AgentPress agent with thinking enabled.

This test specifically targets Anthropic models that support the 'reasoning_effort'
parameter to observe the agent's behavior when thinking is explicitly enabled.
"""

import asyncio
import json
import os
import sys
import traceback
from dotenv import load_dotenv

# Ensure the backend directory is in the Python path
backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import logging
from agentpress.thread_manager import ThreadManager
from services.supabase import DBConnection
from agent.run import run_agent, process_agent_response # Reuse processing logic
from utils.logger import logger

logger.setLevel(logging.DEBUG)

async def test_agent_with_thinking():
    """
    Test running the agent with thinking enabled for an Anthropic model.
    """
    print("\n" + "="*80)
    print("🧪 TESTING AGENT RUN WITH THINKING ENABLED (Anthropic)")
    print("="*80 + "\n")

    # Load environment variables
    load_dotenv()

    # Initialize ThreadManager and DBConnection
    thread_manager = ThreadManager()
    db_connection = DBConnection()
    await db_connection.initialize() # Ensure connection is ready
    client = await db_connection.client

    thread_id = None
    project_id = None
    project_created = False # Flag to track if we created the project

    try:
        # --- Test Setup ---
        print("🔧 Setting up test environment (Project & Thread)...")
        logger.info("Setting up test project and thread...")

        # Using a hardcoded account ID for consistency in tests
        account_id = "a5fe9cb6-4812-407e-a61c-fe95b7320c59" # Replace if necessary
        test_project_name = "test_agent_thinking_project"
        logger.info(f"Using Account ID: {account_id}")

        if not account_id:
            print("❌ Error: Could not determine Account ID.")
            logger.error("Could not determine Account ID.")
            return

        # Find or create a test project
        project_result = await client.table('projects').select('*').eq('name', test_project_name).eq('account_id', account_id).limit(1).execute()

        if project_result.data:
            project_id = project_result.data[0]['project_id']
            print(f"🔄 Using existing test project: {project_id}")
            logger.info(f"Using existing test project: {project_id}")
        else:
            project_insert_result = await client.table('projects').insert({
                "name": test_project_name,
                "account_id": account_id
            }).execute()
            if not project_insert_result.data:
                 print("❌ Error: Failed to create test project.")
                 logger.error("Failed to create test project.")
                 return
            project_id = project_insert_result.data[0]['project_id']
            project_created = True
            print(f"✨ Created new test project: {project_id}")
            logger.info(f"Created new test project: {project_id}")

        # Create a new thread for this test run
        thread_result = await client.table('threads').insert({
            'project_id': project_id,
            'account_id': account_id
        }).execute()

        if not thread_result.data:
            print("❌ Error: Failed to create test thread.")
            logger.error("Failed to create test thread.")
            return

        thread_id = thread_result.data[0]['thread_id']
        print(f"🧵 Created new test thread: {thread_id}")
        logger.info(f"Test Thread Created: {thread_id}")

        # Add an initial user message that requires planning
        initial_message = "Create a plan to build a simple 'Hello World' HTML page in the workspace, then execute the first step of the plan."
        print(f"\n💬 Adding initial user message: '{initial_message}'")
        logger.info(f"Adding initial user message: '{initial_message}'")
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

        # --- Run Agent with Thinking Enabled ---
        logger.info("Running agent ...")

        # Use the process_agent_response helper to handle streaming output.
        # Pass the desired model, thinking, and stream parameters directly to it.
        await process_agent_response(
            thread_id=thread_id,
            project_id=project_id,
            thread_manager=thread_manager,
            stream=False, # Explicitly set stream to True for testing
            model_name="anthropic/claude-3-7-sonnet-latest", # Specify the model here
            enable_thinking=True,                         # Enable thinking here
            reasoning_effort='low'                        # Specify effort here
        )
        # await process_agent_response(
            # thread_id=thread_id,
            # project_id=project_id,
            # thread_manager=thread_manager,
            # model_name="openai/gpt-4.1-2025-04-14", # Specify the model here
            # model_name="groq/llama-3.3-70b-versatile",
            # enable_thinking=False,                         # Enable thinking here
            # reasoning_effort='low'                        # Specify effort here
        # )

        # --- Direct Stream Processing (Alternative to process_agent_response) ---
        # The direct run_agent call above was removed as process_agent_response handles it.
        # print("\n--- Agent Response Stream ---")
        # async for chunk in agent_run_generator:
        #     chunk_type = chunk.get('type', 'unknown')
        #     if chunk_type == 'content' and 'content' in chunk:
        #         print(chunk['content'], end='', flush=True)
        #     elif chunk_type == 'tool_result':
        #         tool_name = chunk.get('function_name', 'Tool')
        #         result = chunk.get('result', '')
        #         print(f"\n\n🛠️ TOOL RESULT [{tool_name}] → {result}", flush=True)
        #     elif chunk_type == 'tool_status':
        #         status = chunk.get('status', '')
        #         func_name = chunk.get('function_name', '')
        #         if status and func_name:
        #             emoji = "✅" if status == "completed" else "⏳" if status == "started" else "❌"
        #             print(f"\n{emoji} TOOL {status.upper()}: {func_name}", flush=True)
        #     elif chunk_type == 'finish':
        #         reason = chunk.get('finish_reason', '')
        #         if reason:
        #             print(f"\n📌 Finished: {reason}", flush=True)
        #     elif chunk_type == 'error':
        #         print(f"\n❌ ERROR: {chunk.get('message', 'Unknown error')}", flush=True)
        #         break # Stop processing on error

        print("\n\n✅ Agent run finished.")
        logger.info("Agent run finished.")

    except Exception as e:
        print(f"\n❌ An error occurred during the test: {e}")
        logger.error(f"An error occurred during the test: {str(e)}", exc_info=True)
        traceback.print_exc()
    finally:
        # --- Cleanup ---
        print("\n🧹 Cleaning up test resources...")
        logger.info("Cleaning up test resources...")
        if thread_id:
            try:
                await client.table('messages').delete().eq('thread_id', thread_id).execute()
                await client.table('threads').delete().eq('thread_id', thread_id).execute()
                print(f"🗑️ Deleted test thread: {thread_id}")
                logger.info(f"Deleted test thread: {thread_id}")
            except Exception as e:
                print(f"⚠️ Error cleaning up thread {thread_id}: {e}")
                logger.warning(f"Error cleaning up thread {thread_id}: {e}")
        if project_id and project_created: # Only delete if we created it in this run
            try:
                await client.table('projects').delete().eq('project_id', project_id).execute()
                print(f"🗑️ Deleted test project: {project_id}")
                logger.info(f"Deleted test project: {project_id}")
            except Exception as e:
                print(f"⚠️ Error cleaning up project {project_id}: {e}")
                logger.warning(f"Error cleaning up project {project_id}: {e}")

        # Disconnect DB
        await db_connection.disconnect()
        logger.info("Database connection closed.")

    print("\n" + "="*80)
    print("🏁 THINKING TEST COMPLETE")
    print("="*80 + "\n")


if __name__ == "__main__":
    # Ensure the logger is configured
    logger.info("Starting test_agent_thinking script...")
    try:
        asyncio.run(test_agent_with_thinking())
        print("\n✅ Test script completed successfully.")
        sys.exit(0)
    except KeyboardInterrupt:
        print("\n\n❌ Test interrupted by user.")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ Error running test script: {e}")
        traceback.print_exc()
        sys.exit(1)
