#!/usr/bin/env python3
"""
Test script for z.ai API integration.

This script tests the z.ai integration by attempting to make API calls
using the configured parameters.
"""

import os
import sys
import asyncio
from typing import Dict, Any

# Add the current directory to the path so we can import our modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from services.llm import make_llm_api_call
from utils.config import config
from utils.logger import logger


async def test_z_ai_integration():
    """Test z.ai API integration."""
    
    # Check if z.ai API key is configured
    if not config.Z_AI_API_KEY:
        print("❌ Z_AI_API_KEY not configured. Please set it in your environment.")
        return False
    
    print("✅ Z_AI_API_KEY found")
    
    # Test cases for different z.ai models
    test_cases = [
        {
            "name": "z.ai Claude 3.5 Sonnet",
            "model": "z.ai/claude-3-5-sonnet",
            "messages": [{"role": "user", "content": "Hello! Say 'z.ai integration working' if you can read this."}]
        },
        {
            "name": "z.ai GPT-4o",
            "model": "z.ai/gpt-4o",
            "messages": [{"role": "user", "content": "Hello! Say 'z.ai integration working' if you can read this."}]
        }
    ]
    
    for test_case in test_cases:
        print(f"\n🧪 Testing {test_case['name']}...")
        
        try:
            response = await make_llm_api_call(
                messages=test_case["messages"],
                model_name=test_case["model"],
                max_tokens=50,
                temperature=0.1
            )
            
            if hasattr(response, 'choices') and response.choices:
                content = response.choices[0].message.content
                print(f"✅ {test_case['name']} response: {content}")
            else:
                print(f"⚠️  {test_case['name']} returned unexpected response format")
                
        except Exception as e:
            print(f"❌ {test_case['name']} failed: {str(e)}")
            logger.error(f"Test failed for {test_case['name']}: {str(e)}", exc_info=True)
    
    return True


async def test_z_ai_streaming():
    """Test z.ai streaming capability."""
    
    if not config.Z_AI_API_KEY:
        print("❌ Z_AI_API_KEY not configured for streaming test.")
        return False
    
    print("\n🌊 Testing z.ai streaming...")
    
    try:
        response = await make_llm_api_call(
            messages=[{"role": "user", "content": "Count from 1 to 5, each number on a new line."}],
            model_name="z.ai/claude-3-5-sonnet",
            max_tokens=100,
            temperature=0.1,
            stream=True
        )
        
        print("✅ Streaming response:")
        chunk_count = 0
        async for chunk in response:
            if hasattr(chunk, 'choices') and chunk.choices:
                if hasattr(chunk.choices[0], 'delta') and hasattr(chunk.choices[0].delta, 'content'):
                    content = chunk.choices[0].delta.content
                    if content:
                        print(content, end='', flush=True)
                        chunk_count += 1
        
        print(f"\n✅ Streaming completed with {chunk_count} chunks")
        return True
        
    except Exception as e:
        print(f"❌ Streaming test failed: {str(e)}")
        logger.error(f"Streaming test failed: {str(e)}", exc_info=True)
        return False


async def main():
    """Main test function."""
    print("🚀 Starting z.ai API Integration Tests")
    print("=" * 50)
    
    # Test basic integration
    basic_test_result = await test_z_ai_integration()
    
    # Test streaming
    streaming_test_result = await test_z_ai_streaming()
    
    print("\n" + "=" * 50)
    print("📊 Test Results:")
    print(f"Basic Integration: {'✅ PASSED' if basic_test_result else '❌ FAILED'}")
    print(f"Streaming: {'✅ PASSED' if streaming_test_result else '❌ FAILED'}")
    
    if basic_test_result and streaming_test_result:
        print("\n🎉 All tests passed! z.ai integration is working correctly.")
    else:
        print("\n⚠️  Some tests failed. Please check your configuration and try again.")


if __name__ == "__main__":
    asyncio.run(main())
