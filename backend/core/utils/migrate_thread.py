"""
Migration script to migrate messages in database for a specific thread.

Usage:
    python -m core.utils.migrate_thread <thread_id>
    python -m core.utils.migrate_thread <thread_id> --dry-run
"""
import sys
import argparse

from core.utils.message_migration import migrate_message, needs_migration
from core.utils.json_helpers import safe_json_parse
from core.utils.config import config
from supabase.client import create_client


def migrate_thread_in_db(thread_id: str, dry_run: bool = False):
    """Migrate messages in database for a specific thread."""
    
    # Initialize Supabase client
    client = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY)
    
    print(f"=" * 80)
    print(f"MIGRATING THREAD IN DATABASE: {thread_id}")
    if dry_run:
        print(f"⚠️  DRY RUN MODE - No changes will be written to database")
    print(f"=" * 80)
    
    # Fetch messages
    print("\n1️⃣  Fetching messages from database...")
    result = client.table('messages')\
        .select('*')\
        .eq('thread_id', thread_id)\
        .order('created_at')\
        .execute()
    
    messages = result.data
    print(f"   ✓ Fetched {len(messages)} messages")
    
    # Separate by type for migration
    assistant_messages = [m for m in messages if m.get('type') == 'assistant']
    tool_messages = [m for m in messages if m.get('type') == 'tool']
    
    print(f"\n2️⃣  Migrating assistant messages...")
    migrated_assistants = []
    updated_assistants = 0
    
    for msg in assistant_messages:
        if needs_migration(msg):
            print(f"   Migrating assistant: {msg['message_id']}")
            migrated = migrate_message(msg)
            if migrated:
                migrated_assistants.append(migrated)
                # Update database
                if not dry_run:
                    try:
                        # Get migrated metadata
                        migrated_metadata = safe_json_parse(migrated.get('metadata', '{}'), {})
                        # Update in database
                        client.table('messages')\
                            .update({'metadata': migrated_metadata})\
                            .eq('message_id', msg['message_id'])\
                            .execute()
                        updated_assistants += 1
                        print(f"      ✓ Updated in database")
                    except Exception as e:
                        print(f"      ❌ Error updating: {e}")
                else:
                    print(f"      [DRY RUN] Would update metadata")
                    updated_assistants += 1
            else:
                migrated_assistants.append(msg)
        else:
            print(f"   Skipping (already migrated): {msg['message_id']}")
            migrated_assistants.append(msg)
    
    print(f"\n3️⃣  Migrating tool messages...")
    migrated_tools = []
    updated_tools = 0
    
    for msg in tool_messages:
        if needs_migration(msg):
            print(f"   Migrating tool: {msg['message_id']}")
            migrated = migrate_message(msg, migrated_assistants)
            if migrated:
                migrated_tools.append(migrated)
                # Update database
                if not dry_run:
                    try:
                        # Get migrated metadata
                        migrated_metadata = safe_json_parse(migrated.get('metadata', '{}'), {})
                        # Update in database
                        client.table('messages')\
                            .update({'metadata': migrated_metadata})\
                            .eq('message_id', msg['message_id'])\
                            .execute()
                        updated_tools += 1
                        print(f"      ✓ Updated in database")
                    except Exception as e:
                        print(f"      ❌ Error updating: {e}")
                else:
                    print(f"      [DRY RUN] Would update metadata")
                    updated_tools += 1
            else:
                migrated_tools.append(msg)
        else:
            print(f"   Skipping (already migrated): {msg['message_id']}")
            migrated_tools.append(msg)
    
    # Summary
    print(f"\n{'=' * 80}")
    print(f"MIGRATION SUMMARY")
    print(f"{'=' * 80}")
    print(f"  Assistant messages migrated: {updated_assistants}/{len(assistant_messages)}")
    print(f"  Tool messages migrated: {updated_tools}/{len(tool_messages)}")
    print(f"  Total messages updated: {updated_assistants + updated_tools}")
    
    if dry_run:
        print(f"\n⚠️  DRY RUN - No changes were written to database")
        print(f"   Run without --dry-run flag to apply changes")
    else:
        print(f"\n✅ Migration complete! Database updated successfully.")
    
    # Show sample migrated message
    if migrated_assistants:
        sample = migrated_assistants[0]
        metadata = safe_json_parse(sample.get('metadata', '{}'), {})
        print(f"\n📄 Sample migrated assistant message:")
        print(f"   Message ID: {sample['message_id']}")
        print(f"   Has tool_calls: {'tool_calls' in metadata}")
        print(f"   Has text_content: {'text_content' in metadata}")
        if 'tool_calls' in metadata:
            print(f"   Tool calls: {len(metadata['tool_calls'])}")
    
    if migrated_tools:
        sample = migrated_tools[0]
        metadata = safe_json_parse(sample.get('metadata', '{}'), {})
        print(f"\n📄 Sample migrated tool message:")
        print(f"   Message ID: {sample['message_id']}")
        print(f"   Has result: {'result' in metadata}")
        print(f"   Has tool_call_id: {'tool_call_id' in metadata}")
        print(f"   Function: {metadata.get('function_name')}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Migrate messages in database for a thread')
    parser.add_argument('thread_id', nargs='?', help='Thread ID to migrate')
    parser.add_argument('--dry-run', action='store_true', help='Dry run mode - do not write to database')
    args = parser.parse_args()
    
    if not args.thread_id:
        print("❌ Error: thread_id is required")
        print("Usage: python -m core.utils.migrate_thread <thread_id> [--dry-run]")
        sys.exit(1)
    
    migrate_thread_in_db(args.thread_id, dry_run=args.dry_run)

