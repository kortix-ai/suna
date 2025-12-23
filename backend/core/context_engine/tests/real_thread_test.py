import asyncio
import sys
import json
from pathlib import Path

sys.path.insert(0, "/Users/saumya/Desktop/suna/backend")

from core.context_engine import ContextEngine
from core.context_engine.types import LayerType


REAL_THREAD_ID = "2cec5488-d75c-49ba-acd3-95f987c77c6e"
ACCOUNT_ID = "892d6ada-59c5-42ad-8c1f-5a3e64557502"


async def test_real_thread():
    print("\n" + "=" * 70)
    print("REAL THREAD TEST")
    print("=" * 70)
    print(f"\nThread ID: {REAL_THREAD_ID}")
    print("Testing with actual database messages...\n")
    
    engine = ContextEngine(
        layers={
            "working": {"messages": 10, "tokens": 50000},
            "recent": {"messages": 30, "tokens": 80000},
            "historical": {"messages": 100, "tokens": 100000},
            "archived": {"tokens": 30000},
        },
        total_budget=250_000,
    )
    
    print("Sources:", engine.get_sources())
    
    result = await engine.compile(
        thread_id=REAL_THREAD_ID,
        account_id=ACCOUNT_ID,
    )
    
    print(f"\n{'─' * 70}")
    print("RESULTS")
    print(f"{'─' * 70}")
    
    print(f"\n  Total messages: {len(result.messages)}")
    print(f"  Total tokens: {result.token_count}")
    
    print(f"\n  Layer Distribution:")
    for layer, stats in result.layer_stats.items():
        layer_name = layer.value if hasattr(layer, 'value') else layer
        print(f"    {layer_name}: {stats.messages} msgs, {stats.tokens} tokens")
    
    print(f"\n  Sources Used:")
    for source, tokens in result.sources_used.items():
        print(f"    {source}: {tokens} tokens")
    
    print(f"\n{'─' * 70}")
    print("MESSAGE PREVIEW")
    print(f"{'─' * 70}")
    
    for layer_type, chunks in result.chunks_by_layer.items():
        layer_name = layer_type.value if hasattr(layer_type, 'value') else layer_type
        print(f"\n  {layer_name.upper()} ({len(chunks)} chunks):")
        
        for i, chunk in enumerate(chunks[:3]):
            content = chunk.content
            if len(content) > 100:
                preview = content[:100] + "..."
            else:
                preview = content
            preview = preview.replace('\n', ' ')
            role = chunk.metadata.get('role', 'unknown')
            print(f"    [{role}] {preview}")
        
        if len(chunks) > 3:
            print(f"    ... and {len(chunks) - 3} more")
    
    output_data = {
        "thread_id": REAL_THREAD_ID,
        "total_messages": len(result.messages),
        "total_tokens": result.token_count,
        "layer_stats": {
            (layer.value if hasattr(layer, 'value') else layer): {
                "messages": stats.messages,
                "tokens": stats.tokens
            }
            for layer, stats in result.layer_stats.items()
        },
        "sources_used": result.sources_used,
        "messages": result.messages[:20],
    }
    
    output_path = Path("/Users/saumya/Desktop/suna/backend/core/context_engine/tests/real_thread_output.json")
    output_path.write_text(json.dumps(output_data, indent=2, default=str))
    
    print(f"\n{'─' * 70}")
    print("VALIDATION")
    print(f"{'─' * 70}")
    
    budget_ok = result.token_count <= 250_000
    has_messages = len(result.messages) > 0
    has_working = result.layer_stats.get('working', result.layer_stats.get(LayerType.WORKING))
    working_ok = has_working and has_working.messages > 0
    
    print(f"\n  ✅ Within budget (250k): {'YES' if budget_ok else 'NO'} ({result.token_count} tokens)")
    print(f"  ✅ Has messages: {'YES' if has_messages else 'NO'} ({len(result.messages)} messages)")
    print(f"  ✅ Working layer has content: {'YES' if working_ok else 'NO'}")
    
    if budget_ok and has_messages and working_ok:
        print(f"\n✅ REAL THREAD TEST PASSED!")
    else:
        print(f"\n❌ REAL THREAD TEST FAILED!")
    
    print(f"\n📁 Full output saved to: {output_path}")


async def analyze_thread_content():
    print("\n" + "=" * 70)
    print("THREAD CONTENT ANALYSIS")
    print("=" * 70)
    
    from core.context_engine.sources.thread import ThreadSource
    
    source = ThreadSource()
    chunks = await source.fetch(
        thread_id=REAL_THREAD_ID,
        account_id=ACCOUNT_ID,
        limit_tokens=None,
    )
    
    print(f"\n  Total chunks: {len(chunks)}")
    total_tokens = sum(c.tokens for c in chunks)
    print(f"  Total tokens: {total_tokens}")
    
    if chunks:
        avg_tokens = total_tokens / len(chunks)
        max_tokens = max(c.tokens for c in chunks)
        min_tokens = min(c.tokens for c in chunks)
        
        print(f"\n  Token stats:")
        print(f"    Average: {avg_tokens:.0f} tokens/message")
        print(f"    Max: {max_tokens} tokens")
        print(f"    Min: {min_tokens} tokens")
        
        large_chunks = [c for c in chunks if c.tokens > 10000]
        print(f"\n  Large messages (>10k tokens): {len(large_chunks)}")
        
        for chunk in large_chunks[:5]:
            role = chunk.metadata.get('role', 'unknown')
            preview = chunk.content[:50] + "..." if len(chunk.content) > 50 else chunk.content
            print(f"    [{role}] {chunk.tokens} tokens - {preview}")
        
        print(f"\n  Messages by role:")
        roles = {}
        for chunk in chunks:
            role = chunk.metadata.get('role', 'unknown')
            roles[role] = roles.get(role, 0) + 1
        for role, count in sorted(roles.items()):
            print(f"    {role}: {count}")


async def main():
    await analyze_thread_content()
    await test_real_thread()


if __name__ == "__main__":
    print("Starting Real Thread Tests...\n")
    asyncio.run(main())
