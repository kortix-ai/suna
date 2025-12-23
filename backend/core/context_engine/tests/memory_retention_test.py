import asyncio
import sys
import json
from typing import List, Dict, Any
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, "/Users/saumya/Desktop/suna/backend")

from core.context_engine import ContextEngine
from core.context_engine.types import ContextChunk
from core.context_engine.sources.base import ContextSource


class MemoryTestSource(ContextSource):
    def __init__(self, messages: List[Dict[str, Any]]):
        super().__init__(name="memory_test", priority=100)
        self._messages = messages
    
    def get_priority(self) -> int:
        return self._priority
    
    async def fetch(
        self,
        thread_id: str,
        account_id: str,
        query: str = None,
        limit_tokens: int = None,
    ) -> List[ContextChunk]:
        chunks = []
        for i, msg in enumerate(self._messages):
            content = msg.get("content", "")
            chunks.append(ContextChunk(
                content=content,
                source="memory_test",
                tokens=len(content.split()) * 2,
                priority=0.9 if msg.get("important") else (0.8 if msg.get("role") == "user" else 0.6),
                created_at=msg.get("created_at"),
                message_id=f"msg_{i}",
                metadata={"role": msg.get("role", "user"), "important": msg.get("important", False)},
            ))
        return chunks


KEY_FACTS = [
    {"fact": "user_name", "value": "Saumyapratim Das", "message": "My name is Saumyapratim Das, please remember this."},
    {"fact": "location", "value": "Kolkata", "message": "I live in Kolkata, India. This is important context."},
    {"fact": "profession", "value": "Communications Engineer", "message": "I'm an Electronics and Communications Engineer."},
    {"fact": "project", "value": "Suna", "message": "I'm building Suna, an AI agent platform. This is my main project."},
    {"fact": "preference", "value": "Python", "message": "My favorite programming language is Python."},
    {"fact": "goal", "value": "context management", "message": "My current goal is to build a scalable context management system."},
    {"fact": "api_key", "value": "sk-secret-12345", "message": "For this task, use API key sk-secret-12345 (remember this)."},
    {"fact": "deadline", "value": "December 25th", "message": "The deadline for this project is December 25th."},
]


def generate_realistic_conversation(total_messages: int) -> List[Dict[str, Any]]:
    messages = []
    base_time = datetime.now(timezone.utc) - timedelta(hours=total_messages)
    
    fact_positions = [5, 15, 30, 50, 80, 120, 180, 250]
    
    for i in range(total_messages):
        role = "user" if i % 2 == 0 else "assistant"
        
        fact_idx = None
        for idx, pos in enumerate(fact_positions):
            if i == pos and idx < len(KEY_FACTS):
                fact_idx = idx
                break
        
        if fact_idx is not None:
            fact = KEY_FACTS[fact_idx]
            if role == "user":
                content = fact["message"]
            else:
                content = f"I understand. I've noted that {fact['value']}. I'll remember this for our conversation."
            important = True
        else:
            if role == "user":
                topics = [
                    "Can you help me with this code?",
                    "What do you think about this approach?",
                    "Let me share some more context about my problem.",
                    "Here's an update on what I tried.",
                    "I have a question about the implementation.",
                ]
                content = topics[i % len(topics)] + f" (Message {i})"
            else:
                responses = [
                    "I'd be happy to help with that. Let me analyze the situation.",
                    "Based on what you've shared, I think we should consider...",
                    "That's a good approach. Here are some suggestions...",
                    "I see what you mean. Let me provide some guidance...",
                    "Great progress! Here's what I recommend next...",
                ]
                content = responses[i % len(responses)] + f" (Response {i})"
            important = False
        
        messages.append({
            "role": role,
            "content": content,
            "created_at": base_time + timedelta(minutes=i * 2),
            "important": important,
        })
    
    return messages


def check_fact_retention(result, fact: Dict[str, str]) -> Dict[str, Any]:
    all_content = ""
    
    for msg in result.messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            all_content += content.lower() + "\n"
    
    value_lower = fact["value"].lower()
    found = value_lower in all_content
    
    location = None
    if found:
        for layer_type, chunks in result.chunks_by_layer.items():
            for chunk in chunks:
                if value_lower in chunk.content.lower():
                    layer_name = layer_type.value if hasattr(layer_type, 'value') else layer_type
                    location = layer_name
                    break
            if location:
                break
    
    return {
        "fact": fact["fact"],
        "value": fact["value"],
        "found": found,
        "location": location,
    }


