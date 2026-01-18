#!/usr/bin/env python3
"""
Test script for LLM configuration.
Tests kortix/basic and kortix/power models with the configured MAIN_LLM provider.
"""

import asyncio
import os
import sys

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv()

from core.utils.config import get_config
from core.ai_models import registry


def print_model_info(model_id: str):
    """Print detailed info about a model."""
    model = registry.get(model_id)
    if not model:
        print(f"  ❌ Model '{model_id}' not found!")
        return None
    
    print(f"  ✓ ID: {model.id}")
    print(f"    Name: {model.name}")
    print(f"    LiteLLM ID: {model.litellm_model_id}")
    print(f"    Provider: {model.provider.value}")
    print(f"    Context Window: {model.context_window:,} tokens")
    print(f"    Capabilities: {[c.value for c in model.capabilities]}")
    if model.pricing:
        print(f"    Pricing: ${model.pricing.input_cost_per_million_tokens}/M input, ${model.pricing.output_cost_per_million_tokens}/M output")
    return model


async def test_llm_call(model_id: str):
    """Test an actual LLM call."""
    try:
        import litellm
        
        model = registry.get(model_id)
        if not model:
            print(f"  ❌ Model '{model_id}' not found!")
            return False
        
        params = registry.get_litellm_params(model_id)
        print(f"  LiteLLM params: {params}")
        
        print(f"  Calling {model.litellm_model_id}...")
        
        response = await litellm.acompletion(
            messages=[{"role": "user", "content": "Say 'Hello from Grok!' in exactly 5 words."}],
            **params
        )
        
        content = response.choices[0].message.content
        print(f"  ✓ Response: {content}")
        
        if response.usage:
            print(f"    Tokens: {response.usage.prompt_tokens} input, {response.usage.completion_tokens} output")
        
        return True
        
    except Exception as e:
        print(f"  ❌ Error: {e}")
        return False


async def main():
    config = get_config()
    
    print("=" * 60)
    print("LLM Configuration Test")
    print("=" * 60)
    print()
    
    # Show current config
    print(f"Environment: {config.ENV_MODE.value}")
    print(f"MAIN_LLM: {config.MAIN_LLM}")
    print()
    
    # Test model registry
    print("-" * 60)
    print("Model Registry Info")
    print("-" * 60)
    
    print("\n[kortix/basic]")
    basic_model = print_model_info("kortix/basic")
    
    print("\n[kortix/power]")
    power_model = print_model_info("kortix/power")
    
    print("\n[kortix/grok-4-1-fast]")
    grok_model = print_model_info("kortix/grok-4-1-fast")
    
    # Test actual LLM calls
    print()
    print("-" * 60)
    print("LLM Call Tests")
    print("-" * 60)
    
    print("\n[Testing kortix/basic]")
    basic_ok = await test_llm_call("kortix/basic")
    
    print("\n[Testing kortix/power]")
    power_ok = await test_llm_call("kortix/power")
    
    # Summary
    print()
    print("=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"  kortix/basic:  {'✓ PASS' if basic_ok else '❌ FAIL'}")
    print(f"  kortix/power:  {'✓ PASS' if power_ok else '❌ FAIL'}")
    print()
    
    if basic_ok and power_ok:
        print("All tests passed! 🎉")
        return 0
    else:
        print("Some tests failed.")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
