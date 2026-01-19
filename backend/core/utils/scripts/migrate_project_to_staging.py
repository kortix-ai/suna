#!/usr/bin/env python3
"""
Migrate Project to Staging Script

Migrates a project and all its threads/messages from production to staging
for debugging production frontend client-side errors locally.

Usage:
    # Add to your .env file:
    # PROD_SUPABASE_URL=https://xxx.supabase.co
    # PROD_SUPABASE_SERVICE_ROLE_KEY=...

    # Migrate by project ID (migrates project + all threads + messages)
    uv run python core/utils/scripts/migrate_project_to_staging.py \
      --project-id 3ea3c3c1-d0e4-4fe6-a89c-fa72f0b055c5 \
      --staging-account-id 155b36a3-ae93-483f-a024-1003572d6e40

    # Migrate by thread ID (migrates thread + its project + messages)
    uv run python core/utils/scripts/migrate_project_to_staging.py \
      --thread-id 48d27316-36c4-4a4f-b820-c30c19823949 \
      --staging-account-id 155b36a3-ae93-483f-a024-1003572d6e40

Options:
    --project-id          Production project UUID to migrate (all threads)
    --thread-id           Production thread UUID to migrate (single thread + its project)
    --staging-account-id  Staging account UUID to assign the project to
    --dry-run             Preview what would be migrated without making changes
    --skip-messages       Only migrate project and threads, skip messages
    --skip-agent-runs     Skip migrating agent_runs table

Environment Variables (add to .env):
    PROD_SUPABASE_URL              Production Supabase URL
    PROD_SUPABASE_SERVICE_ROLE_KEY Production service role key

Examples:
    # Migrate entire project
    uv run python core/utils/scripts/migrate_project_to_staging.py \
      --project-id abc123-def456 \
      --staging-account-id xyz789-abc123

    # Migrate single thread (and its parent project)
    uv run python core/utils/scripts/migrate_project_to_staging.py \
      --thread-id 48d27316-36c4-4a4f-b820-c30c19823949 \
      --staging-account-id 155b36a3-ae93-483f-a024-1003572d6e40

    # Dry run to preview
    uv run python core/utils/scripts/migrate_project_to_staging.py \
      --thread-id abc123 --staging-account-id xyz789 --dry-run
"""

import asyncio
import argparse
import os
import sys
from pathlib import Path
from typing import Optional, Dict, Any, List
from datetime import datetime

# Add backend to path
backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

# Load .env BEFORE checking environment variables
from dotenv import load_dotenv
load_dotenv(backend_dir / '.env')

from supabase import create_async_client, AsyncClient
from core.utils.logger import logger


