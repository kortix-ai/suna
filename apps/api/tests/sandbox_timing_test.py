#!/usr/bin/env python3
"""
Sandbox Timing Test Script

Measures the actual time it takes to:
1. Create a new sandbox from scratch
2. Start a STOPPED sandbox
3. Start an ARCHIVED sandbox
4. Claim from pool (when pool has STARTED sandboxes)
5. Claim from pool (when pool has STOPPED sandboxes)

Run with: python -m tests.sandbox_timing_test
"""

import asyncio
import time
import uuid
import sys
import os

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

from daytona_sdk import AsyncDaytona, DaytonaConfig, CreateSandboxFromSnapshotParams, SandboxState, SessionExecuteRequest
from core.utils.config import config, Configuration
from core.utils.logger import logger

# Initialize Daytona client
daytona_config = DaytonaConfig(
    api_key=config.DAYTONA_API_KEY,
    api_url=config.DAYTONA_SERVER_URL,
    target=config.DAYTONA_TARGET,
)
daytona = AsyncDaytona(daytona_config)


class TimingResult:
    def __init__(self, operation: str):
        self.operation = operation
        self.start_time = None
        self.end_time = None
        self.duration_ms = None
        self.success = False
        self.error = None
        self.details = {}
    
    def start(self):
        self.start_time = time.time()
    
    def stop(self, success=True, error=None):
        self.end_time = time.time()
        self.duration_ms = (self.end_time - self.start_time) * 1000
        self.success = success
        self.error = error
    
    def __str__(self):
        status = "✅" if self.success else "❌"
        duration = f"{self.duration_ms:.0f}ms" if self.duration_ms else "N/A"
        error_str = f" - Error: {self.error}" if self.error else ""
        details_str = f" - {self.details}" if self.details else ""
        return f"{status} {self.operation}: {duration}{error_str}{details_str}"


async def test_create_sandbox() -> TimingResult:
    """Test: Create a brand new sandbox from scratch."""
    result = TimingResult("Create new sandbox")
    sandbox = None
    
    try:
        result.start()
        
        params = CreateSandboxFromSnapshotParams(
            snapshot=Configuration.SANDBOX_SNAPSHOT_NAME,
            public=True,
            labels={'test': 'timing_test'},
            env_vars={
                "VNC_PASSWORD": str(uuid.uuid4()),
                "ANONYMIZED_TELEMETRY": "false",
            },
            auto_stop_interval=15,
            auto_archive_interval=30,
        )
        
        sandbox = await daytona.create(params)
        result.details['sandbox_id'] = sandbox.id
        result.details['state'] = str(sandbox.state)
        
        result.stop(success=True)
        
    except Exception as e:
        result.stop(success=False, error=str(e))
    
    # Cleanup
    if sandbox:
        try:
            await daytona.delete(sandbox)
            print(f"   🗑️ Cleaned up sandbox {sandbox.id}")
        except Exception as e:
            print(f"   ⚠️ Failed to cleanup: {e}")
    
    return result


async def test_start_stopped_sandbox() -> TimingResult:
    """Test: Start a sandbox that is in STOPPED state."""
    result = TimingResult("Start STOPPED sandbox")
    sandbox = None
    
    try:
        # First create a sandbox
        print("   Creating sandbox for stop test...")
        params = CreateSandboxFromSnapshotParams(
            snapshot=Configuration.SANDBOX_SNAPSHOT_NAME,
            public=True,
            labels={'test': 'stop_test'},
            env_vars={"VNC_PASSWORD": str(uuid.uuid4())},
            auto_stop_interval=15,
            auto_archive_interval=30,
        )
        sandbox = await daytona.create(params)
        print(f"   Created sandbox {sandbox.id}, stopping it...")
        
        # Stop the sandbox
        await daytona.stop(sandbox)
        
        # Wait for it to actually stop
        for _ in range(30):
            await asyncio.sleep(1)
            sandbox = await daytona.get(sandbox.id)
            if sandbox.state == SandboxState.STOPPED:
                break
        
        if sandbox.state != SandboxState.STOPPED:
            result.stop(success=False, error=f"Sandbox didn't stop, state: {sandbox.state}")
            return result
        
        print(f"   Sandbox stopped, now measuring start time...")
        
        # Now measure the start time
        result.start()
        
        await daytona.start(sandbox)
        
        # Wait for STARTED state
        for _ in range(60):
            await asyncio.sleep(0.5)
            sandbox = await daytona.get(sandbox.id)
            if sandbox.state == SandboxState.STARTED:
                break
        
        result.details['sandbox_id'] = sandbox.id
        result.details['final_state'] = str(sandbox.state)
        
        if sandbox.state == SandboxState.STARTED:
            result.stop(success=True)
        else:
            result.stop(success=False, error=f"Didn't reach STARTED, got: {sandbox.state}")
        
    except Exception as e:
        result.stop(success=False, error=str(e))
    
    # Cleanup
    if sandbox:
        try:
            await daytona.delete(sandbox)
            print(f"   🗑️ Cleaned up sandbox {sandbox.id}")
        except Exception as e:
            print(f"   ⚠️ Failed to cleanup: {e}")
    
    return result


