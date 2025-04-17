"""
Automated test script for the AgentPress agent.

This script sends a specific query ("short report for today's news") to the agent
and prints the streaming output to the console.
"""

import asyncio
from dotenv import load_dotenv

from agentpress.thread_manager import ThreadManager
from services.supabase import DBConnection
from agent.run import process_agent_response  # Reusing the processing logic
from utils.logger import logger

async def main():
    """Main function to run the automated agent test."""
    load_dotenv()  # Ensure environment variables are loaded

    logger.info("--- Starting Automated Agent Test: News Report ---")

    # Initialize ThreadManager and DBConnection
    thread_manager = ThreadManager()
    db_connection = DBConnection()
    await db_connection.initialize() # Ensure connection is ready
    client = await db_connection.client

    project_id = None
    thread_id = None

    try:
        # 1. Set up Test Project and Thread
        logger.info("Setting up test project and thread...")

        # Get user's personal account (replace with actual logic if needed)
        # Using a fixed account ID for simplicity in this example
        # In a real scenario, you might fetch this dynamically
        account_id = "a5fe9cb6-4812-407e-a61c-fe95b7320c59" # Example account ID
        test_project_name = "automated_test_project_news"

        if not account_id:
            logger.error("Error: Could not determine account ID.")
            return

        # Find or create a test project
        project_result = await client.table('projects').select('*').eq('name', test_project_name).eq('account_id',
account_id).limit(1).execute()

        if project_result.data:
            project_id = project_result.data[0]['project_id']
            logger.info(f"Using existing test project: {project_id}")
        else:
            project_insert_result = await client.table('projects').insert({
                "name": test_project_name,
                "account_id": account_id
            }).execute()
            if not project_insert_result.data:
                 logger.error("Failed to create test project.")
                 return
            project_id = project_insert_result.data[0]['project_id']
            logger.info(f"Created new test project: {project_id}")

        # Create a new thread for this test run
        thread_result = await client.table('threads').insert({
            'project_id': project_id,
            'account_id': account_id
            # 'name': f"Test Run - News Report - {asyncio.get_event_loop().time()}" # Removed name field
        }).execute()

        if not thread_result.data:
            logger.error("Error: Failed to create test thread.")
            return

        thread_id = thread_result.data[0]['thread_id']
        logger.info(f"Test Thread Created: {thread_id}")

        # 2. Define and Add User Message
        user_message = "short report for today's news"
        logger.info(f"Adding user message to thread: '{user_message}'")
        await thread_manager.add_message(
            thread_id=thread_id,
            type="user",
            content={
                "role": "user",
                "content": user_message
            },
            is_llm_message=True # Treat it as a message the LLM should see
        )

        # 3. Run the Agent and Process Response
        logger.info("Running agent and processing response...")
        # We reuse the process_agent_response function from run.py which handles the streaming output
        await process_agent_response(thread_id, project_id, thread_manager)

        logger.info("--- Agent Test Completed ---")

    except Exception as e:
        logger.error(f"An error occurred during the test: {str(e)}", exc_info=True)
    finally:
        # Optional: Clean up the created thread?
        # if thread_id:
        #     logger.info(f"Cleaning up test thread: {thread_id}")
        #     await client.table('messages').delete().eq('thread_id', thread_id).execute()
        #     await client.table('threads').delete().eq('thread_id', thread_id).execute()

        # Disconnect DB
        await db_connection.disconnect()
        logger.info("Database connection closed.")


if __name__ == "__main__":
    # Configure logging if needed (e.g., set level)
    # logging.getLogger('agentpress').setLevel(logging.DEBUG)

    # Run the main async function
    asyncio.run(main())
