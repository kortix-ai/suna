import asyncio
import time
import sys
import json
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, "/Users/saumya/Desktop/suna/backend")

from core.context_engine import ContextEngine, ContextChunk, ImportanceLevel
from core.context_engine.types import LayerType
from core.context_engine.sources.base import ContextSource
from core.context_engine.utils.tokens import count_tokens
from core.utils.logger import logger

OUTPUT_FILE = Path("/Users/saumya/Desktop/suna/backend/core/context_engine/tests/stress_test_output.json")


class MockThreadSource(ContextSource):
    def __init__(self, messages: List[Dict[str, Any]]):
        super().__init__(name="mock_thread", priority=100)
        self._messages = messages
    
    def get_priority(self) -> int:
        return self._priority
    
    async def fetch(
        self,
        thread_id: str,
        account_id: str,
        query: Optional[str] = None,
        limit_tokens: Optional[int] = None,
    ) -> List[ContextChunk]:
        chunks = []
        for i, msg in enumerate(self._messages):
            content = msg.get("content", "")
            importance = ImportanceLevel.NORMAL
            if msg.get("pinned"):
                importance = ImportanceLevel.PINNED
            elif msg.get("important"):
                importance = ImportanceLevel.HIGH
            
            chunks.append(ContextChunk(
                content=content,
                source="mock_thread",
                tokens=count_tokens(content),
                priority=0.8 if msg.get("role") == "user" else 0.6,
                created_at=msg.get("created_at"),
                message_id=f"msg_{i}",
                metadata={"role": msg.get("role", "user")},
                importance=importance,
            ))
        return chunks


def generate_mock_messages(count: int, include_pinned: bool = True) -> List[Dict[str, Any]]:
    messages = []
    base_time = datetime.now(timezone.utc) - timedelta(hours=count)
    
    for i in range(count):
        role = "user" if i % 2 == 0 else "assistant"
        
        if role == "user":
            content = f"User message {i}: " + "This is a test message with some content. " * 10
        else:
            content = f"Assistant response {i}: " + "Here is my detailed response to your query. " * 20
            if i % 4 == 1:
                content += '\n\nTool output:\n{"success": true, "data": "' + "x" * 500 + '"}'
        
        msg = {
            "role": role,
            "content": content,
            "created_at": base_time + timedelta(minutes=i * 5),
        }
        
        if include_pinned and i == 5:
            msg["pinned"] = True
            msg["content"] = "IMPORTANT: Remember my API key is sk-test-12345. " + content
        
        messages.append(msg)
    
    return messages


async def run_stress_test():
    print("\n" + "=" * 60)
    print("ContextEngine Stress Test (Improved Version)")
    print("=" * 60 + "\n")
    
    test_sizes = [10, 50, 100, 200, 500]
    
    results = []
    
    for size in test_sizes:
        print(f"\n--- Testing with {size} messages ---")
        
        messages = generate_mock_messages(size)
        mock_source = MockThreadSource(messages)
        
        engine = ContextEngine(
            sources=[mock_source],
            layers={
                "working": {"messages": 10, "tokens": 30000},
                "recent": {"messages": 30, "tokens": 40000},
                "historical": {"messages": 100, "tokens": 30000},
                "archived": {"tokens": 10000},
            },
            total_budget=150_000,
            enable_embeddings=False,
        )
        
        start_time = time.time()
        
        result = await engine.compile(
            thread_id="test-thread-id",
            account_id="test_account",
            query="Test query for context compilation",
        )
        
        elapsed = (time.time() - start_time) * 1000
        
        print(f"  Messages in: {size}")
        print(f"  Messages out: {len(result.messages)}")
        print(f"  Total tokens: {result.token_count}")
        print(f"  Time: {elapsed:.1f}ms")
        print(f"  Layer distribution:")
        for layer_name, stats in result.layer_stats.items():
            print(f"    {layer_name}: {stats.messages} msgs, {stats.tokens} tokens")
        print(f"  Compression stats: {result.compression_stats}")
        
        results.append({
            "input_messages": size,
            "output_messages": len(result.messages),
            "tokens": result.token_count,
            "time_ms": elapsed,
        })
    
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"{'Input Msgs':<12} {'Output Msgs':<12} {'Tokens':<10} {'Time (ms)':<10}")
    print("-" * 44)
    for r in results:
        print(f"{r['input_messages']:<12} {r['output_messages']:<12} {r['tokens']:<10} {r['time_ms']:<10.1f}")
    
    print("\n✅ Stress test complete!")
    
    max_result = results[-1]
    if max_result["tokens"] <= 150_000:
        print(f"✅ Token budget respected: {max_result['tokens']} <= 150,000")
    else:
        print(f"❌ Token budget exceeded: {max_result['tokens']} > 150,000")


async def run_pinned_test():
    print("\n" + "=" * 60)
    print("Pinned Message Test")
    print("=" * 60 + "\n")
    
    messages = generate_mock_messages(200, include_pinned=True)
    mock_source = MockThreadSource(messages)
    
    engine = ContextEngine(
        sources=[mock_source],
        layers={
            "working": {"messages": 10, "tokens": 30000},
            "recent": {"messages": 30, "tokens": 40000},
            "historical": {"messages": 100, "tokens": 30000},
            "archived": {"tokens": 10000},
        },
        total_budget=150_000,
        enable_embeddings=False,
    )
    
    result = await engine.compile(
        thread_id="test-thread-id",
        account_id="test_account",
    )
    
    pinned_found = False
    for msg in result.messages:
        if "IMPORTANT" in msg.get("content", "") and "API key" in msg.get("content", ""):
            pinned_found = True
            print(f"✅ Pinned message preserved in output!")
            print(f"   Content preview: {msg['content'][:100]}...")
            break
    
    if not pinned_found:
        print("❌ Pinned message NOT found in output!")
    
    print(f"\n✅ Pinned message test complete!")


async def run_layer_test():
    print("\n" + "=" * 60)
    print("Layer Distribution Test")
    print("=" * 60 + "\n")
    
    messages = generate_mock_messages(150)
    mock_source = MockThreadSource(messages)
    
    engine = ContextEngine(
        sources=[mock_source],
        layers={
            "working": {"messages": 10, "tokens": 30000},
            "recent": {"messages": 30, "tokens": 40000},
            "historical": {"messages": 100, "tokens": 30000},
            "archived": {"tokens": 10000},
        },
        total_budget=150_000,
        enable_embeddings=False,
    )
    
    result = await engine.compile(
        thread_id="test-thread-id",
        account_id="test_account",
    )
    
    output_data = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "thread_id": "test-thread-id",
        "total_tokens": result.token_count,
        "total_messages": len(result.messages),
        "layer_stats": {
            (layer.value if hasattr(layer, "value") else layer): {
                "messages": stats.messages,
                "tokens": stats.tokens,
            }
            for layer, stats in result.layer_stats.items()
        },
        "compression_stats": result.compression_stats,
    }
    
    print("Layer stats:")
    for layer_name, stats in result.layer_stats.items():
        print(f"  {layer_name}: {stats.messages} msgs, {stats.tokens} tokens, compressed={stats.compression_applied}")
    
    print(f"\nCompression stats: {result.compression_stats}")
    
    OUTPUT_FILE.write_text(json.dumps(output_data, indent=2, default=str))
    print(f"\n📁 Output saved to: {OUTPUT_FILE}")
    print(f"\n✅ Layer distribution test complete!")


async def main():
    await run_stress_test()
    await run_pinned_test()
    await run_layer_test()


if __name__ == "__main__":
    print("Starting ContextEngine tests...\n")
    asyncio.run(main())
