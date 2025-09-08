#!/usr/bin/env python3
"""
Test script to verify model context window limits.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from core.ai_models import model_manager

def test_model_limits():
    """Test the model context window limits."""
    
    print("=== All Model Context Windows ===")
    all_models = model_manager.get_all_models()
    for model in sorted(all_models, key=lambda m: m.id):
        print(f'{model.id}: {model.context_window:,} tokens')

    print("\n=== Testing get_context_window function ===")
    test_models = [
        'gpt-5', 
        'sonnet-3.5', 
        'gemini-2.5-pro', 
        'claude-sonnet-4', 
        'grok-4', 
        'unknown-model',
        'anthropic/claude-sonnet-4-20250514',
        'openai/gpt-5-mini'
    ]
    
    for model in test_models:
        window = model_manager.get_context_window(model)
        print(f'{model}: {window:,} tokens')

    print("\n=== Context Manager Logic Simulation ===")
    for model in ['gpt-5', 'anthropic/claude-sonnet-4', 'gemini/gemini-2.5-pro', 'unknown-model']:
        context_window = model_manager.get_context_window(model)
        
        # Simulate the logic from context manager
        if context_window >= 1_000_000:  # Very large context models (Gemini)
            max_tokens = context_window - 300_000
        elif context_window >= 400_000:  # Large context models (GPT-5)
            max_tokens = context_window - 64_000
        elif context_window >= 200_000:  # Medium context models (Claude Sonnet)
            max_tokens = context_window - 32_000
        elif context_window >= 100_000:  # Standard large context models
            max_tokens = context_window - 16_000
        else:  # Smaller context models
            max_tokens = context_window - 8_000
        
        print(f'{model}: context={context_window:,} → effective_limit={max_tokens:,} (reserved: {context_window-max_tokens:,})')

if __name__ == "__main__":
    test_model_limits()