async def test_get_sandbox_state() -> TimingResult:
    """Test: How long does it take to just get sandbox state."""
    result = TimingResult("Get sandbox state (API call)")
    sandbox = None
    
    try:
        # First create a sandbox
        print("   Creating sandbox for state check test...")
        params = CreateSandboxFromSnapshotParams(
            snapshot=Configuration.SANDBOX_SNAPSHOT_NAME,
            public=True,
            labels={'test': 'state_test'},
            env_vars={"VNC_PASSWORD": str(uuid.uuid4())},
            auto_stop_interval=15,
            auto_archive_interval=30,
        )
        sandbox = await daytona.create(params)
        print(f"   Created sandbox {sandbox.id}, measuring get time...")
        
        # Measure get time
        result.start()
        sandbox = await daytona.get(sandbox.id)
        result.stop(success=True)
        
        result.details['sandbox_id'] = sandbox.id
        result.details['state'] = str(sandbox.state)
        
    except Exception as e:
        result.stop(success=False, error=str(e))
    
    # Cleanup
    if sandbox:
        try:
            await daytona.delete(sandbox)
            print(f"   🗑️ Cleaned up sandbox {sandbox.id}")
        except Exception as e:
            print(f"   ⚠️ Failed to cleanup: {e}")
    
    return result


async def test_check_pool_sandbox_states():
    """Check the current state of sandboxes in the pool."""
    print("\n" + "="*60)
    print("CHECKING CURRENT POOL SANDBOX STATES")
    print("="*60)
    
    try:
        from core.services.supabase import DBConnection
        db = DBConnection()
        client = await db.client
        
        # Get all pooled sandboxes
        result = await client.table('resources').select(
            'id, external_id, status, created_at, pooled_at'
        ).eq('type', 'sandbox').eq('status', 'pooled').execute()
        
        if not result.data:
            print("No pooled sandboxes found in database")
            return
        
        print(f"\nFound {len(result.data)} pooled sandboxes in database")
        print("-" * 60)
        
        states = {'STARTED': 0, 'STOPPED': 0, 'ARCHIVED': 0, 'OTHER': 0, 'ERROR': 0}
        
        for resource in result.data[:10]:  # Check first 10
            sandbox_id = resource['external_id']
            try:
                sandbox = await daytona.get(sandbox_id)
                state = str(sandbox.state).replace('SandboxState.', '')
                if state in states:
                    states[state] += 1
                else:
                    states['OTHER'] += 1
                print(f"  {sandbox_id[:8]}... -> {state}")
            except Exception as e:
                states['ERROR'] += 1
                print(f"  {sandbox_id[:8]}... -> ERROR: {e}")
        
        print("-" * 60)
        print(f"Summary (first 10): {states}")
        
    except Exception as e:
        print(f"Error checking pool: {e}")


async def test_ping_keeps_alive():
    """Test: Does a simple API call (ping) prevent auto-stop?"""
    result = TimingResult("Ping sandbox (API get only)")
    sandbox = None
    
    try:
        # Create sandbox
        print("   Creating sandbox for ping test...")
        params = CreateSandboxFromSnapshotParams(
            snapshot=Configuration.SANDBOX_SNAPSHOT_NAME,
            public=True,
            labels={'test': 'ping_test'},
            env_vars={"VNC_PASSWORD": str(uuid.uuid4())},
            auto_stop_interval=1,  # 1 minute auto-stop for quick test
            auto_archive_interval=2,
        )
        sandbox = await daytona.create(params)
        print(f"   Created sandbox {sandbox.id} with 1-min auto-stop")
        
        # Ping every 30 seconds for 2 minutes
        print("   Pinging every 30s for 2 minutes (API get only)...")
        for i in range(4):
            await asyncio.sleep(30)
            result.start()
            sandbox = await daytona.get(sandbox.id)
            result.stop()
            print(f"   Ping {i+1}: state={sandbox.state}, ping_time={result.duration_ms:.0f}ms")
        
        result.details['final_state'] = str(sandbox.state)
        result.details['sandbox_id'] = sandbox.id
        
        if sandbox.state == SandboxState.STARTED:
            print("   ✅ Sandbox stayed alive with pings!")
            result.stop(success=True)
        else:
            print(f"   ❌ Sandbox state changed to {sandbox.state}")
            result.stop(success=False, error=f"State changed to {sandbox.state}")
        
    except Exception as e:
        result.stop(success=False, error=str(e))
    
    # Cleanup
    if sandbox:
        try:
            await daytona.delete(sandbox)
            print(f"   🗑️ Cleaned up sandbox {sandbox.id}")
        except Exception as e:
            print(f"   ⚠️ Failed to cleanup: {e}")
    
    return result


