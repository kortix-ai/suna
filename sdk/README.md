# SprintLab SDK

[![Python](https://img.shields.io/badge/python-3.11+-blue.svg)](https://python.org)

> [!WARNING]
> **This SDK is currently in early development and is NOT ready for production use.**
> 
> The API is subject to breaking changes, features may be incomplete, and documentation may be outdated. Use at your own risk.

A Python SDK that enables you to create, manage, and interact with AI Workers on [SprintLab](https://www.sprintlab.com).

## 📦 Installation

Install directly from the GitHub repository:

```bash
pip install "sprintlab @ git+https://github.com/sprintlab/suna.git@main#subdirectory=sdk"
```

Or using uv:

```bash
uv add "sprintlab @ git+https://github.com/sprintlab/suna.git@main#subdirectory=sdk"
```

## 🔧 Quick Start

```python
import asyncio
from sprintlab import sprintlab

async def main():
    mcp_tools = sprintlab.MCPTools(
        "http://localhost:4000/mcp/",  # Point to any HTTP MCP server
        "SprintLab",
    )
    await mcp_tools.initialize()

    # Initialize the client
    client = sprintlab.SprintLab(api_key="your-api-key")

    # Create an agent
    agent = await client.Agent.create(
        name="My Assistant",
        system_prompt="You are a helpful AI assistant.",
        mcp_tools=[mcp_tools],
        allowed_tools=["get_wind_direction"],
    )

    # Create a conversation thread
    thread = await client.Thread.create()

    # Run the agent
    run = await agent.run("Hello, how are you?", thread)

    # Stream the response
    stream = await run.get_stream()
    async for chunk in stream:
        print(chunk, end="")

if __name__ == "__main__":
    asyncio.run(main())
```

## 🔑 Environment Setup

Get your API key from [https://www.sprintlab.com/settings/api-keys](https://www.sprintlab.com/settings/api-keys)

## 🧪 Running Examples

```bash
# Install dependencies
uv sync

# Run the main example
PYTHONPATH=$(pwd) uv run example/example.py
```
