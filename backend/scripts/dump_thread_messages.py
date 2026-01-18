#!/usr/bin/env python3
"""
Script to dump all messages from a thread to a JSON file.
Usage: python scripts/dump_thread_messages.py <thread_id> [output_file]
"""

import asyncio
import json
import sys
import os

# Add the backend directory to the path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

async def dump_thread_messages(thread_id: str, output_file: str = None):
    from core.threads import repo as threads_repo
    
    print(f"Fetching messages for thread: {thread_id}")
    
    # Get all messages (not optimized, to get all types)
    messages = await threads_repo.get_thread_messages(
        thread_id=thread_id,
        order="asc",
        optimized=False
    )
    
    if not messages:
        print(f"No messages found for thread {thread_id}")
        return
    
    print(f"Found {len(messages)} messages")
    
    # Convert to serializable format
    output = {
        "thread_id": thread_id,
        "message_count": len(messages),
        "messages": []
    }
    
    for msg in messages:
        msg_data = {
            "message_id": msg.get("message_id"),
            "type": msg.get("type"),
            "is_llm_message": msg.get("is_llm_message"),
            "content": msg.get("content"),
            "metadata": msg.get("metadata"),
            "created_at": str(msg.get("created_at")) if msg.get("created_at") else None,
            "agent_id": msg.get("agent_id"),
        }
        output["messages"].append(msg_data)
    
    # Determine output file
    if output_file is None:
        output_file = f"thread_{thread_id[:8]}_messages.json"
    
    # Write to file
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False, default=str)
    
    print(f"Messages dumped to: {output_file}")
    
    # Print summary
    print("\n=== Message Summary ===")
    type_counts = {}
    for msg in messages:
        msg_type = msg.get("type", "unknown")
        type_counts[msg_type] = type_counts.get(msg_type, 0) + 1
    
    for msg_type, count in sorted(type_counts.items()):
        print(f"  {msg_type}: {count}")
    
    # Print assistant messages with tool_calls
    print("\n=== Assistant Messages with tool_calls ===")
    for msg in messages:
        if msg.get("type") == "assistant":
            metadata = msg.get("metadata", {})
            tool_calls = metadata.get("tool_calls", [])
            content = msg.get("content", {})
            
            print(f"\n  Message ID: {msg.get('message_id')}")
            print(f"  Content keys: {list(content.keys()) if isinstance(content, dict) else type(content)}")
            print(f"  Metadata keys: {list(metadata.keys()) if isinstance(metadata, dict) else type(metadata)}")
            print(f"  tool_calls in metadata: {len(tool_calls)} items")
            
            if tool_calls:
                for tc in tool_calls:
                    print(f"    - {tc.get('function_name')}: {tc.get('arguments')}")

def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/dump_thread_messages.py <thread_id> [output_file]")
        print("Example: python scripts/dump_thread_messages.py b9ee92d2-c636-43da-b04c-b1a2d3cc98b9")
        sys.exit(1)
    
    thread_id = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else None
    
    asyncio.run(dump_thread_messages(thread_id, output_file))

if __name__ == "__main__":
    main()
