import httpx
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, asdict
import json

from ..tools import AgentPressTools


@dataclass
class MCPConfig:
    url: str


@dataclass
class CustomMCP:
    name: str
    type: str  # sse, http, etc
    config: MCPConfig
    enabled_tools: List[str]


@dataclass
class AgentPress_ToolConfig:
    enabled: bool
    description: str


@dataclass
class AgentCreateRequest:
    name: str
    system_prompt: str
    description: Optional[str] = None
    custom_mcps: Optional[List[CustomMCP]] = None
    agentpress_tools: Optional[Dict[AgentPressTools, AgentPress_ToolConfig]] = None
    is_default: bool = False
    profile_image_url: Optional[str] = None
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None


@dataclass
class AgentUpdateRequest:
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    custom_mcps: Optional[List[CustomMCP]] = None
    agentpress_tools: Optional[Dict[AgentPressTools, AgentPress_ToolConfig]] = None
    is_default: Optional[bool] = None
    profile_image_url: Optional[str] = None
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None


@dataclass
class PipedreamToolsUpdateRequest:
    enabled_tools: List[str]


@dataclass
class CustomMCPToolsUpdateRequest:
    url: str
    type: str
    enabled_tools: List[str]


# Response Models
@dataclass
class AgentVersionResponse:
    version_id: str
    agent_id: str
    version_number: int
    version_name: str
    system_prompt: str
    custom_mcps: List[CustomMCP]
    agentpress_tools: Dict[AgentPressTools, AgentPress_ToolConfig]
    is_active: bool
    created_at: str
    updated_at: str
    created_by: Optional[str] = None


@dataclass
class AgentResponse:
    agent_id: str
    account_id: str
    name: str
    system_prompt: str
    custom_mcps: List[CustomMCP]
    agentpress_tools: Dict[AgentPressTools, AgentPress_ToolConfig]
    is_default: bool
    created_at: str
    description: Optional[str] = None
    updated_at: Optional[str] = None
    is_public: Optional[bool] = False
    marketplace_published_at: Optional[str] = None
    download_count: Optional[int] = 0
    tags: Optional[List[str]] = None
    current_version_id: Optional[str] = None
    version_count: Optional[int] = 1
    current_version: Optional[AgentVersionResponse] = None
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class PaginationInfo:
    page: int
    limit: int
    total: int
    pages: int


@dataclass
class AgentsResponse:
    agents: List[AgentResponse]
    pagination: PaginationInfo


@dataclass
class AgentTool:
    name: str
    enabled: bool
    server: Optional[str] = None  # For MCP tools
    description: Optional[str] = None


@dataclass
class AgentToolsResponse:
    agentpress_tools: List[AgentTool]
    mcp_tools: List[AgentTool]


@dataclass
class PipedreamTool:
    name: str
    description: str
    enabled: bool


@dataclass
class PipedreamToolsResponse:
    profile_id: str
    app_name: str
    profile_name: str
    tools: List[PipedreamTool]
    has_mcp_config: bool
    error: Optional[str] = None


@dataclass
class CustomMCPTool:
    name: str
    description: str
    enabled: bool


@dataclass
class CustomMCPToolsResponse:
    tools: List[CustomMCPTool]
    has_mcp_config: bool
    server_type: str
    server_url: str


@dataclass
class PipedreamToolsUpdateResponse:
    success: bool
    enabled_tools: List[str]
    total_tools: int
    version_name: Optional[str] = None


@dataclass
class CustomMCPToolsUpdateResponse:
    success: bool
    enabled_tools: List[str]
    total_tools: int


@dataclass
class AgentBuilderChatMessage:
    message_id: str
    thread_id: str
    type: str
    is_llm_message: bool
    content: str
    created_at: str


@dataclass
class AgentBuilderChatHistoryResponse:
    messages: List[AgentBuilderChatMessage]
    thread_id: Optional[str]


@dataclass
class DeleteAgentResponse:
    message: str


# Helper function to convert dataclass to dict for JSON serialization
def to_dict(obj) -> Dict[str, Any]:
    """Convert dataclass to dict, excluding None values"""
    if hasattr(obj, "__dataclass_fields__"):
        return {k: v for k, v in asdict(obj).items() if v is not None}
    return obj


