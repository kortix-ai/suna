#!/usr/bin/env python3
"""
Test script for Convex Python client.

Usage:
    cd /Users/alias/Documents/aeos/suna/apps/api
    CONVEX_URL=https://disciplined-tiger-449.convex.site CONVEX_API_KEY=dev_suna_api_key_2024 python test_convex_client.py
"""

import asyncio
import os
import sys
import time
from datetime import datetime

# Add the parent directory to the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core.services.convex_client import (
    ConvexClient,
    ConvexError,
    NotFoundError,
    get_convex_client,
    close_convex_client
)

BASE_URL = os.getenv("CONVEX_URL", "https://disciplined-tiger-449.convex.site")
API_KEY = os.getenv("CONVEX_API_KEY", "dev_suna_api_key_2024")

# Test counters
PASSED = 0
FAILED = 0


async def test(name: str, coro):
    """Run a test and track results."""
    global PASSED, FAILED
    try:
        result = await coro
        print(f"✅ {name}")
        PASSED += 1
        return result
    except Exception as e:
        print(f"❌ {name}: {e}")
        FAILED += 1
        return None


async def main():
    print("═══════════════════════════════════════════════════════════════")
    print(f"    CONVEX PYTHON CLIENT TEST SUITE - {datetime.now()}")
    print("═══════════════════════════════════════════════════════════════")
    print()
    print(f"Base URL: {BASE_URL}")
    print()

    client = ConvexClient(BASE_URL, API_KEY)
    ts = int(time.time())

    try:
        # ─────────────────────────────────────────────────────────────────
        # 1. THREADS
        # ─────────────────────────────────────────────────────────────────
        print("─────────────────────────────────────────────────────────────────")
        print("1. THREADS API")
        print("─────────────────────────────────────────────────────────────────")

        thread = await test("Create Thread", client.create_thread(
            thread_id=f"py_test_thread_{ts}",
            account_id=f"py_test_account_{ts}",
            metadata={"source": "python_test"}
        ))

        await test("Get Thread", client.get_thread(f"py_test_thread_{ts}"))

        await test("List Threads", client.list_threads(
            account_id=f"py_test_account_{ts}",
            limit=10
        ))

        # ─────────────────────────────────────────────────────────────────
        # 2. MESSAGES
        # ─────────────────────────────────────────────────────────────────
        print()
        print("─────────────────────────────────────────────────────────────────")
        print("2. MESSAGES API")
        print("─────────────────────────────────────────────────────────────────")

        await test("Add Message", client.add_message(
            message_id=f"py_test_msg_{ts}",
            thread_id=f"py_test_thread_{ts}",
            message_type="user",
            content="Hello from Python client!",
            is_llm_message=True
        ))

        await test("Get Messages", client.get_messages(
            thread_id=f"py_test_thread_{ts}"
        ))

        # ─────────────────────────────────────────────────────────────────
        # 3. AGENTS
        # ─────────────────────────────────────────────────────────────────
        print()
        print("─────────────────────────────────────────────────────────────────")
        print("3. AGENTS API")
        print("─────────────────────────────────────────────────────────────────")

        await test("Create Agent", client.create_agent(
            agent_id=f"py_test_agent_{ts}",
            account_id=f"py_test_account_{ts}",
            name="Python Test Agent",
            description="Agent created from Python test",
            system_prompt="You are a test agent."
        ))

        await test("List Agents", client.list_agents(
            account_id=f"py_test_account_{ts}"
        ))

        # ─────────────────────────────────────────────────────────────────
        # 4. AGENT RUNS
        # ─────────────────────────────────────────────────────────────────
        print()
        print("─────────────────────────────────────────────────────────────────")
        print("4. AGENT RUNS API")
        print("─────────────────────────────────────────────────────────────────")

        await test("Create Agent Run", client.create_agent_run(
            run_id=f"py_test_run_{ts}",
            thread_id=f"py_test_thread_{ts}",
            status="queued"
        ))

        await test("Get Agent Run", client.get_agent_run(
            run_id=f"py_test_run_{ts}"
        ))

        await test("Update Agent Run", client.update_agent_run(
            run_id=f"py_test_run_{ts}",
            status="running"
        ))

        await test("Update Agent Run (complete)", client.update_agent_run(
            run_id=f"py_test_run_{ts}",
            status="completed",
            metadata={"completed_at": datetime.now().isoformat()}
        ))

        # ─────────────────────────────────────────────────────────────────
        # 5. MEMORIES
        # ─────────────────────────────────────────────────────────────────
        print()
        print("─────────────────────────────────────────────────────────────────")
        print("5. MEMORIES API")
        print("─────────────────────────────────────────────────────────────────")

        await test("Store Memory", client.store_memory(
            memory_space_id=f"py_test_space_{ts}",
            content="This is a test memory from Python",
            source_type="system"  # Valid values: conversation, system, tool, a2a, fact-extraction
        ))

        await test("Search Memories", client.search_memories(
            memory_space_id=f"py_test_space_{ts}",
            query="test memory"
        ))

        await test("List Memories", client.list_memories(
            memory_space_id=f"py_test_space_{ts}"
        ))

        # ─────────────────────────────────────────────────────────────────
        # 6. FACTS
        # ─────────────────────────────────────────────────────────────────
        print()
        print("─────────────────────────────────────────────────────────────────")
        print("6. FACTS API")
        print("─────────────────────────────────────────────────────────────────")

        await test("Store Fact", client.store_fact(
            memory_space_id=f"py_test_space_{ts}",
            fact="Python is a programming language",
            fact_type="knowledge"
        ))

        await test("List Facts", client.list_facts(
            memory_space_id=f"py_test_space_{ts}"
        ))

        # ─────────────────────────────────────────────────────────────────
        # 7. TRIGGERS
        # ─────────────────────────────────────────────────────────────────
        print()
        print("─────────────────────────────────────────────────────────────────")
        print("7. TRIGGERS API")
        print("─────────────────────────────────────────────────────────────────")

        await test("Create Trigger", client.create_trigger(
            trigger_id=f"py_test_trigger_{ts}",
            agent_id=f"py_test_agent_{ts}",
            trigger_type="manual",
            name="Python Test Trigger"
        ))

        await test("List Triggers", client.list_triggers(
            agent_id=f"py_test_agent_{ts}"
        ))

    finally:
        await client.close()

    # ─────────────────────────────────────────────────────────────────────
    # SUMMARY
    # ─────────────────────────────────────────────────────────────────────
    print()
    print("═══════════════════════════════════════════════════════════════")
    print("                      TEST SUMMARY")
    print("═══════════════════════════════════════════════════════════════")
    print()
    print(f"  ✅ Passed: {PASSED}")
    print(f"  ❌ Failed: {FAILED}")
    print(f"  📊 Total:  {PASSED + FAILED}")
    print()

    if FAILED == 0:
        print("🎉 ALL TESTS PASSED!")
        return 0
    else:
        print("⚠️ Some tests failed")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
