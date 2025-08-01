# Z.ai Integration for Suna

This document explains how to integrate and use z.ai with Suna.

## What is z.ai?

z.ai is an AI platform that provides access to multiple large language models including Claude and GPT models through a unified API. It offers competitive pricing and performance for AI applications.

## Setup Instructions

### 1. Get your z.ai API Key

1. Visit [z.ai](https://z.ai/)
2. Sign up for an account
3. Navigate to your API settings
4. Generate an API key

### 2. Configure Suna

#### Using the Setup Wizard

Run the Suna setup wizard and select z.ai when prompted for LLM providers:

```bash
python setup.py
```

Select option `5` for z.ai when asked for LLM providers.

#### Manual Configuration

Add your z.ai API key to your environment:

```bash
# In your .env file
Z_AI_API_KEY=your_z_ai_api_key_here
```

### 3. Available Models

Suna supports the following z.ai models:

- `z.ai/claude-3-5-sonnet` - Claude 3.5 Sonnet via z.ai
- `z.ai/gpt-4o` - GPT-4o via z.ai
- `z.ai/gpt-4o-mini` - GPT-4o Mini via z.ai
- `z.ai/claude-3-haiku` - Claude 3 Haiku via z.ai

### 4. Set Default Model

You can set z.ai as your default model:

```bash
# In your .env file
MODEL_TO_USE=z.ai/claude-3-5-sonnet
```

## Usage Examples

### Basic Usage

```python
from services.llm import make_llm_api_call

# Make a simple API call
response = await make_llm_api_call(
    messages=[{"role": "user", "content": "Hello, world!"}],
    model_name="z.ai/claude-3-5-sonnet",
    temperature=0.7,
    max_tokens=100
)
```

### Streaming Response

```python
# Stream responses for real-time output
response = await make_llm_api_call(
    messages=[{"role": "user", "content": "Tell me a story"}],
    model_name="z.ai/gpt-4o",
    stream=True,
    temperature=0.8,
    max_tokens=500
)

async for chunk in response:
    if hasattr(chunk, 'choices') and chunk.choices:
        content = chunk.choices[0].delta.content
        if content:
            print(content, end='', flush=True)
```

### Tool Calling

```python
# Use tools/functions with z.ai models
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string"}
                }
            }
        }
    }
]

response = await make_llm_api_call(
    messages=[{"role": "user", "content": "What's the weather in New York?"}],
    model_name="z.ai/claude-3-5-sonnet",
    tools=tools,
    tool_choice="auto"
)
```

## Features

### ✅ Supported Features

- **Basic Text Generation**: All z.ai models support text generation
- **Streaming Responses**: Real-time streaming output
- **Tool Calling**: Function calling capabilities
- **Conversation History**: Multi-turn conversations
- **Temperature Control**: Adjustable response creativity
- **Token Limits**: Configurable maximum tokens
- **Fallback Support**: Automatic fallback to OpenRouter if z.ai fails

### 🔧 Technical Details

- **API Compatibility**: z.ai uses OpenAI-compatible API format
- **Base URL**: `https://api.z.ai/v1`
- **Authentication**: Bearer token authentication
- **Rate Limits**: Follows z.ai's rate limiting policies
- **Error Handling**: Automatic retry with exponential backoff

## Troubleshooting

### Common Issues

1. **Invalid API Key Error**
   ```
   Error: 401 Unauthorized
   ```
   - Verify your z.ai API key is correct
   - Check that the key has sufficient credits
   - Ensure the key hasn't expired

2. **Model Not Found Error**
   ```
   Error: Model not found
   ```
   - Verify the model name is correct
   - Check z.ai documentation for available models
   - Try using a different model

3. **Rate Limit Exceeded**
   ```
   Error: 429 Too Many Requests
   ```
   - Wait for the rate limit to reset
   - Upgrade your z.ai plan for higher limits
   - Implement request queuing in your application

### Testing Integration

Use the included test script to verify your z.ai integration:

```bash
cd backend
python test_z_ai_integration.py
```

This will test:
- Basic API connectivity
- Different model endpoints
- Streaming functionality
- Error handling

### Debug Mode

Enable debug logging to troubleshoot issues:

```python
import logging
logging.getLogger('services.llm').setLevel(logging.DEBUG)
```

## Pricing Considerations

- z.ai offers competitive pricing compared to direct API access
- Pricing varies by model (Claude vs GPT)
- Consider token usage when choosing between models
- Monitor usage through z.ai dashboard

## Migration from Other Providers

### From OpenAI
Replace `openai/gpt-4o` with `z.ai/gpt-4o`

### From Anthropic
Replace `anthropic/claude-3-5-sonnet` with `z.ai/claude-3-5-sonnet`

### Batch Migration
Update your `MODEL_TO_USE` environment variable:

```bash
# Before
MODEL_TO_USE=anthropic/claude-3-5-sonnet

# After
MODEL_TO_USE=z.ai/claude-3-5-sonnet
```

## Support

For z.ai-specific issues:
- Check [z.ai documentation](https://z.ai/docs)
- Contact z.ai support

For Suna integration issues:
- Open an issue on the Suna GitHub repository
- Check the troubleshooting section above