# Helper function to create dataclass from dict
def from_dict(cls, data: Dict[str, Any]):
    """Create dataclass instance from dict"""
    if not data:
        return None

    # Handle nested objects
    if cls == AgentsResponse:
        agents = [from_dict(AgentResponse, agent) for agent in data.get("agents", [])]
        pagination = from_dict(PaginationInfo, data.get("pagination", {}))
        return cls(agents=agents, pagination=pagination)

    elif cls == AgentResponse:
        current_version = None
        if data.get("current_version"):
            current_version = from_dict(AgentVersionResponse, data["current_version"])

        # Handle custom_mcps conversion
        custom_mcps = []
        if data.get("custom_mcps"):
            custom_mcps = [from_dict(CustomMCP, mcp) for mcp in data["custom_mcps"]]

        # Create a copy of data without nested objects for the main object
        agent_data = {
            k: v for k, v in data.items() if k not in ["current_version", "custom_mcps"]
        }
        agent_data["current_version"] = current_version
        agent_data["custom_mcps"] = custom_mcps
        agent_data["tags"] = agent_data.get("tags", [])

        return cls(
            **{k: v for k, v in agent_data.items() if k in cls.__dataclass_fields__}
        )

    elif cls == AgentToolsResponse:
        agentpress_tools = [
            from_dict(AgentTool, tool) for tool in data.get("agentpress_tools", [])
        ]
        mcp_tools = [from_dict(AgentTool, tool) for tool in data.get("mcp_tools", [])]
        return cls(agentpress_tools=agentpress_tools, mcp_tools=mcp_tools)

    elif cls == PipedreamToolsResponse:
        tools = [from_dict(PipedreamTool, tool) for tool in data.get("tools", [])]
        return cls(
            profile_id=data["profile_id"],
            app_name=data["app_name"],
            profile_name=data["profile_name"],
            tools=tools,
            has_mcp_config=data["has_mcp_config"],
            error=data.get("error"),
        )

    elif cls == CustomMCPToolsResponse:
        tools = [from_dict(CustomMCPTool, tool) for tool in data.get("tools", [])]
        return cls(
            tools=tools,
            has_mcp_config=data["has_mcp_config"],
            server_type=data["server_type"],
            server_url=data["server_url"],
        )

    elif cls == AgentBuilderChatHistoryResponse:
        messages = [
            from_dict(AgentBuilderChatMessage, msg) for msg in data.get("messages", [])
        ]
        return cls(messages=messages, thread_id=data.get("thread_id"))

    elif cls == CustomMCP:
        # Handle nested MCPConfig conversion
        config_data = data.get("config", {})
        # Ensure we always have a valid MCPConfig object
        if isinstance(config_data, dict):
            # Provide default url if missing
            if "url" not in config_data:
                config_data["url"] = ""
            config = from_dict(MCPConfig, config_data)
        else:
            # Fallback to empty MCPConfig if config is not a dict
            config = MCPConfig(url="")

        # Create a copy without config for the main object
        mcp_data = {k: v for k, v in data.items() if k != "config"}
        mcp_data["config"] = config

        return cls(
            **{k: v for k, v in mcp_data.items() if k in cls.__dataclass_fields__}
        )

    # For simple dataclasses, filter fields that exist in the class
    if hasattr(cls, "__dataclass_fields__"):
        filtered_data = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
        return cls(**filtered_data)

    return data


