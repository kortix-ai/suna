#!/usr/bin/env python3
"""
Simple example demonstrating z.ai integration with Suna.

This example shows how to use z.ai models in your application.
"""

import asyncio
import os
from typing import List, Dict, Any

# Example usage patterns for z.ai integration


def setup_z_ai_environment():
    """
    Example of how to set up z.ai in your environment.
    
    You would typically set these in your .env file:
    Z_AI_API_KEY=your_api_key_here
    MODEL_TO_USE=z.ai/claude-3-5-sonnet
    """
    
    # For testing purposes, you can set environment variables programmatically
    # In production, use .env file
    
    if not os.getenv('Z_AI_API_KEY'):
        print("⚠️  Z_AI_API_KEY not set. Please set it in your .env file:")
        print("   Z_AI_API_KEY=your_z_ai_api_key")
        return False
    
    return True


async def example_basic_completion():
    """Example: Basic text completion with z.ai."""
    
    # This would normally be imported from your Suna backend
    # from services.llm import make_llm_api_call
    
    print("📝 Example: Basic text completion")
    print("   Model: z.ai/claude-3-5-sonnet")
    print("   Input: 'Explain quantum computing in simple terms'")
    print("   Expected: A clear explanation of quantum computing")
    
    # Example API call structure
    api_call_example = {
        "model_name": "z.ai/claude-3-5-sonnet",
        "messages": [
            {"role": "user", "content": "Explain quantum computing in simple terms"}
        ],
        "temperature": 0.7,
        "max_tokens": 200
    }
    
    print(f"   API Call: {api_call_example}")


async def example_conversation():
    """Example: Multi-turn conversation with z.ai."""
    
    print("\n💬 Example: Multi-turn conversation")
    print("   Model: z.ai/gpt-4o")
    
    conversation = [
        {"role": "user", "content": "What's the capital of France?"},
        {"role": "assistant", "content": "The capital of France is Paris."},
        {"role": "user", "content": "What's the population of that city?"},
    ]
    
    api_call_example = {
        "model_name": "z.ai/gpt-4o", 
        "messages": conversation,
        "temperature": 0.5,
        "max_tokens": 150
    }
    
    print(f"   Conversation: {conversation}")
    print(f"   API Call: {api_call_example}")


async def example_streaming():
    """Example: Streaming response with z.ai."""
    
    print("\n🌊 Example: Streaming response")
    print("   Model: z.ai/claude-3-5-sonnet")
    print("   Feature: Real-time streaming output")
    
    api_call_example = {
        "model_name": "z.ai/claude-3-5-sonnet",
        "messages": [
            {"role": "user", "content": "Write a short poem about AI"}
        ],
        "stream": True,
        "temperature": 0.8,
        "max_tokens": 200
    }
    
    print(f"   API Call: {api_call_example}")
    print("   Output: [Streaming chunks would appear here in real-time]")


async def example_function_calling():
    """Example: Function calling with z.ai."""
    
    print("\n🔧 Example: Function calling")
    print("   Model: z.ai/claude-3-5-sonnet")
    print("   Feature: Tool/function calling")
    
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get current weather for a location",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {
                            "type": "string",
                            "description": "The city and country, e.g. San Francisco, CA"
                        },
                        "unit": {
                            "type": "string", 
                            "enum": ["celsius", "fahrenheit"],
                            "description": "Temperature unit"
                        }
                    },
                    "required": ["location"]
                }
            }
        }
    ]
    
    api_call_example = {
        "model_name": "z.ai/claude-3-5-sonnet",
        "messages": [
            {"role": "user", "content": "What's the weather like in Tokyo?"}
        ],
        "tools": tools,
        "tool_choice": "auto",
        "temperature": 0.1
    }
    
    print(f"   Tools: {tools[0]['function']['name']}")
    print(f"   API Call: {api_call_example}")


def example_model_selection():
    """Example: Choosing the right z.ai model."""
    
    print("\n🎯 Example: Model selection guide")
    
    models = {
        "z.ai/claude-3-5-sonnet": {
            "best_for": ["Complex reasoning", "Code analysis", "Long conversations"],
            "context_window": "Large",
            "speed": "Medium",
            "cost": "Medium"
        },
        "z.ai/gpt-4o": {
            "best_for": ["General tasks", "Creative writing", "Problem solving"],
            "context_window": "Large", 
            "speed": "Medium",
            "cost": "Medium"
        },
        "z.ai/gpt-4o-mini": {
            "best_for": ["Simple tasks", "Fast responses", "High volume"],
            "context_window": "Medium",
            "speed": "Fast",
            "cost": "Low"
        },
        "z.ai/claude-3-haiku": {
            "best_for": ["Quick tasks", "Low latency", "Cost efficiency"],
            "context_window": "Medium",
            "speed": "Very Fast", 
            "cost": "Very Low"
        }
    }
    
    for model, specs in models.items():
        print(f"   {model}:")
        print(f"     Best for: {', '.join(specs['best_for'])}")
        print(f"     Context: {specs['context_window']}, Speed: {specs['speed']}, Cost: {specs['cost']}")


def example_error_handling():
    """Example: Error handling with z.ai."""
    
    print("\n🛡️  Example: Error handling")
    
    common_errors = {
        "401 Unauthorized": "Check your Z_AI_API_KEY",
        "429 Rate Limited": "Reduce request frequency or upgrade plan",
        "404 Model Not Found": "Verify model name (e.g., z.ai/claude-3-5-sonnet)",
        "500 Server Error": "z.ai service issue, automatic retry will occur"
    }
    
    for error, solution in common_errors.items():
        print(f"   {error}: {solution}")
    
    print("\n   Automatic features:")
    print("   - Retry with exponential backoff")
    print("   - Fallback to OpenRouter if z.ai fails")
    print("   - Comprehensive error logging")


async def main():
    """Main example function."""
    
    print("🚀 Z.ai Integration Examples for Suna")
    print("=" * 60)
    
    if not setup_z_ai_environment():
        print("\n❌ Environment not configured. Please set up z.ai API key.")
        return
    
    # Show different usage examples
    await example_basic_completion()
    await example_conversation()
    await example_streaming()
    await example_function_calling()
    example_model_selection()
    example_error_handling()
    
    print("\n" + "=" * 60)
    print("✅ All examples shown!")
    print("\nNext steps:")
    print("1. Set your Z_AI_API_KEY in .env")
    print("2. Choose a model (e.g., z.ai/claude-3-5-sonnet)")
    print("3. Start building with z.ai!")
    print("\nFor more details, see: docs/Z_AI_INTEGRATION.md")


if __name__ == "__main__":
    asyncio.run(main())
