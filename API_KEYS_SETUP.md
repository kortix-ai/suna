# Kusor API Keys Setup Guide

## Required API Keys for Full Functionality

The Kusor backend is currently running but missing API keys for LLM providers. Here's how to add them:

### 1. **OpenAI API Key (Recommended)**
```bash
# Add to backend/.env
OPENAI_API_KEY=your_openai_api_key_here
```

### 2. **Anthropic API Key (Alternative)**
```bash
# Add to backend/.env
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

### 3. **Other Optional Providers**
```bash
# Groq (Fast inference)
GROQ_API_KEY=your_groq_api_key_here

# OpenRouter (Multiple models)
OPENROUTER_API_KEY=your_openrouter_api_key_here

# Google Gemini
GEMINI_API_KEY=your_gemini_api_key_here

# xAI (Grok)
XAI_API_KEY=your_xai_api_key_here
```

### 4. **Required for Web Search**
```bash
# Tavily (Web search)
TAVILY_API_KEY=your_tavily_api_key_here

# RapidAPI (Data search)
RAPID_API_KEY=your_rapid_api_key_here
```

### 5. **Required for Web Scraping**
```bash
# Firecrawl (Web scraping)
FIRECRAWL_API_KEY=your_firecrawl_api_key_here
```

## How to Add API Keys

### Option 1: Edit .env file directly
```bash
# Open the .env file in your editor
nano backend/.env

# Add your API keys (one per line)
OPENAI_API_KEY=sk-your-key-here
TAVILY_API_KEY=your-tavily-key-here
FIRECRAWL_API_KEY=your-firecrawl-key-here
```

### Option 2: Use echo commands
```bash
# Add OpenAI key
echo "OPENAI_API_KEY=sk-your-key-here" >> backend/.env

# Add Tavily key
echo "TAVILY_API_KEY=your-tavily-key-here" >> backend/.env

# Add Firecrawl key
echo "FIRECRAWL_API_KEY=your-firecrawl-key-here" >> backend/.env
```

## Restart Services After Adding Keys

After adding API keys, restart the backend:

```bash
# Stop current backend
pkill -f "uv run api.py"

# Restart backend
cd backend && export PATH="$HOME/.local/bin:$PATH"
uv run api.py &
```

## Get API Keys

### OpenAI
- Visit: https://platform.openai.com/api-keys
- Create a new secret key

### Tavily
- Visit: https://tavily.com/
- Sign up and get your API key

### Firecrawl
- Visit: https://firecrawl.dev/
- Sign up and get your API key

### Anthropic
- Visit: https://console.anthropic.com/
- Create an API key

## Current Status

✅ **Backend**: Running on port 8000
✅ **Agent Worker**: Running and processing tasks
✅ **Redis**: Running on port 6379
✅ **Mobile App**: Starting with cleared cache

⚠️ **Missing**: LLM API keys (add at least one for AI functionality)
⚠️ **Missing**: Web search/scraping keys (for full tool functionality)

## Test the Setup

Once you've added API keys:

```bash
# Test the API
curl -X GET "http://localhost:8000/docs"

# Test mobile app
cd apps/mobile && npx expo start --ios
```

The mobile app should now work without React Native errors, and the backend will have AI capabilities once you add the API keys!
