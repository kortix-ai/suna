import asyncio
import sys
import os
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.sandbox.resolver import resolve_sandbox, get_resolver


async def test_resolver_consistency():
    print("\n" + "="*60)
    print("SANDBOX RESOLVER CONSISTENCY TEST")
    print("="*60)
    print("Testing that multiple resolve calls return the SAME sandbox\n")
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    result = await client.table('projects').select(
        'project_id, account_id'
    ).limit(1).execute()
    
    if not result.data:
        print("No projects found in database. Create a project first.")
        return
    
    project_id = result.data[0]['project_id']
    account_id = str(result.data[0]['account_id'])
    
    print(f"Using project: {project_id}")
    print(f"Account: {account_id}\n")
    
    print("[TEST 1] First resolve call...")
    sandbox_info_1 = await resolve_sandbox(
        project_id=project_id,
        account_id=account_id,
        db_client=client
    )
    
    if not sandbox_info_1:
        print("Failed to resolve sandbox on first call")
        return
    
    print(f"   Sandbox ID: {sandbox_info_1.sandbox_id}")
    
    print("\n[TEST 2] Second resolve call (should return SAME sandbox)...")
    sandbox_info_2 = await resolve_sandbox(
        project_id=project_id,
        account_id=account_id,
        db_client=client
    )
    
    if not sandbox_info_2:
        print("Failed to resolve sandbox on second call")
        return
    
    print(f"   Sandbox ID: {sandbox_info_2.sandbox_id}")
    
    print("\n[TEST 3] Parallel resolve calls (should all return SAME sandbox)...")
    tasks = [
        resolve_sandbox(project_id=project_id, account_id=account_id, db_client=client)
        for _ in range(5)
    ]
    results = await asyncio.gather(*tasks)
    
    sandbox_ids = [r.sandbox_id for r in results if r]
    print(f"   Sandbox IDs: {sandbox_ids}")
    
    print("\n" + "="*60)
    print("RESULTS")
    print("="*60)
    
    all_same = len(set(sandbox_ids + [sandbox_info_1.sandbox_id, sandbox_info_2.sandbox_id])) == 1
    
    if all_same:
        print("All resolve calls returned the SAME sandbox ID")
        print(f"   Sandbox: {sandbox_info_1.sandbox_id}")
    else:
        print("DIFFERENT sandbox IDs returned - this is a bug!")
        print(f"   First: {sandbox_info_1.sandbox_id}")
        print(f"   Second: {sandbox_info_2.sandbox_id}")
        print(f"   Parallel: {sandbox_ids}")


async def test_resolver_vs_upload_handler():
    print("\n" + "="*60)
    print("RESOLVER VS UPLOAD HANDLER TEST")
    print("="*60)
    print("Simulating file upload + tool execution scenario\n")
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    result = await client.table('projects').select(
        'project_id, account_id'
    ).limit(1).execute()
    
    if not result.data:
        print("No projects found in database.")
        return
    
    project_id = result.data[0]['project_id']
    account_id = str(result.data[0]['account_id'])
    
    print(f"Project: {project_id}")
    print(f"Account: {account_id}\n")
    
    print("[STEP 1] Simulating upload_handler resolve...")
    from core.files.upload_handler import ensure_sandbox_for_thread
    
    sandbox_upload, sandbox_id_upload = await ensure_sandbox_for_thread(
        client=client,
        project_id=project_id,
        files=[("test.txt", b"test content", "text/plain", None)]
    )
    
    if sandbox_upload:
        print(f"   Upload handler sandbox: {sandbox_id_upload}")
    else:
        print("   Upload handler: No sandbox (no files or error)")
    
    print("\n[STEP 2] Simulating tool_base resolve...")
    sandbox_info_tool = await resolve_sandbox(
        project_id=project_id,
        account_id=account_id,
        db_client=client
    )
    
    if sandbox_info_tool:
        print(f"   Tool base sandbox: {sandbox_info_tool.sandbox_id}")
    else:
        print("   Tool base: Failed to resolve")
    
    print("\n" + "="*60)
    print("RESULTS")
    print("="*60)
    
    if sandbox_upload and sandbox_info_tool:
        if sandbox_id_upload == sandbox_info_tool.sandbox_id:
            print("Upload handler and tool base use the SAME sandbox")
            print("   This is correct - files will be accessible to tools")
        else:
            print("Upload handler and tool base use DIFFERENT sandboxes")
            print("   This is a BUG - files won't be accessible!")
            print(f"   Upload: {sandbox_id_upload}")
            print(f"   Tool: {sandbox_info_tool.sandbox_id}")
    else:
        print("Could not compare - one or both resolves failed")


async def main():
    if "--upload-test" in sys.argv:
        await test_resolver_vs_upload_handler()
    else:
        await test_resolver_consistency()


if __name__ == "__main__":
    asyncio.run(main())
