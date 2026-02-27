from .mcp_service import (
    MCPService,
    mcp_service,

    MCPServerInfo,  # New: metadata-only, no active session
    MCPConnection,  # Backwards compat alias for MCPServerInfo
    ToolExecutionResult,
    CustomMCPConnectionResult,

    MCPException,
    MCPConnectionError,
    MCPToolNotFoundError,
    MCPToolExecutionError,
    MCPProviderError,
    MCPConfigurationError,
    MCPAuthenticationError,
    CustomMCPError,
)

__all__ = [
    "MCPService",
    "mcp_service",
    "MCPServerInfo",
    "MCPConnection",  # Backwards compat
    "ToolExecutionResult",
    "CustomMCPConnectionResult",
    "MCPException",
    "MCPConnectionError",
    "MCPToolNotFoundError",
    "MCPToolExecutionError",
    "MCPProviderError",
    "MCPConfigurationError",
    "MCPAuthenticationError",
    "CustomMCPError"
] 