class AgentsClient:
    """SDK client for Kortix Agents API with httpx client supporting custom headers"""

    def __init__(
        self,
        base_url: str,
        auth_token: Optional[str] = None,
        custom_headers: Optional[Dict[str, str]] = None,
        timeout: float = 30.0,
    ):
        """
        Initialize the Agents API client

        Args:
            base_url: Base URL of the API (e.g., "https://api.suna.so/api")
            auth_token: JWT token for authentication
            custom_headers: Additional headers to include in all requests
            timeout: Request timeout in seconds
        """
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

        # Build default headers
        default_headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        # Add auth token if provided
        if auth_token:
            default_headers["X-API-Key"] = auth_token

        # Merge with custom headers
        if custom_headers:
            default_headers.update(custom_headers)

        # Create httpx client with configured headers and timeout
        self.client = httpx.AsyncClient(
            headers=default_headers, timeout=timeout, base_url=self.base_url
        )

    async def close(self):
        """Close the httpx client"""
        await self.client.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()

    # Helper method for handling API responses
    def _handle_response(self, response: httpx.Response) -> Dict[str, Any]:
        """Handle API response and raise appropriate exceptions"""
        if response.status_code >= 400:
            try:
                error_detail = response.json().get(
                    "detail", f"HTTP {response.status_code}"
                )
            except:
                error_detail = f"HTTP {response.status_code}"
            raise httpx.HTTPStatusError(
                f"API request failed: {error_detail}",
                request=response.request,
                response=response,
            )
        return response.json()

    # Agents CRUD operations

    async def get_agents(
        self,
        page: int = 1,
        limit: int = 20,
        search: Optional[str] = None,
        sort_by: str = "created_at",
        sort_order: str = "desc",
        has_default: Optional[bool] = None,
        has_mcp_tools: Optional[bool] = None,
        has_agentpress_tools: Optional[bool] = None,
        tools: Optional[str] = None,
    ) -> AgentsResponse:
        """
        Get agents with pagination, search, sort, and filter support

        Args:
            page: Page number (1-based)
            limit: Number of items per page (1-100)
            search: Search in name and description
            sort_by: Sort field (name, created_at, updated_at, tools_count)
            sort_order: Sort order (asc, desc)
            has_default: Filter by default agents
            has_mcp_tools: Filter by agents with MCP tools
            has_agentpress_tools: Filter by agents with AgentPress tools
            tools: Comma-separated list of tools to filter by

        Returns:
            AgentsResponse containing agents list and pagination info
        """
        params = {
            "page": page,
            "limit": limit,
            "sort_by": sort_by,
            "sort_order": sort_order,
        }

        # Add optional parameters if provided
        if search:
            params["search"] = search
        if has_default is not None:
            params["has_default"] = has_default
        if has_mcp_tools is not None:
            params["has_mcp_tools"] = has_mcp_tools
        if has_agentpress_tools is not None:
            params["has_agentpress_tools"] = has_agentpress_tools
        if tools:
            params["tools"] = tools

        response = await self.client.get("/agents", params=params)
        data = self._handle_response(response)
        return from_dict(AgentsResponse, data)

    async def get_agent(self, agent_id: str) -> AgentResponse:
        """
        Get a specific agent by ID

        Args:
            agent_id: Agent identifier

        Returns:
            AgentResponse with current version information
        """
        response = await self.client.get(f"/agents/{agent_id}")
        data = self._handle_response(response)
        return from_dict(AgentResponse, data)

    async def create_agent(self, request: AgentCreateRequest) -> AgentResponse:
        """
        Create a new agent

        Args:
            request: AgentCreateRequest with agent details

        Returns:
            Created AgentResponse
        """
        response = await self.client.post("/agents", json=to_dict(request))
        data = self._handle_response(response)
        return from_dict(AgentResponse, data)

    async def update_agent(
        self, agent_id: str, request: AgentUpdateRequest
    ) -> AgentResponse:
        """
        Update an existing agent

        Args:
            agent_id: Agent identifier
            request: AgentUpdateRequest with updated fields

        Returns:
            Updated AgentResponse
        """
        response = await self.client.put(f"/agents/{agent_id}", json=to_dict(request))
        data = self._handle_response(response)
        return from_dict(AgentResponse, data)

    async def delete_agent(self, agent_id: str) -> DeleteAgentResponse:
        """
        Delete an agent

        Args:
            agent_id: Agent identifier

        Returns:
            DeleteAgentResponse with confirmation message
        """
        response = await self.client.delete(f"/agents/{agent_id}")
        data = self._handle_response(response)
        return from_dict(DeleteAgentResponse, data)

    # Agent tools and integrations

    async def get_agent_tools(self, agent_id: str) -> AgentToolsResponse:
        """
        Get enabled tools for an agent

        Args:
            agent_id: Agent identifier

        Returns:
            AgentToolsResponse containing agentpress_tools and mcp_tools lists
        """
        response = await self.client.get(f"/agents/{agent_id}/tools")
        data = self._handle_response(response)
        return from_dict(AgentToolsResponse, data)

    async def get_pipedream_tools(
        self, agent_id: str, profile_id: str, version: Optional[str] = None
    ) -> PipedreamToolsResponse:
        """
        [WARNING] This endpoint is not implemented.

        Get Pipedream tools for an agent profile

        Args:
            agent_id: Agent identifier
            profile_id: Pipedream profile identifier
            version: Optional version ID to get tools from specific version

        Returns:
            PipedreamToolsResponse containing profile info and available tools
        """
        raise Exception("TODO: unimplemented")
        params = {}
        if version:
            params["version"] = version

        response = await self.client.get(
            f"/agents/{agent_id}/pipedream-tools/{profile_id}", params=params
        )
        data = self._handle_response(response)
        return from_dict(PipedreamToolsResponse, data)

    async def update_pipedream_tools(
        self, agent_id: str, profile_id: str, request: PipedreamToolsUpdateRequest
    ) -> PipedreamToolsUpdateResponse:
        """
        [WARNING] This endpoint is not implemented.

        Update Pipedream tools for an agent profile

        Args:
            agent_id: Agent identifier
            profile_id: Pipedream profile identifier
            request: PipedreamToolsUpdateRequest with enabled tools

        Returns:
            PipedreamToolsUpdateResponse with update result
        """
        raise Exception("TODO: unimplemented")
        response = await self.client.put(
            f"/agents/{agent_id}/pipedream-tools/{profile_id}", json=to_dict(request)
        )
        data = self._handle_response(response)
        return from_dict(PipedreamToolsUpdateResponse, data)

    async def get_custom_mcp_tools(
        self,
        agent_id: str,
        mcp_url: str,
        mcp_type: str = "sse",
        headers: Optional[Dict[str, str]] = None,
    ) -> CustomMCPToolsResponse:
        """
        Get custom MCP tools for an agent

        Args:
            agent_id: Agent identifier
            mcp_url: MCP server URL
            mcp_type: MCP server type (default: "sse")
            headers: Optional additional headers for MCP server

        Returns:
            CustomMCPToolsResponse containing available tools and server info
        """
        request_headers = {"X-MCP-URL": mcp_url, "X-MCP-Type": mcp_type}

        if headers:
            request_headers["X-MCP-Headers"] = json.dumps(headers)

        response = await self.client.get(
            f"/agents/{agent_id}/custom-mcp-tools", headers=request_headers
        )
        data = self._handle_response(response)
        return from_dict(CustomMCPToolsResponse, data)

    async def update_custom_mcp_tools(
        self, agent_id: str, request: CustomMCPToolsUpdateRequest
    ) -> CustomMCPToolsUpdateResponse:
        """
        Update custom MCP tools for an agent

        Args:
            agent_id: Agent identifier
            request: CustomMCPToolsUpdateRequest with server details and enabled tools

        Returns:
            CustomMCPToolsUpdateResponse with update result
        """
        response = await self.client.post(
            f"/agents/{agent_id}/custom-mcp-tools", json=to_dict(request)
        )
        data = self._handle_response(response)
        return from_dict(CustomMCPToolsUpdateResponse, data)

    # Agent builder functionality

    async def get_agent_builder_chat_history(
        self, agent_id: str
    ) -> AgentBuilderChatHistoryResponse:
        """
        Get chat history for agent builder sessions

        Args:
            agent_id: Agent identifier

        Returns:
            AgentBuilderChatHistoryResponse containing messages and thread_id
        """
        response = await self.client.get(f"/agents/{agent_id}/builder-chat-history")
        data = self._handle_response(response)
        return from_dict(AgentBuilderChatHistoryResponse, data)