async def test_command_keeps_alive():
    """Test: Does executing a real command prevent auto-stop?"""
    result = TimingResult("Command keeps sandbox alive")
    sandbox = None
    
    try:
        # Create sandbox
        print("   Creating sandbox for command keep-alive test...")
        params = CreateSandboxFromSnapshotParams(
            snapshot=Configuration.SANDBOX_SNAPSHOT_NAME,
            public=True,
            labels={'test': 'cmd_keepalive_test'},
            env_vars={"VNC_PASSWORD": str(uuid.uuid4())},
            auto_stop_interval=1,  # 1 minute auto-stop for quick test
            auto_archive_interval=2,
        )
        sandbox = await daytona.create(params)
        print(f"   Created sandbox {sandbox.id} with 1-min auto-stop")
        
        # Execute command every 30 seconds for 2.5 minutes
        print("   Executing 'echo keepalive' every 30s for 2.5 minutes...")
        session_id = f"keepalive_session_{uuid.uuid4().hex[:8]}"
        await sandbox.process.create_session(session_id)
        
        for i in range(5):
            await asyncio.sleep(30)
            result.start()
            
            # Execute a real command using proper Daytona API
            try:
                cmd_result = await sandbox.process.execute_session_command(
                    session_id,
                    SessionExecuteRequest(
                        command="echo keepalive",
                        var_async=False
                    )
                )
                cmd_output = str(cmd_result)[:50] if cmd_result else "OK"
            except Exception as cmd_err:
                cmd_output = f"Error: {cmd_err}"
            
            # Check state
            sandbox = await daytona.get(sandbox.id)
            result.stop()
            print(f"   Cmd {i+1}: state={sandbox.state}, time={result.duration_ms:.0f}ms, output={cmd_output[:50]}")
            
            if sandbox.state != SandboxState.STARTED:
                break
        
        result.details['final_state'] = str(sandbox.state)
        result.details['sandbox_id'] = sandbox.id
        
        if sandbox.state == SandboxState.STARTED:
            print("   ✅ Sandbox stayed alive with commands!")
            result.stop(success=True)
        else:
            print(f"   ❌ Sandbox state changed to {sandbox.state}")
            result.stop(success=False, error=f"State changed to {sandbox.state}")
        
    except Exception as e:
        result.stop(success=False, error=str(e))
    
    # Cleanup
    if sandbox:
        try:
            await daytona.delete(sandbox)
            print(f"   🗑️ Cleaned up sandbox {sandbox.id}")
        except Exception as e:
            print(f"   ⚠️ Failed to cleanup: {e}")
    
    return result


async def run_all_tests():
    """Run all timing tests."""
    print("\n" + "="*60)
    print("SANDBOX TIMING TESTS")
    print("="*60)
    print(f"Daytona URL: {config.DAYTONA_SERVER_URL}")
    print(f"Snapshot: {Configuration.SANDBOX_SNAPSHOT_NAME}")
    print("="*60 + "\n")
    
    results = []
    
    # Test 1: Create new sandbox
    print("\n[TEST 1] Creating new sandbox from scratch...")
    results.append(await test_create_sandbox())
    print(results[-1])
    
    # Test 2: Get sandbox state
    print("\n[TEST 2] Getting sandbox state (API latency)...")
    results.append(await test_get_sandbox_state())
    print(results[-1])
    
    # Test 3: Start stopped sandbox
    print("\n[TEST 3] Starting a STOPPED sandbox...")
    results.append(await test_start_stopped_sandbox())
    print(results[-1])
    
    # Check pool states
    await test_check_pool_sandbox_states()
    
    # Summary
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    for r in results:
        print(r)
    
    print("\n" + "="*60)
    print("RECOMMENDATIONS")
    print("="*60)
    
    create_time = results[0].duration_ms if results[0].success else None
    start_time = results[2].duration_ms if results[2].success else None
    
    if create_time and start_time:
        if start_time < create_time * 0.5:
            print("✅ Starting STOPPED sandbox is significantly faster than creating new")
            print("   → Pool with STOPPED sandboxes still provides benefit")
        else:
            print("⚠️ Starting STOPPED sandbox takes similar time to creating new")
            print("   → Need to keep pool sandboxes in STARTED state for speed benefit")
    
    print("\nTo test keep-alive behavior, run:")
    print("  python -m tests.sandbox_timing_test --ping-test")


async def run_ping_test():
    """Run just the ping/keep-alive test."""
    print("\n" + "="*60)
    print("PING KEEP-ALIVE TEST")
    print("="*60)
    print("Testing if periodic pings prevent auto-stop...")
    print("This test takes ~2 minutes\n")
    
    result = await test_ping_keeps_alive()
    print("\n" + str(result))


async def run_command_keepalive_test():
    """Run the command keep-alive test."""
    print("\n" + "="*60)
    print("COMMAND KEEP-ALIVE TEST")
    print("="*60)
    print("Testing if executing commands prevents auto-stop...")
    print("This test takes ~2.5 minutes\n")
    
    result = await test_command_keeps_alive()
    print("\n" + str(result))


if __name__ == "__main__":
    if "--ping-test" in sys.argv:
        asyncio.run(run_ping_test())
    elif "--cmd-test" in sys.argv:
        asyncio.run(run_command_keepalive_test())
    elif "--pool-check" in sys.argv:
        asyncio.run(test_check_pool_sandbox_states())
    else:
        asyncio.run(run_all_tests())
