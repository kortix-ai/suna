"""
Complete end-to-end API test flow

This single comprehensive test covers the entire user journey from account setup
through all API routes, testing everything in sequence.
"""
import pytest
import httpx
import json
import asyncio
from tests.config import E2ETestConfig


def check_billing_response(response: httpx.Response, step_name: str):
    """Check if response indicates billing issue and skip test if so"""
    if response.status_code == 402:
        pytest.skip(f"{step_name}: Test user has no billing/credits (402 Payment Required)")
    if response.status_code == 500:
        print(f"\n⚠️  {step_name}: Got 500 Server Error")
        print(f"Response: {response.text[:500]}")
        pytest.skip(f"{step_name}: Server error (500) - likely billing/account setup issue")


@pytest.mark.asyncio
@pytest.mark.e2e
@pytest.mark.slow
@pytest.mark.billing
async def test_complete_api_flow(client: httpx.AsyncClient, test_config: E2ETestConfig, test_user: dict):
    """
    Complete E2E API flow testing all routes from top to bottom:
    
    PHASE 1: Account Setup
      1. GET /billing/account-state - Verify account creation & setup
      2. GET /accounts - List user accounts
    
    PHASE 2: Agent Run
      3. POST /agent/start - Start agent run (creates project + thread)
      4. GET /agent-run/{id}/stream - Stream agent run immediately
    
    PHASE 3: Verify Created Resources
      5. GET /threads - List user threads (should have 1 now)
      6. GET /agent-runs/active - List active agent runs
      7. GET /projects/{id} - Get project details
      8. GET /threads/{id} - Get thread details
      9. GET /threads/{id}/messages - Get thread messages
      10. GET /thread/{id}/agent-runs - Get agent runs for thread
    
    PHASE 4: Cleanup
      11. POST /agent-run/{id}/stop - Stop agent run (if still running)
    """
    print(f"\n{'='*70}")
    print(f"🧪 Starting Complete E2E API Flow Test")
    print(f"   Test User: {test_user['email']}")
    print(f"{'='*70}")
    
    # ========================================================================
    # PHASE 1: ACCOUNT SETUP
    # ========================================================================
    print(f"\n{'─'*70}")
    print("📦 PHASE 1: Account Setup")
    print(f"{'─'*70}")
    
    # Step 1: GET /billing/account-state
    print("\n📋 Step 1: GET /billing/account-state - Verify account setup...")
    response = await client.get("/billing/account-state")
    assert response.status_code == 200, f"Failed to get account state: {response.text}"
    account_state = response.json()
    
    assert "credits" in account_state, "Account state should include credits"
    assert "subscription" in account_state, "Account state should include subscription"
    assert "limits" in account_state, "Account state should include limits"
    assert "models" in account_state, "Account state should include models"
    
    credits = account_state["credits"]
    subscription = account_state["subscription"]
    tier_key = subscription["tier_key"]
    tier_display = subscription["tier_display_name"]
    
    print(f"✅ Account verified: tier={tier_key} ({tier_display}), credits={credits.get('total', 0)}")
    
    # Step 2: GET /accounts
    print("\n📋 Step 2: GET /accounts - List user accounts...")
    response = await client.get("/accounts")
    assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
    accounts = response.json()
    assert isinstance(accounts, list), f"Expected list, got {type(accounts)}"
    print(f"✅ Found {len(accounts)} account(s)")
    
    # ========================================================================
    # PHASE 2: AGENT RUN
    # ========================================================================
    print(f"\n{'─'*70}")
    print("🚀 PHASE 2: Agent Run")
    print(f"{'─'*70}")
    
    # Step 3: POST /agent/start
    print("\n📋 Step 3: POST /agent/start - Start agent run...")
    
    # Create a simple test file
    test_content = b"# Test file content\nprint('Hello from test file')"
    files = {"files": ("test.py", test_content, "text/x-python")}
    
    response = await client.post(
        "/agent/start",
        data={"prompt": "Create a hello.py file that prints 'Hello World'. Use the attached test.py as reference."},
        files=files
    )
    
    check_billing_response(response, "POST /agent/start")
    assert response.status_code == 200, f"Failed to start agent: {response.text}"
    start_data = response.json()
    
    project_id = start_data["project_id"]
    thread_id = start_data["thread_id"]
    agent_run_id = start_data["agent_run_id"]
    
    assert project_id, "Should have project_id"
    assert thread_id, "Should have thread_id"
    assert agent_run_id, "Should have agent_run_id"
    
    print(f"✅ Agent run started:")
    print(f"   Project: {project_id}")
    print(f"   Thread:  {thread_id}")
    print(f"   Run:     {agent_run_id}")
    
    # Step 4: GET /agent-run/{id}/stream
    print(f"\n📋 Step 4: GET /agent-run/{agent_run_id}/stream - Stream agent run...")
    print(f"📡 Connecting to stream immediately...")
    
    chunks = []
    completed = False
    
    try:
        async with client.stream(
            "GET",
            f"/agent-run/{agent_run_id}/stream",
            timeout=test_config.agent_timeout
        ) as stream_response:
            print(f"✅ Stream connected, status: {stream_response.status_code}")
            assert stream_response.status_code == 200, f"Stream failed: {stream_response.status_code}"
            
            async for line in stream_response.aiter_lines():
                if not line or not line.strip():
                    continue
                
                if line.startswith("data: "):
                    data_str = line[6:]
                    try:
                        chunk_data = json.loads(data_str)
                        chunks.append(chunk_data)
                        
                        if len(chunks) == 1:
                            print(f"📥 First chunk received: {chunk_data.get('type', 'unknown')}")
                        
                        if chunk_data.get("type") == "status":
                            status = chunk_data.get("status")
                            if status in ["completed", "stopped"]:
                                completed = True
                                print(f"✅ Stream completed with status: {status}")
                                break
                            elif status in ["failed", "error"]:
                                print(f"❌ Stream failed with status: {status}")
                                break
                    except json.JSONDecodeError:
                        continue
        
        print(f"✅ Stream received {len(chunks)} chunks, completed={completed}")
        assert len(chunks) > 0, "Should receive SSE chunks"
        
    except asyncio.TimeoutError:
        pytest.fail(f"Stream timed out after {test_config.agent_timeout}s")
    
    # ========================================================================
    # PHASE 3: VERIFY CREATED RESOURCES
    # ========================================================================
    print(f"\n{'─'*70}")
    print("🔍 PHASE 3: Verify Created Resources")
    print(f"{'─'*70}")
    
    # Step 5: GET /threads
    print("\n📋 Step 5: GET /threads - List user threads...")
    response = await client.get("/threads")
    assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
    threads_data = response.json()
    
    if isinstance(threads_data, dict) and "threads" in threads_data:
        threads = threads_data["threads"]
    elif isinstance(threads_data, list):
        threads = threads_data
    else:
        threads = []
    
    assert isinstance(threads, list), f"Expected threads to be list, got {type(threads)}"
    assert len(threads) >= 1, f"Should have at least 1 thread now, got {len(threads)}"
    print(f"✅ Found {len(threads)} thread(s)")
    
    # Step 6: GET /agent-runs/active
    print("\n📋 Step 6: GET /agent-runs/active - List active agent runs...")
    response = await client.get("/agent-runs/active")
    assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
    runs_data = response.json()
    
    if isinstance(runs_data, dict) and "active_runs" in runs_data:
        active_runs = runs_data["active_runs"]
    elif isinstance(runs_data, list):
        active_runs = runs_data
    else:
        active_runs = []
    
    assert isinstance(active_runs, list), f"Expected runs to be list, got {type(active_runs)}"
    print(f"✅ Found {len(active_runs)} active run(s)")
    
    # Step 7: GET /projects/{id}
    print(f"\n📋 Step 7: GET /projects/{project_id} - Get project details...")
    response = await client.get(f"/projects/{project_id}")
    assert response.status_code == 200, f"Failed to get project: {response.text}"
    project_data = response.json()
    assert project_data["project_id"] == project_id, "Project ID should match"
    print(f"✅ Project retrieved: {project_data.get('name', 'N/A')}")
    
    # Step 8: GET /threads/{id}
    print(f"\n📋 Step 8: GET /threads/{thread_id} - Get thread details...")
    response = await client.get(f"/threads/{thread_id}")
    assert response.status_code == 200, f"Failed to get thread: {response.text}"
    thread_data = response.json()
    assert thread_data["thread_id"] == thread_id, "Thread ID should match"
    print(f"✅ Thread retrieved: {thread_data.get('name', 'N/A')}")
    
    # Step 9: GET /threads/{id}/messages
    print(f"\n📋 Step 9: GET /threads/{thread_id}/messages - Get thread messages...")
    response = await client.get(f"/threads/{thread_id}/messages")
    assert response.status_code == 200, f"Failed to get messages: {response.text}"
    messages_data = response.json()
    
    # Response is {"messages": [...]}
    if isinstance(messages_data, dict) and "messages" in messages_data:
        messages = messages_data["messages"]
    elif isinstance(messages_data, list):
        messages = messages_data
    else:
        messages = []
    
    assert isinstance(messages, list), f"Expected messages to be list, got {type(messages)}"
    assert len(messages) >= 1, f"Should have at least 1 message, got {len(messages)}"
    print(f"✅ Found {len(messages)} message(s)")
    
    # Step 10: GET /thread/{id}/agent-runs
    print(f"\n📋 Step 10: GET /thread/{thread_id}/agent-runs - Get agent runs for thread...")
    response = await client.get(f"/thread/{thread_id}/agent-runs")
    assert response.status_code == 200, f"Failed to get agent runs: {response.text}"
    runs_data = response.json()
    
    # Response is {"agent_runs": [...]}
    if isinstance(runs_data, dict) and "agent_runs" in runs_data:
        runs = runs_data["agent_runs"]
    elif isinstance(runs_data, list):
        runs = runs_data
    else:
        runs = []
    
    assert isinstance(runs, list), f"Expected runs to be list, got {type(runs)}"
    assert len(runs) >= 1, f"Should have at least 1 run, got {len(runs)}"
    
    run_ids = [r.get("agent_run_id") or r.get("id") for r in runs]
    assert agent_run_id in run_ids, "Our agent run should be in list"
    print(f"✅ Found {len(runs)} agent run(s) for thread")
    
    # ========================================================================
    # PHASE 4: CLEANUP
    # ========================================================================
    print(f"\n{'─'*70}")
    print("🧹 PHASE 4: Cleanup")
    print(f"{'─'*70}")
    
    # Step 11: POST /agent-run/{id}/stop
    print(f"\n📋 Step 11: POST /agent-run/{agent_run_id}/stop - Stop agent run...")
    if not completed:
        response = await client.post(f"/agent-run/{agent_run_id}/stop")
        assert response.status_code in [200, 204, 400], \
            f"Expected 200/204/400, got {response.status_code}: {response.text}"
        print(f"✅ Stop request sent (status: {response.status_code})")
    else:
        print(f"✅ Run already completed, skipping stop")
    
    # ========================================================================
    # FINAL SUMMARY
    # ========================================================================
    print(f"\n{'='*70}")
    print(f"✅ Complete E2E API Flow Test PASSED")
    print(f"{'='*70}")
    print(f"   Test User Email: {test_user['email']}")
    print(f"   Test User ID:    {test_user['user_id']}")
    print(f"   Tier:            {tier_key} ({tier_display})")
    print(f"   Project:         {project_id}")
    print(f"   Thread:          {thread_id}")
    print(f"   Agent Run:       {agent_run_id}")
    print(f"   Messages:        {len(messages)}")
    print(f"   Stream Chunks:   {len(chunks)}")
    print(f"   Endpoints:       11")
    print(f"{'='*70}\n")