# Convenience function to create a client instance
def create_agents_client(
    base_url: str,
    auth_token: Optional[str] = None,
    custom_headers: Optional[Dict[str, str]] = None,
    timeout: float = 30.0,
) -> AgentsClient:
    """
    Create an AgentsClient instance

    Args:
        base_url: Base URL of the API
        auth_token: JWT token for authentication
        custom_headers: Additional headers to include in all requests
        timeout: Request timeout in seconds

    Returns:
        AgentsClient instance
    """
    return AgentsClient(
        base_url=base_url,
        auth_token=auth_token,
        custom_headers=custom_headers,
        timeout=timeout,
    )


# Example usage
"""
# Basic usage with auth token
client = create_agents_client(
    base_url="https://api.suna.so/api",
    auth_token="your-jwt-token"
)

# Usage with custom headers
client = create_agents_client(
    base_url="https://api.suna.so/api",
    auth_token="your-jwt-token",
    custom_headers={
        "X-Custom-Header": "custom-value",
        "X-API-Version": "v1"
    }
)

# Using the client with type safety
async with client:
    # Get all agents
    agents_response = await client.get_agents(page=1, limit=10, search="chatbot")
    print(f"Found {agents_response.pagination.total} agents")
    
    # Get specific agent
    agent = await client.get_agent("agent-id")
    print(f"Agent name: {agent.name}")
    
    # Create new agent
    create_request = AgentCreateRequest(
        name="My Agent",
        system_prompt="You are a helpful assistant",
        description="A custom agent for my project"
    )
    new_agent = await client.create_agent(create_request)
    
    # Update agent
    update_request = AgentUpdateRequest(
        name="Updated Agent Name",
        system_prompt="Updated system prompt"
    )
    updated_agent = await client.update_agent("agent-id", update_request)
    
    # Get agent tools
    tools = await client.get_agent_tools("agent-id")
    print(f"AgentPress tools: {len(tools.agentpress_tools)}")
    print(f"MCP tools: {len(tools.mcp_tools)}")
    
    # Update Pipedream tools
    pipedream_request = PipedreamToolsUpdateRequest(enabled_tools=["tool1", "tool2"])
    result = await client.update_pipedream_tools("agent-id", "profile-id", pipedream_request)
"""