class ProjectMigrator:
    """Handles migration of projects from production to staging."""

    def __init__(
        self,
        prod_url: str,
        prod_key: str,
        staging_url: str,
        staging_key: str,
        dry_run: bool = False
    ):
        self.prod_url = prod_url
        self.prod_key = prod_key
        self.staging_url = staging_url
        self.staging_key = staging_key
        self.dry_run = dry_run

        self.prod_client: Optional[AsyncClient] = None
        self.staging_client: Optional[AsyncClient] = None

        # Migration stats
        self.stats = {
            'projects': 0,
            'threads': 0,
            'messages': 0,
            'agent_runs': 0,
            'errors': []
        }

    async def initialize(self):
        """Initialize connections to both databases."""
        print("\n1. Connecting to databases...")

        # Connect to production
        print(f"   - Production: {self.prod_url[:50]}...")
        self.prod_client = await create_async_client(self.prod_url, self.prod_key)

        # Connect to staging
        print(f"   - Staging: {self.staging_url[:50]}...")
        self.staging_client = await create_async_client(self.staging_url, self.staging_key)

        print("   Connected to both databases")

    async def close(self):
        """Close database connections."""
        # Note: supabase-py AsyncClient may not have a close method
        # Safe cleanup - just set to None
        self.prod_client = None
        self.staging_client = None

    async def fetch_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        """Fetch project from production."""
        result = await self.prod_client.table('projects').select('*').eq('project_id', project_id).execute()
        return result.data[0] if result.data else None

    async def fetch_threads(self, project_id: str) -> List[Dict[str, Any]]:
        """Fetch all threads for a project from production."""
        result = await self.prod_client.table('threads').select('*').eq('project_id', project_id).order('created_at').execute()
        return result.data or []

    async def fetch_messages(self, thread_id: str) -> List[Dict[str, Any]]:
        """Fetch all messages for a thread from production."""
        result = await self.prod_client.table('messages').select('*').eq('thread_id', thread_id).order('created_at').execute()
        return result.data or []

    async def fetch_agent_runs(self, thread_id: str) -> List[Dict[str, Any]]:
        """Fetch all agent runs for a thread from production."""
        result = await self.prod_client.table('agent_runs').select('*').eq('thread_id', thread_id).order('created_at').execute()
        return result.data or []

    async def fetch_thread(self, thread_id: str) -> Optional[Dict[str, Any]]:
        """Fetch a single thread from production."""
        result = await self.prod_client.table('threads').select('*').eq('thread_id', thread_id).execute()
        return result.data[0] if result.data else None

    async def upsert_project(self, project: Dict[str, Any], staging_account_id: str) -> bool:
        """Upsert project to staging with remapped account_id."""
        try:
            # Core project columns that exist in both prod and staging
            # Note: 'sandbox' is deprecated in prod and may not exist in staging
            core_columns = {
                'project_id', 'account_id', 'name', 'description', 'icon_name',
                'sandbox_resource_id', 'is_public', 'created_at', 'updated_at'
            }

            # Build project data with only known columns
            project_data = {
                k: v for k, v in project.items() if k in core_columns
            }

            # Remap account_id to staging account
            project_data['account_id'] = staging_account_id
            # Clear sandbox-related fields that won't exist in staging
            project_data['sandbox_resource_id'] = None

            if self.dry_run:
                print(f"      [DRY RUN] Would upsert project: {project_data['project_id']}")
                return True

            await self.staging_client.table('projects').upsert(
                project_data,
                on_conflict='project_id'
            ).execute()

            self.stats['projects'] += 1
            return True
        except Exception as e:
            error_msg = f"Project {project.get('project_id')}: {e}"
            self.stats['errors'].append(error_msg)
            print(f"      ERROR: {e}")
            return False

    async def upsert_thread(self, thread: Dict[str, Any], staging_account_id: str) -> bool:
        """Upsert thread to staging with remapped account_id."""
        try:
            # Core thread columns that exist in both prod and staging
            core_columns = {
                'thread_id', 'account_id', 'project_id', 'name', 'metadata',
                'is_public', 'status', 'memory_enabled', 'initialization_error',
                'initialization_started_at', 'initialization_completed_at',
                'created_at', 'updated_at'
            }

            # Build thread data with only known columns
            thread_data = {
                k: v for k, v in thread.items() if k in core_columns
            }

            # Remap account_id to staging account
            thread_data['account_id'] = staging_account_id

            if self.dry_run:
                print(f"      [DRY RUN] Would upsert thread: {thread_data['thread_id']}")
                return True

            await self.staging_client.table('threads').upsert(
                thread_data,
                on_conflict='thread_id'
            ).execute()

            self.stats['threads'] += 1
            return True
        except Exception as e:
            self.stats['errors'].append(f"Thread {thread.get('thread_id')}: {e}")
            return False

    async def upsert_messages_batch(self, messages: List[Dict[str, Any]]) -> int:
        """Upsert messages to staging in batches."""
        if not messages:
            return 0

        if self.dry_run:
            print(f"      [DRY RUN] Would upsert {len(messages)} messages")
            return len(messages)

        # Batch insert in chunks of 100
        batch_size = 100
        migrated = 0

        for i in range(0, len(messages), batch_size):
            batch = messages[i:i + batch_size]
            try:
                # Clean up messages - remove agent_id/agent_version_id as they may not exist in staging
                clean_batch = []
                for msg in batch:
                    msg_data = {**msg}
                    # Remove fields that might cause FK violations
                    msg_data.pop('agent_id', None)
                    msg_data.pop('agent_version_id', None)
                    clean_batch.append(msg_data)

                await self.staging_client.table('messages').upsert(
                    clean_batch,
                    on_conflict='message_id'
                ).execute()

                migrated += len(batch)
            except Exception as e:
                self.stats['errors'].append(f"Message batch at {i}: {e}")

        self.stats['messages'] += migrated
        return migrated

    async def upsert_agent_runs_batch(self, runs: List[Dict[str, Any]]) -> int:
        """Upsert agent runs to staging in batches."""
        if not runs:
            return 0

        if self.dry_run:
            print(f"      [DRY RUN] Would upsert {len(runs)} agent runs")
            return len(runs)

        batch_size = 100
        migrated = 0

        for i in range(0, len(runs), batch_size):
            batch = runs[i:i + batch_size]
            try:
                # Clean up runs - remove agent_id/agent_version_id if they might not exist
                clean_batch = []
                for run in batch:
                    run_data = {**run}
                    # Remove fields that might cause FK violations
                    run_data.pop('agent_id', None)
                    run_data.pop('agent_version_id', None)
                    clean_batch.append(run_data)

                await self.staging_client.table('agent_runs').upsert(
                    clean_batch,
                    on_conflict='id'
                ).execute()

                migrated += len(batch)
            except Exception as e:
                self.stats['errors'].append(f"Agent runs batch at {i}: {e}")

        self.stats['agent_runs'] += migrated
        return migrated

    async def migrate_project(
        self,
        project_id: str,
        staging_account_id: str,
        skip_messages: bool = False,
        skip_agent_runs: bool = False
    ):
        """
        Migrate a complete project with all threads and messages.

        Args:
            project_id: Production project UUID
            staging_account_id: Staging account UUID to own the project
            skip_messages: Skip migrating messages (faster for large projects)
            skip_agent_runs: Skip migrating agent_runs table
        """
        print(f"\n{'=' * 60}")
        print(f"MIGRATING PROJECT: {project_id}")
        print(f"TO STAGING ACCOUNT: {staging_account_id}")
        if self.dry_run:
            print("MODE: DRY RUN (no changes will be made)")
        print(f"{'=' * 60}")

        # Step 1: Fetch project
        print("\n2. Fetching project from production...")
        project = await self.fetch_project(project_id)

        if not project:
            print(f"   ERROR: Project not found: {project_id}")
            return False

        print(f"   Found project: {project.get('name', 'Unnamed')}")
        print(f"   Created: {project.get('created_at')}")
        print(f"   Original account: {project.get('account_id')}")

        # Step 2: Fetch threads
        print("\n3. Fetching threads from production...")
        threads = await self.fetch_threads(project_id)
        print(f"   Found {len(threads)} threads")

        # Step 3: Migrate project
        print("\n4. Migrating project to staging...")
        if not await self.upsert_project(project, staging_account_id):
            print("   ERROR: Failed to migrate project")
            return False
        print(f"   {'[DRY RUN] ' if self.dry_run else ''}Project migrated")

        # Step 4: Migrate threads and their data
        print("\n5. Migrating threads and messages...")

        for i, thread in enumerate(threads):
            thread_id = thread['thread_id']
            thread_name = thread.get('name', 'Unnamed')
            print(f"\n   Thread {i+1}/{len(threads)}: {thread_name[:30]}...")

            # Migrate thread
            if not await self.upsert_thread(thread, staging_account_id):
                print(f"      ERROR: Failed to migrate thread")
                continue
            print(f"      {'[DRY RUN] ' if self.dry_run else ''}Thread migrated")

            # Migrate messages
            if not skip_messages:
                messages = await self.fetch_messages(thread_id)
                if messages:
                    migrated = await self.upsert_messages_batch(messages)
                    print(f"      {'[DRY RUN] ' if self.dry_run else ''}{migrated} messages migrated")

            # Migrate agent runs
            if not skip_agent_runs:
                runs = await self.fetch_agent_runs(thread_id)
                if runs:
                    migrated = await self.upsert_agent_runs_batch(runs)
                    print(f"      {'[DRY RUN] ' if self.dry_run else ''}{migrated} agent runs migrated")

        # Print summary
        print(f"\n{'=' * 60}")
        print("MIGRATION SUMMARY")
        print(f"{'=' * 60}")
        print(f"  Projects migrated: {self.stats['projects']}")
        print(f"  Threads migrated:  {self.stats['threads']}")
        print(f"  Messages migrated: {self.stats['messages']}")
        print(f"  Agent runs migrated: {self.stats['agent_runs']}")

        if self.stats['errors']:
            print(f"\n  Errors ({len(self.stats['errors'])}):")
            for error in self.stats['errors'][:10]:  # Show first 10 errors
                print(f"    - {error}")
            if len(self.stats['errors']) > 10:
                print(f"    ... and {len(self.stats['errors']) - 10} more")

        if self.dry_run:
            print(f"\n  DRY RUN - No changes were made to staging database")
            print(f"  Run without --dry-run flag to apply changes")
        else:
            print(f"\n  Migration complete!")
            print(f"\n  Debug URLs:")
            print(f"  Project: http://localhost:3000/projects/{project_id}")
            for thread in threads:
                tid = thread['thread_id']
                tname = thread.get('name', 'Unnamed')[:40]
                print(f"  Thread:  http://localhost:3000/projects/{project_id}/thread/{tid}")
                print(f"           ({tname})")

        return True

    async def migrate_thread(
        self,
        thread_id: str,
        staging_account_id: str,
        skip_messages: bool = False,
        skip_agent_runs: bool = False
    ):
        """
        Migrate a single thread and its parent project.

        Args:
            thread_id: Production thread UUID
            staging_account_id: Staging account UUID to own the project/thread
            skip_messages: Skip migrating messages
            skip_agent_runs: Skip migrating agent_runs table
        """
        print(f"\n{'=' * 60}")
        print(f"MIGRATING THREAD: {thread_id}")
        print(f"TO STAGING ACCOUNT: {staging_account_id}")
        if self.dry_run:
            print("MODE: DRY RUN (no changes will be made)")
        print(f"{'=' * 60}")

        # Step 1: Fetch thread
        print("\n2. Fetching thread from production...")
        thread = await self.fetch_thread(thread_id)

        if not thread:
            print(f"   ERROR: Thread not found: {thread_id}")
            return False

        print(f"   Found thread: {thread.get('name', 'Unnamed')}")
        print(f"   Created: {thread.get('created_at')}")
        print(f"   Original account: {thread.get('account_id')}")

        project_id = thread.get('project_id')
        project = None

        # Step 2: Fetch and migrate parent project (if exists)
        if project_id:
            print(f"\n3. Fetching parent project from production...")
            project = await self.fetch_project(project_id)

            if project:
                print(f"   Found project: {project.get('name', 'Unnamed')}")
                print("\n4. Migrating project to staging...")
                if not await self.upsert_project(project, staging_account_id):
                    print("   ERROR: Failed to migrate project")
                    return False
                print(f"   {'[DRY RUN] ' if self.dry_run else ''}Project migrated")
            else:
                print(f"   WARNING: Parent project not found: {project_id}")
        else:
            print("\n3. Thread has no parent project (orphan thread)")

        # Step 3: Migrate thread
        print(f"\n{'5' if project_id else '4'}. Migrating thread to staging...")
        if not await self.upsert_thread(thread, staging_account_id):
            print("   ERROR: Failed to migrate thread")
            return False
        print(f"   {'[DRY RUN] ' if self.dry_run else ''}Thread migrated")

        # Step 4: Migrate messages
        if not skip_messages:
            print(f"\n{'6' if project_id else '5'}. Migrating messages...")
            messages = await self.fetch_messages(thread_id)
            if messages:
                migrated = await self.upsert_messages_batch(messages)
                print(f"   {'[DRY RUN] ' if self.dry_run else ''}{migrated} messages migrated")
            else:
                print("   No messages to migrate")

        # Step 5: Migrate agent runs
        if not skip_agent_runs:
            print(f"\n{'7' if project_id else '6'}. Migrating agent runs...")
            runs = await self.fetch_agent_runs(thread_id)
            if runs:
                migrated = await self.upsert_agent_runs_batch(runs)
                print(f"   {'[DRY RUN] ' if self.dry_run else ''}{migrated} agent runs migrated")
            else:
                print("   No agent runs to migrate")

        # Print summary
        print(f"\n{'=' * 60}")
        print("MIGRATION SUMMARY")
        print(f"{'=' * 60}")
        print(f"  Projects migrated: {self.stats['projects']}")
        print(f"  Threads migrated:  {self.stats['threads']}")
        print(f"  Messages migrated: {self.stats['messages']}")
        print(f"  Agent runs migrated: {self.stats['agent_runs']}")

        if self.stats['errors']:
            print(f"\n  Errors ({len(self.stats['errors'])}):")
            for error in self.stats['errors'][:10]:
                print(f"    - {error}")
            if len(self.stats['errors']) > 10:
                print(f"    ... and {len(self.stats['errors']) - 10} more")

        if self.dry_run:
            print(f"\n  DRY RUN - No changes were made to staging database")
            print(f"  Run without --dry-run flag to apply changes")
        else:
            print(f"\n  Migration complete!")
            print(f"\n  Debug URL:")
            if project_id:
                print(f"  http://localhost:3000/projects/{project_id}/thread/{thread_id}")
            else:
                print(f"  Thread has no project - check your frontend routing")

        return True


