import asyncio
from daytona_sdk import AsyncDaytona, DaytonaConfig, CreateSandboxFromSnapshotParams, SessionExecuteRequest

async def main():
    config = DaytonaConfig()
    daytona = AsyncDaytona(config)
    
    print("Creating sandbox with v0.1.2...")
    params = CreateSandboxFromSnapshotParams(
        snapshot="kortix-opencode-v0.1.2",
        public=True,
        env_vars={
            "OPENCODE_SERVER_USERNAME": "opencode",
            "OPENCODE_SERVER_PASSWORD": "test123",
        },
        auto_stop_interval=15,
        auto_archive_interval=30,
    )
    
    sandbox = await daytona.create(params)
    print(f"Sandbox ID: {sandbox.id}")
    
    print("Starting supervisord...")
    session_id = "supervisord-session"
    await sandbox.process.create_session(session_id)
    await sandbox.process.execute_session_command(session_id, SessionExecuteRequest(
        command="exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf",
        run_async=True
    ))
    
    print("Waiting 15s...")
    await asyncio.sleep(15)
    
    print("\n--- Supervisord Status ---")
    result = await sandbox.process.exec("supervisorctl status")
    print(result.result)
    
    print("\n--- /workspace ---")
    result = await sandbox.process.exec("ls -la /workspace")
    print(result.result)
    
    print("\n--- Agents ---")
    result = await sandbox.process.exec("ls /root/.config/opencode/agents/")
    print(result.result)
    
    print("\n--- Health ---")
    result = await sandbox.process.exec("curl -s -u opencode:test123 http://localhost:4096/global/health")
    print(result.result)
    
    print("\n--- Agents API ---")
    result = await sandbox.process.exec("curl -s -u opencode:test123 http://localhost:4096/agent | head -c 300")
    print(result.result + "...")
    
    link = await sandbox.get_preview_link(4096)
    print(f"\n========================================")
    print(f"URL: {link.url}")
    print(f"Auth: opencode / test123")
    print(f"Sandbox: {sandbox.id}")
    print(f"========================================")

asyncio.run(main())
