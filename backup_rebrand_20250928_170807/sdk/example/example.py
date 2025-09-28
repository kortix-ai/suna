# Run with `PYTHONPATH=$(pwd) uv run example/example.py`

import asyncio
import os

from kortix import kortix
from kortix.utils import print_stream


from kv import kv
from mcp_server import mcp


async def main():
    """
    Please ignore the asyncio.exceptions.CancelledError that is thrown when the MCP server is stopped. I couldn't fix it.
    """
    
    # Start the MCP server in the background
    asyncio.create_task(
        mcp.run_http_async(
            show_banner=False, log_level="error", host="0.0.0.0", port=4000
        )
    )

    # Create the MCP tools client with the URL of the MCP server that's accessible by the Suna instance
    mcp_tools = kortix.MCPTools(
        "http://localhost:4000/mcp/",  # Since we are running Suna locally, we can use the local URL
        "Kortix",
        allowed_tools=["get_wind_direction"],
    )
    await mcp_tools.initialize()

    kortix_client = kortix.Kortix(
        os.getenv("KORTIX_API_KEY", "pk_xxx:sk_xxx"),
        "http://localhost:8000/api",
    )

    # Setup the agent
    agent_id = kv.get("agent_id")
    if not agent_id:
        agent = await kortix_client.Agent.create(
            name="Generic Agent",
            system_prompt="You are a generic agent. You can use the tools provided to you to answer questions.",
            mcp_tools=[mcp_tools],
            allowed_tools=["get_weather"],
        )
        kv.set("agent_id", agent._agent_id)
    else:
        agent = await kortix_client.Agent.get(agent_id)
        await agent.update(allowed_tools=["get_weather"])

    # Setup the thread
    thread_id = kv.get("thread_id")
    if not thread_id:
        thread = await kortix_client.Thread.create()
        kv.set("thread_id", thread._thread_id)
    else:
        thread = await kortix_client.Thread.get(thread_id)

    # Run the agent
    agent_run = await agent.run("What is the wind direction in Bangalore?", thread)

    stream = await agent_run.get_stream()

    await print_stream(stream)


if __name__ == "__main__":
    asyncio.run(main())