async def main():
    parser = argparse.ArgumentParser(
        description="Migrate a project or thread from production to staging for debugging",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )

    # Mutually exclusive: either project-id or thread-id
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument(
        '--project-id',
        help='Production project UUID to migrate (all threads)'
    )
    source_group.add_argument(
        '--thread-id',
        help='Production thread UUID to migrate (single thread + its project)'
    )
    parser.add_argument(
        '--staging-account-id',
        required=True,
        help='Staging account UUID to assign the project to'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview migration without making changes'
    )
    parser.add_argument(
        '--skip-messages',
        action='store_true',
        help='Skip migrating messages (faster for large projects)'
    )
    parser.add_argument(
        '--skip-agent-runs',
        action='store_true',
        help='Skip migrating agent_runs table'
    )
    parser.add_argument(
        '--force',
        action='store_true',
        help='Skip confirmation prompts (use with caution)'
    )

    args = parser.parse_args()

    # Get production credentials from environment
    prod_url = os.getenv('PROD_SUPABASE_URL')
    prod_key = os.getenv('PROD_SUPABASE_SERVICE_ROLE_KEY')

    if not prod_url or not prod_key:
        print("ERROR: Production credentials not found!")
        print("\nSet these environment variables:")
        print("  export PROD_SUPABASE_URL='https://xxx.supabase.co'")
        print("  export PROD_SUPABASE_SERVICE_ROLE_KEY='...'")
        print("\nOr create a .env.prod file and source it:")
        print("  source .env.prod")
        sys.exit(1)

    # Get staging credentials from default config
    from core.utils.config import config

    staging_url = config.SUPABASE_URL
    staging_key = config.SUPABASE_SERVICE_ROLE_KEY

    if not staging_url or not staging_key:
        print("ERROR: Staging credentials not found!")
        print("\nMake sure your .env file has:")
        print("  SUPABASE_URL='https://xxx.supabase.co'")
        print("  SUPABASE_SERVICE_ROLE_KEY='...'")
        sys.exit(1)

    # Safety check: don't allow migrating to production
    if 'staging' not in staging_url.lower() and prod_url != staging_url:
        # Allow if it's a local/development URL or explicitly different from prod
        if 'localhost' not in staging_url and '127.0.0.1' not in staging_url:
            print("\n" + "=" * 60)
            print("WARNING: Staging URL does not contain 'staging' or 'localhost'")
            print(f"  Staging URL: {staging_url}")
            print(f"  Prod URL:    {prod_url}")
            print("=" * 60)

            if not args.force:
                confirm = input("\nAre you sure this is your staging/local database? (yes/no): ")
                if confirm.lower() != 'yes':
                    print("Aborted.")
                    sys.exit(1)
            else:
                print("\n  --force flag set, skipping confirmation")

    # Initialize migrator
    migrator = ProjectMigrator(
        prod_url=prod_url,
        prod_key=prod_key,
        staging_url=staging_url,
        staging_key=staging_key,
        dry_run=args.dry_run
    )

    try:
        await migrator.initialize()

        if args.thread_id:
            # Migrate single thread (and its parent project)
            success = await migrator.migrate_thread(
                thread_id=args.thread_id,
                staging_account_id=args.staging_account_id,
                skip_messages=args.skip_messages,
                skip_agent_runs=args.skip_agent_runs
            )
        else:
            # Migrate entire project with all threads
            success = await migrator.migrate_project(
                project_id=args.project_id,
                staging_account_id=args.staging_account_id,
                skip_messages=args.skip_messages,
                skip_agent_runs=args.skip_agent_runs
            )

        sys.exit(0 if success else 1)

    except KeyboardInterrupt:
        print("\n\nOperation cancelled by user")
        sys.exit(1)
    except Exception as e:
        print(f"\nERROR: {e}")
        logger.error(f"Migration failed: {e}", exc_info=True)
        sys.exit(1)
    finally:
        await migrator.close()


if __name__ == "__main__":
    asyncio.run(main())