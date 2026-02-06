import asyncio
from daytona_sdk import AsyncDaytona, DaytonaConfig

async def main():
    config = DaytonaConfig()
    daytona = AsyncDaytona(config)
    
    sandbox = await daytona.get("34fed410-1a72-4ebf-9ca5-4e90f97986bf")
    
    print("--- OpenCode working directory (from /proc) ---")
    result = await sandbox.process.exec("ls -la /proc/107/cwd")
    print(result.result)
    
    print("\n--- OpenCode project path from API ---")
    result = await sandbox.process.exec("curl -s -u opencode:test123 http://localhost:4096/project/current")
    print(result.result)
    
    print("\n--- OpenCode path from API ---")
    result = await sandbox.process.exec("curl -s -u opencode:test123 http://localhost:4096/path")
    print(result.result)

asyncio.run(main())
