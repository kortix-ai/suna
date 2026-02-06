import asyncio
from daytona_sdk import AsyncDaytona, DaytonaConfig, CreateSandboxFromSnapshotParams, SessionExecuteRequest

async def main():
    config = DaytonaConfig()
    daytona = AsyncDaytona(config)
    
    print("Creating sandbox with v0.2.6...")
    params = CreateSandboxFromSnapshotParams(
        snapshot="kortix-opencode-v0.2.6",
        public=True,
        env_vars={
            "OPENCODE_SERVER_USERNAME": "opencode",
            "OPENCODE_SERVER_PASSWORD": "testpass123",
            "KORTIX_API_URL": "YOUR_NGROK_URL_HERE",  # Set your ngrok URL
            "KORTIX_TOKEN": "00000",  # Test token - skips billing
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
    
    print("\n--- /workspace contents ---")
    result = await sandbox.process.exec("ls -la /workspace")
    print(result.result)
    
    print("\n--- supervisord.pid location ---")
    result = await sandbox.process.exec("cat /var/run/supervisord.pid 2>/dev/null && echo ' (in /var/run/)' || echo 'Not in /var/run/'")
    print(result.result)
    
    print("\n--- Health check ---")
    result = await sandbox.process.exec("curl -s -u opencode:testpass123 http://localhost:4096/global/health")
    print(result.result)

    print("\n--- OpenCode config ---")
    result = await sandbox.process.exec("cat /root/.config/opencode/opencode.json")
    print(result.result)

    print("\n--- Plugin files ---")
    result = await sandbox.process.exec("ls -la /root/.config/opencode/plugins/kortix/")
    print(result.result)

    print("\n--- List available tools via API ---")
    result = await sandbox.process.exec("curl -s -u opencode:testpass123 http://localhost:4096/global/tools 2>/dev/null | head -100")
    print(result.result)

    link = await sandbox.get_preview_link(4096)
    print(f"\nURL: {link.url}")
    print(f"Sandbox: {sandbox.id}")

asyncio.run(main())
