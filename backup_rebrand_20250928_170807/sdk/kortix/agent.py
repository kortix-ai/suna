from .api.threads import AgentStartRequest
from .thread import Thread, AgentRun
from .tools import AgentPressTools, MCPTools, KortixTools
from .api.agents import (
    AgentCreateRequest,
    AgentPress_ToolConfig,
    AgentUpdateRequest,
    AgentsClient,
    CustomMCP,
    MCPConfig,
)


class Agent:
    def __init__(
        self,
        client: AgentsClient,
        agent_id: str,
        model: str = "anthropic/claude-sonnet-4-20250514",
    ):
        self._client = client
        self._agent_id = agent_id
        self._model = model

    async def update(
        self,
        name: str | None = None,
        system_prompt: str | None = None,
        mcp_tools: list[KortixTools] | None = None,
        allowed_tools: list[str] | None = None,
    ):
        if mcp_tools:
            agentpress_tools = {} if mcp_tools else None
            custom_mcps: list[CustomMCP] = [] if mcp_tools else None
            for tool in mcp_tools:
                if isinstance(tool, AgentPressTools):
                    is_enabled = tool.name in allowed_tools if allowed_tools else True
                    agentpress_tools[tool] = AgentPress_ToolConfig(
                        enabled=is_enabled, description=tool.get_description()
                    )
                elif isinstance(tool, MCPTools):
                    mcp = tool
                    is_enabled = tool.name in allowed_tools if allowed_tools else True
                    custom_mcps.append(
                        CustomMCP(
                            name=mcp.name,
                            type=mcp.type,
                            config=MCPConfig(url=mcp.url),
                            enabled_tools=mcp.enabled_tools if is_enabled else [],
                        )
                    )
        else:
            agent_details = await self.details()
            agentpress_tools = agent_details.agentpress_tools
            custom_mcps = agent_details.custom_mcps
            if allowed_tools:
                for tool in agentpress_tools:
                    if tool.name not in allowed_tools:
                        agentpress_tools[tool].enabled = False
                for mcp in custom_mcps:
                    mcp.enabled_tools = allowed_tools

        await self._client.update_agent(
            self._agent_id,
            AgentUpdateRequest(
                name=name,
                system_prompt=system_prompt,
                custom_mcps=custom_mcps,
                agentpress_tools=agentpress_tools,
            ),
        )

    async def details(self):
        response = await self._client.get_agent(self._agent_id)
        return response

    async def run(
        self,
        prompt: str,
        thread: Thread,
        model: str | None = None,
    ):
        await thread.add_message(prompt)
        response = await thread._client.start_agent(
            thread._thread_id,
            AgentStartRequest(
                agent_id=self._agent_id,
                model_name=model or self._model,
            ),
        )
        return AgentRun(thread, response.agent_run_id)


class KortixAgent:
    def __init__(self, client: AgentsClient):
        self._client = client

    async def create(
        self,
        name: str,
        system_prompt: str,
        mcp_tools: list[KortixTools] = [],
        allowed_tools: list[str] | None = None,
    ) -> Agent:
        agentpress_tools = {}
        custom_mcps: list[CustomMCP] = []
        for tool in mcp_tools:
            if isinstance(tool, AgentPressTools):
                is_enabled = tool.name in allowed_tools if allowed_tools else True
                agentpress_tools[tool] = AgentPress_ToolConfig(
                    enabled=is_enabled, description=tool.get_description()
                )
            elif isinstance(tool, MCPTools):
                mcp = tool
                is_enabled = tool.name in allowed_tools if allowed_tools else True
                custom_mcps.append(
                    CustomMCP(
                        name=mcp.name,
                        type=mcp.type,
                        config=MCPConfig(url=mcp.url),
                        enabled_tools=mcp.enabled_tools if is_enabled else [],
                    )
                )
            else:
                raise ValueError(f"Unknown tool type: {type(tool)}")

        agent = await self._client.create_agent(
            AgentCreateRequest(
                name=name,
                system_prompt=system_prompt,
                custom_mcps=custom_mcps,
                agentpress_tools=agentpress_tools,
            )
        )

        return Agent(self._client, agent.agent_id)

    async def get(self, agent_id: str) -> Agent:
        agent = await self._client.get_agent(agent_id)
        return Agent(self._client, agent.agent_id)
