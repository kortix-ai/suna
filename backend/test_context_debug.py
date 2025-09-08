#!/usr/bin/env python3
"""
Test script to demonstrate the context manager debug functionality.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from core.agentpress.context_manager import ContextManager

def test_context_compression():
    """Test the context compression with debug output."""
    
    # Create sample messages that will trigger compression
    sample_messages = [
        {
            "role": "system",
            "content": "You are a helpful AI assistant.",
            "message_id": "msg_001"
        },
        {
            "role": "user", 
            "content": "Hello, can you help me with a complex task that involves analyzing a large dataset and generating comprehensive reports? " * 100,  # Make it long
            "message_id": "msg_002"
        },
        {
            "role": "assistant",
            "content": "Certainly! I'd be happy to help you with your dataset analysis and report generation. Let me break this down into manageable steps... " * 200,  # Make it very long
            "message_id": "msg_003"
        },
        {
            "role": "user",
            "content": "Great! Here's my dataset: " + "x" * 10000,  # Large content
            "message_id": "msg_004"
        }
    ]
    
    # Create context manager
    cm = ContextManager()
    
    # Test compression with debug
    print("Testing context compression with debug output...")
    print(f"Original messages count: {len(sample_messages)}")
    
    compressed = cm.compress_messages(
        messages=sample_messages,
        llm_model="gpt-4",
        thread_id="test_thread_123",
        agent_run_id="test_run_456"
    )
    
    print(f"Compressed messages count: {len(compressed)}")
    print(f"Debug files saved to: {cm.debug_dir}")
    
    # List the debug files
    import glob
    debug_files = glob.glob(os.path.join(cm.debug_dir, "*.json"))
    print(f"Debug files created: {len(debug_files)}")
    for file in debug_files[-3:]:  # Show last 3 files
        print(f"  - {os.path.basename(file)}")

if __name__ == "__main__":
    test_context_compression()
