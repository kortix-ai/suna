#!/usr/bin/env python3
"""
Quick script to manually send a test message to Dramatiq worker.
Usage: uv run python test_send_dramatiq.py
"""
import dotenv
dotenv.load_dotenv('.env')

from run_agent_background import run_agent_background

print("🚀 Sending test message to Dramatiq...")
msg = run_agent_background.send(
    agent_run_id='manual-test-123',
    thread_id='test-thread',
    instance_id='terminal-manual',
    project_id='test-project',
    model_name='openai/gpt-5-mini',
    agent_id=None,
    account_id=None,
    request_id='cli-test'
)
print(f"✅ Message sent!")
print(f"   Message ID: {msg.message_id}")
print(f"   Queue: {msg.queue_name}")
print(f"   Actor: {msg.actor_name}")
print("\n👀 Check your worker logs to see it being processed!")


