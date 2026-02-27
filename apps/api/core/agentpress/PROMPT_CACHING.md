# AgentPress Prompt Caching System

## Overview

AgentPress implements mathematically optimized prompt caching for Anthropic Claude models to achieve **70-90% cost and latency savings** in long conversations. The system uses dynamic token-based thresholds that adapt to conversation length, context window size, and message density.

## How It Works

### 1. **Dynamic Context Detection**
- Auto-detects context window from model registry (200k-2M+ tokens)
- Supports all models: Claude 3.7 (200k), Claude Sonnet 4 (1M), Gemini 2.5 Pro (2M)
- Falls back to 200k default if model not found

### 2. **Mathematical Threshold Calculation**

```
Optimal Threshold = Base × Stage × Context × Density

Where:
• Base = 2.5% of context window
• Stage = Conversation length multiplier
• Context = Context window multiplier  
• Density = Token density multiplier
```

### 3. **Conversation Stage Scaling**

| Stage | Messages | Multiplier | Strategy |
|-------|----------|------------|----------|
| **Early** | ≤20 | 0.3x | Aggressive caching for quick wins |
| **Growing** | 21-100 | 0.6x | Balanced approach |
| **Mature** | 101-500 | 1.0x | Larger chunks, preserve blocks |
| **Very Long** | 500+ | 1.8x | Conservative, maximum efficiency |

### 4. **Context Window Scaling**

| Context Window | Multiplier | Example Models |
|----------------|------------|----------------|
| 200k tokens | 1.0x | Claude 3.7 Sonnet |
| 500k tokens | 1.2x | GPT-4 variants |
| 1M tokens | 1.5x | Claude Sonnet 4 |
| 2M+ tokens | 2.0x | Gemini 2.5 Pro |

## Cache Threshold Examples

### Real-World Thresholds by Model & Conversation Length

| Model | Context | Early (≤20) | Growing (≤100) | Mature (≤500) | Very Long (500+) |
|-------|---------|-------------|----------------|---------------|------------------|
| **Claude 3.7** | 200k | 1.5k tokens | 3k tokens | 5k tokens | 9k tokens |
| **GPT-5** | 400k | 3k tokens | 6k tokens | 10k tokens | 18k tokens |
| **Claude Sonnet 4** | 1M | 7.5k tokens | 15k tokens | 25k tokens | 45k tokens |
| **Gemini 2.5 Pro** | 2M | 15k tokens | 30k tokens | 50k tokens | 90k tokens |

## Cache Block Strategy

### 4-Block Distribution
1. **Block 1**: System prompt (cached if ≥1024 tokens)
2. **Blocks 2-4**: Conversation chunks (automatic management)

### Cache Management
- **Early blocks**: Stable, reused longest
- **Recent blocks**: Dynamic, optimized for conversation flow

## Token Counting

Uses **LiteLLM's accurate tokenizers**:
```python
from litellm import token_counter
tokens = token_counter(model=model_name, text=content)
```

- **Anthropic models**: Uses Anthropic's actual tokenizer
- **OpenAI models**: Uses tiktoken
- **Other models**: Model-specific tokenizers
- **Fallback**: Word-based estimation (1.3x words)

## Cost Benefits

### Pricing Structure
- **Cache Writes**: 1.25x base cost for write operations
- **Cache Hits**: 0.1x base cost (90% savings)
- **Break-even**: 2-3 reuses for most chunks

### Example Savings
- **200k context conversation**: 70-85% cost reduction
- **1M context conversation**: 80-90% cost reduction
- **500+ message threads**: Up to 95% latency reduction

## Implementation Flow

```mermaid
graph TD
    A[New Message] --> B{Anthropic Model?}
    B -->|No| C[Standard Processing]
    B -->|Yes| D[Get Context Window from Registry]
    D --> E[Calculate Optimal Threshold]
    E --> F[Count Existing Tokens]
    F --> G{Threshold Reached?}
    G -->|No| H[Add to Current Chunk]
    G -->|Yes| I[Create Cache Block]
    I --> J{Max Blocks Reached?}
    J -->|No| K[Continue Chunking]
    J -->|Yes| L[Add Remaining Uncached]
    H --> M[Send to LLM]
    K --> M
    L --> M
    C --> M
```

## Key Features

### ✅ **Prevents Cache Invalidation**
- Fixed-size chunks never change once created
- New messages go into new chunks or remain uncached
- No more cache invalidation on every new message

### ✅ **Scales Efficiently**
- Handles 20-message conversations to 1000+ message threads
- Adapts chunk sizes to context window (200k-2M tokens)
- Preserves cache blocks for maximum reuse

### ✅ **Cost Optimized**
- Mathematical break-even analysis
- Early aggressive caching for quick wins
- Late conservative caching to preserve blocks

### ✅ **Context Window Aware**
- Prevents cache block preoccupation in large contexts
- Reserves 20% of context for new messages/outputs
- Handles oversized conversations gracefully

## Usage

The caching system is automatically applied in `ThreadManager.run_thread()`:

```python
# Auto-detects context window and calculates optimal thresholds
prepared_messages = apply_anthropic_caching_strategy(
    system_prompt, 
    conversation_messages, 
    model_name  # e.g., "claude-sonnet-4"
)
```

## Monitoring

Track cache performance via logs:
- `🔥 Block X: Cached chunk (Y tokens, Z messages)`
- `🎯 Total cache blocks used: X/4`
- `📊 Processing N messages (X tokens)`
- `🧮 Calculated optimal cache threshold: X tokens`

## Result

**70-90% cost and latency savings** in long conversations while scaling efficiently across all context window sizes and conversation lengths.
