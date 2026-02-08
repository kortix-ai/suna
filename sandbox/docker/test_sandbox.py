import asyncio
from daytona_sdk import AsyncDaytona, DaytonaConfig, CreateSandboxFromSnapshotParams, SessionExecuteRequest

async def main():
    config = DaytonaConfig()
    daytona = AsyncDaytona(config)

    # Your ngrok URL pointing to kortix-router (localhost:8008)
    KORTIX_LLM_URL = "https://4448-95-85-157-6.ngrok-free.app/v1"
    KORTIX_API_URL = "https://4448-95-85-157-6.ngrok-free.app"
    KORTIX_TOKEN = "sk_XVENRFj2DMmSFs0ydRChyCNqg5tG5XlV"  # Your API key

    print("Creating sandbox with kortix-opencode-v0.2.6...")
    print(f"LLM URL: {KORTIX_LLM_URL}")
    print(f"Token: {KORTIX_TOKEN[:10]}...")

    params = CreateSandboxFromSnapshotParams(
        snapshot="kortix-opencode-v0.2.7",
        public=True,
        env_vars={
            "OPENCODE_SERVER_USERNAME": "opencode",
            "OPENCODE_SERVER_PASSWORD": "testpass123",
            "KORTIX_API_URL": KORTIX_API_URL,
            "KORTIX_LLM_URL": KORTIX_LLM_URL,
            "KORTIX_TOKEN": KORTIX_TOKEN,
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

    print("Waiting 15s for services to start...")
    await asyncio.sleep(15)

    print("\n--- Supervisor status ---")
    result = await sandbox.process.exec("supervisorctl status")
    print(result.result)

    print("\n--- OpenCode config (checking kortix provider) ---")
    result = await sandbox.process.exec("cat /root/.config/opencode/opencode.json 2>/dev/null || echo 'Config not found'")
    print(result.result)

    print("\n--- Environment check ---")
    result = await sandbox.process.exec("echo 'KORTIX_LLM_URL:' $KORTIX_LLM_URL && echo 'KORTIX_TOKEN:' ${KORTIX_TOKEN:0:10}...")
    print(result.result)

    print("\n--- Health check (Kortix Master) ---")
    result = await sandbox.process.exec("curl -s http://localhost:8000/kortix/health")
    print(result.result)

    print("\n--- Health check (OpenCode) ---")
    result = await sandbox.process.exec("curl -s -u opencode:testpass123 http://localhost:4096/global/health")
    print(result.result)

    print("\n--- Test LLM via OpenCode API ---")
    result = await sandbox.process.exec("""
curl -s -X POST -u opencode:testpass123 http://localhost:4096/sessions \
  -H 'Content-Type: application/json' \
  -d '{"title": "test"}'
""")
    print(f"Create session: {result.result}")

    # Get session ID from response
    import json
    try:
        session_data = json.loads(result.result)
        session_id = session_data.get('id', session_data.get('session_id'))
        if session_id:
            print(f"\nSession created: {session_id}")

            print("\n--- Sending message to test LLM ---")
            result = await sandbox.process.exec(f"""
curl -s -X POST -u opencode:testpass123 'http://localhost:4096/sessions/{session_id}/message' \
  -H 'Content-Type: application/json' \
  -d '{{"content": "Say hello in exactly 5 words"}}'
""")
            print(f"LLM Response: {result.result[:500]}...")
    except:
        print("Could not parse session response")

    link = await sandbox.get_preview_link(8000)
    print(f"\n=== SANDBOX READY ===")
    print(f"Kortix Master URL: {link.url}")
    print(f"Sandbox ID: {sandbox.id}")
    print(f"\nTo connect: opencode client --url {link.url} --username opencode --password testpass123")

asyncio.run(main())
