# Migration Guide: Adding z.ai to Your Suna Installation

This guide walks you through adding z.ai support to your existing Suna installation.

## Quick Migration

### 1. For New Installations

If you're setting up Suna for the first time:

```bash
# Run the setup wizard
python setup.py

# When prompted for LLM providers, select option 5 for z.ai
# Enter your z.ai API key when prompted
```

### 2. For Existing Installations

If you already have Suna running:

#### Step 1: Add z.ai API Key

Add your z.ai API key to your `.env` file:

```bash
# Add this line to your backend/.env file
Z_AI_API_KEY=your_z_ai_api_key_here
```

#### Step 2: Update Model Configuration (Optional)

If you want to use z.ai as your default model:

```bash
# Update this line in your backend/.env file
MODEL_TO_USE=z.ai/claude-3-5-sonnet
```

#### Step 3: Restart Suna

```bash
# Restart your Suna services
docker-compose down
docker-compose up -d
```

## Model Migration Examples

### From OpenAI to z.ai

```bash
# Before
MODEL_TO_USE=openai/gpt-4o

# After  
MODEL_TO_USE=z.ai/gpt-4o
```

### From Anthropic to z.ai

```bash
# Before
MODEL_TO_USE=anthropic/claude-3-5-sonnet

# After
MODEL_TO_USE=z.ai/claude-3-5-sonnet
```

### From Other Providers to z.ai

```bash
# From Groq
# Before: MODEL_TO_USE=groq/llama-3-70b
# After:  MODEL_TO_USE=z.ai/claude-3-5-sonnet

# From OpenRouter
# Before: MODEL_TO_USE=openrouter/anthropic/claude-3.5-sonnet
# After:  MODEL_TO_USE=z.ai/claude-3-5-sonnet
```

## Configuration Verification

### Test Your Setup

1. **Check API Key Loading**:
   ```bash
   cd backend
   python -c "import os; print('Z_AI_API_KEY set:', bool(os.getenv('Z_AI_API_KEY')))"
   ```

2. **Test API Connection**:
   ```bash
   cd backend
   python test_z_ai_integration.py
   ```

3. **Verify in Suna UI**:
   - Open your Suna interface
   - Create a new agent or chat
   - Check that z.ai models appear in the model selection dropdown
   - Send a test message to verify functionality

## Available z.ai Models

After migration, you'll have access to these models:

| Model Name | Description | Best For |
|------------|-------------|----------|
| `z.ai/claude-3-5-sonnet` | Claude 3.5 Sonnet via z.ai | Complex reasoning, code analysis |
| `z.ai/gpt-4o` | GPT-4o via z.ai | General tasks, creative writing |
| `z.ai/gpt-4o-mini` | GPT-4o Mini via z.ai | Fast responses, simple tasks |
| `z.ai/claude-3-haiku` | Claude 3 Haiku via z.ai | Quick tasks, low latency |

## Fallback Configuration

z.ai automatically includes fallback support. If z.ai is unavailable:

- z.ai models will fallback to equivalent OpenRouter models
- Your applications will continue working seamlessly
- You'll see fallback notifications in the logs

## Cost Optimization

### Choosing the Right Model

For cost optimization, consider:

1. **Development/Testing**: Use `z.ai/claude-3-haiku` or `z.ai/gpt-4o-mini`
2. **Production (Simple Tasks)**: Use `z.ai/gpt-4o-mini`
3. **Production (Complex Tasks)**: Use `z.ai/claude-3-5-sonnet`
4. **Balanced Performance**: Use `z.ai/gpt-4o`

### Usage Monitoring

Monitor your usage through:
- z.ai dashboard (for API usage)
- Suna logs (for request patterns)
- Your application metrics

## Rollback Plan

If you need to rollback from z.ai:

### Quick Rollback

```bash
# Revert your MODEL_TO_USE in .env
MODEL_TO_USE=anthropic/claude-3-5-sonnet  # or your previous model

# Restart services
docker-compose restart
```

### Complete Removal

```bash
# Remove z.ai API key from .env
# Z_AI_API_KEY=  # comment out or delete this line

# Restart services
docker-compose restart
```

## Troubleshooting

### Common Issues After Migration

1. **"Model not found" errors**:
   - Check model name format: `z.ai/model-name`
   - Verify z.ai API key is correct
   - Check z.ai service status

2. **Authentication errors**:
   - Verify Z_AI_API_KEY is set correctly
   - Check API key permissions in z.ai dashboard
   - Ensure no extra spaces in the API key

3. **Performance issues**:
   - Try different z.ai models
   - Check your z.ai usage limits
   - Monitor network connectivity

### Getting Help

- Check the main z.ai integration documentation: `docs/Z_AI_INTEGRATION.md`
- Run the test script: `python test_z_ai_integration.py`
- Enable debug logging: Set `LOG_LEVEL=DEBUG` in your .env
- Check Suna logs for detailed error messages

## Advanced Configuration

### Multiple Provider Setup

You can use z.ai alongside other providers:

```bash
# Keep multiple API keys
ANTHROPIC_API_KEY=your_anthropic_key
OPENAI_API_KEY=your_openai_key
Z_AI_API_KEY=your_z_ai_key

# Use different models for different use cases
MODEL_TO_USE=z.ai/claude-3-5-sonnet  # Default
# Then switch models per request in your application
```

### Environment-Specific Configuration

```bash
# Development
MODEL_TO_USE=z.ai/claude-3-haiku  # Fast, cheap

# Staging  
MODEL_TO_USE=z.ai/gpt-4o-mini     # Balanced

# Production
MODEL_TO_USE=z.ai/claude-3-5-sonnet  # Best performance
```

This migration should take less than 5 minutes for most installations!