async def run_memory_retention_test():
    print("\n" + "=" * 70)
    print("MEMORY RETENTION TEST")
    print("=" * 70)
    print("\nThis test verifies that important information is preserved")
    print("even as conversations grow very long.\n")
    
    test_configs = [
        {"messages": 50, "description": "Short conversation"},
        {"messages": 150, "description": "Medium conversation"},
        {"messages": 300, "description": "Long conversation"},
        {"messages": 500, "description": "Very long conversation"},
    ]
    
    all_results = []
    
    for config in test_configs:
        msg_count = config["messages"]
        print(f"\n{'─' * 70}")
        print(f"Testing: {config['description']} ({msg_count} messages)")
        print(f"{'─' * 70}")
        
        messages = generate_realistic_conversation(msg_count)
        source = MemoryTestSource(messages)
        
        engine = ContextEngine(
            sources=[source],
            layers={
                "working": {"messages": 5, "tokens": 50000},
                "recent": {"messages": 20, "tokens": 60000},
                "historical": {"messages": 100, "tokens": 80000},
                "archived": {"tokens": 20000},
            },
            total_budget=200_000,
        )
        engine.remove_source("thread")
        
        result = await engine.compile(
            thread_id="2cec5488-d75c-49ba-acd3-95f987c77c6e",
            account_id="test_account",
        )
        
        print(f"\n  Input: {msg_count} messages")
        print(f"  Output: {len(result.messages)} messages")
        print(f"  Tokens: {result.token_count}")
        
        print(f"\n  Layer Distribution:")
        for layer, stats in result.layer_stats.items():
            layer_name = layer.value if hasattr(layer, 'value') else layer
            print(f"    {layer_name}: {stats.messages} msgs, {stats.tokens} tokens")
        
        print(f"\n  Key Facts Retention:")
        facts_found = 0
        facts_total = 0
        
        for fact in KEY_FACTS:
            fact_msg_position = [5, 15, 30, 50, 80, 120, 180, 250][KEY_FACTS.index(fact)]
            if fact_msg_position < msg_count:
                facts_total += 1
                retention = check_fact_retention(result, fact)
                
                if retention["found"]:
                    facts_found += 1
                    status = f"✅ FOUND in {retention['location']}"
                else:
                    status = "❌ NOT FOUND"
                
                print(f"    [{fact['fact']}] {fact['value']}: {status}")
        
        retention_rate = (facts_found / facts_total * 100) if facts_total > 0 else 0
        print(f"\n  Retention Rate: {facts_found}/{facts_total} ({retention_rate:.1f}%)")
        
        all_results.append({
            "messages": msg_count,
            "description": config["description"],
            "output_messages": len(result.messages),
            "tokens": result.token_count,
            "facts_found": facts_found,
            "facts_total": facts_total,
            "retention_rate": retention_rate,
        })
    
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"\n{'Messages':<12} {'Output':<10} {'Tokens':<10} {'Facts':<12} {'Retention':<10}")
    print("-" * 54)
    for r in all_results:
        print(f"{r['messages']:<12} {r['output_messages']:<10} {r['tokens']:<10} {r['facts_found']}/{r['facts_total']:<10} {r['retention_rate']:.1f}%")
    
    final_retention = all_results[-1]["retention_rate"]
    if final_retention >= 80:
        print(f"\n✅ PASS: Memory retention is good ({final_retention:.1f}%)")
    elif final_retention >= 50:
        print(f"\n⚠️  WARNING: Memory retention could be better ({final_retention:.1f}%)")
    else:
        print(f"\n❌ FAIL: Memory retention is poor ({final_retention:.1f}%)")
    
    output_path = Path("/Users/saumya/Desktop/suna/backend/core/context_engine/tests/memory_test_output.json")
    output_path.write_text(json.dumps(all_results, indent=2))
    print(f"\n📁 Results saved to: {output_path}")


async def run_edge_case_tests():
    print("\n" + "=" * 70)
    print("EDGE CASE TESTS")
    print("=" * 70)
    
    print("\n1. Testing with very recent important fact...")
    messages = generate_realistic_conversation(100)
    messages.append({
        "role": "user",
        "content": "CRITICAL: The password is 'supersecret123'. Remember this!",
        "created_at": datetime.now(timezone.utc),
        "important": True,
    })
    
    source = MemoryTestSource(messages)
    engine = ContextEngine(
        sources=[source],
        layers={
            "working": {"messages": 5, "tokens": 50000},
            "recent": {"messages": 20, "tokens": 60000},
            "historical": {"messages": 100, "tokens": 80000},
            "archived": {"tokens": 20000},
        },
            total_budget=200_000,
    )
    engine.remove_source("thread")
    
    result = await engine.compile(thread_id="2cec5488-d75c-49ba-acd3-95f987c77c6e", account_id="test")
    
    password_found = any("supersecret123" in str(msg.get("content", "")).lower() for msg in result.messages)
    print(f"   Recent critical fact preserved: {'✅ YES' if password_found else '❌ NO'}")
    
    print("\n2. Testing context window limits...")
    huge_messages = generate_realistic_conversation(1000)
    source = MemoryTestSource(huge_messages)
    engine = ContextEngine(
        sources=[source],
        layers={
            "working": {"messages": 5, "tokens": 50000},
            "recent": {"messages": 20, "tokens": 60000},
            "historical": {"messages": 100, "tokens": 80000},
            "archived": {"tokens": 20000},
        },
            total_budget=200_000,
    )
    engine.remove_source("thread")
    
    result = await engine.compile(thread_id="2cec5488-d75c-49ba-acd3-95f987c77c6e", account_id="test")
    
    within_budget = result.token_count <= 200_000
    print(f"   1000 messages compressed to {result.token_count} tokens")
    print(f"   Within budget (150k): {'✅ YES' if within_budget else '❌ NO'}")
    
    print("\n3. Testing empty conversation...")
    source = MemoryTestSource([])
    engine = ContextEngine(sources=[source], total_budget=150_000)
    engine.remove_source("thread")
    result = await engine.compile(thread_id="2cec5488-d75c-49ba-acd3-95f987c77c6e", account_id="test")
    handles_empty = len(result.messages) == 0
    print(f"   Handles empty gracefully: {'✅ YES' if handles_empty else '❌ NO'}")
    
    print("\n✅ Edge case tests complete!")


async def main():
    await run_memory_retention_test()
    await run_edge_case_tests()


if __name__ == "__main__":
    print("Starting Memory Retention Tests...\n")
    asyncio.run(main())
