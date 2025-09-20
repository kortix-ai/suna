"""Agent-related API models."""

from pydantic import BaseModel
from typing import Optional, List, Dict, Any

# Import PaginationInfo directly to avoid forward reference issues
from .common import PaginationInfo


class AgentCreateRequest(BaseModel):
    """Request model for creating a new agent."""
    name: str
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    configured_mcps: Optional[List[Dict[str, Any]]] = []
    custom_mcps: Optional[List[Dict[str, Any]]] = []
    agentpress_tools: Optional[Dict[str, Any]] = {}
    is_default: Optional[bool] = False
    profile_image_url: Optional[str] = None
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None


class AgentUpdateRequest(BaseModel):
    """Request model for updating an existing agent."""
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    configured_mcps: Optional[List[Dict[str, Any]]] = None
    custom_mcps: Optional[List[Dict[str, Any]]] = None
    agentpress_tools: Optional[Dict[str, Any]] = None
    is_default: Optional[bool] = None
    profile_image_url: Optional[str] = None
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None
    replace_mcps: Optional[bool] = None


class AgentVersionResponse(BaseModel):
    """Response model for agent version information."""
    version_id: str
    agent_id: str
    version_number: int
    version_name: str
    system_prompt: str
    model: Optional[str] = None
    configured_mcps: List[Dict[str, Any]]
    custom_mcps: List[Dict[str, Any]]
    agentpress_tools: Dict[str, Any]
    is_active: bool
    created_at: str
    updated_at: str
    created_by: Optional[str] = None


class AgentVersionCreateRequest(BaseModel):
    """Request model for creating a new agent version."""
    system_prompt: str
    configured_mcps: Optional[List[Dict[str, Any]]] = []
    custom_mcps: Optional[List[Dict[str, Any]]] = []
    agentpress_tools: Optional[Dict[str, Any]] = {}
    version_name: Optional[str] = None
    description: Optional[str] = None


class AgentResponse(BaseModel):
    """Response model for agent information."""
    agent_id: str
    name: str
    description: Optional[str] = None
    system_prompt: str
    configured_mcps: List[Dict[str, Any]]
    custom_mcps: List[Dict[str, Any]]
    agentpress_tools: Dict[str, Any]
    is_default: bool
    profile_image_url: Optional[str] = None
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None
    created_at: str
    updated_at: Optional[str] = None
    is_public: Optional[bool] = False
    tags: Optional[List[str]] = []
    current_version_id: Optional[str] = None
    version_count: Optional[int] = 1
    current_version: Optional[AgentVersionResponse] = None
    metadata: Optional[Dict[str, Any]] = None


class AgentsResponse(BaseModel):
    """Response model for list of agents with pagination."""
    agents: List[AgentResponse]
    pagination: PaginationInfo


class ThreadAgentResponse(BaseModel):
    """Response model for thread agent information."""
    agent: Optional[AgentResponse]
    source: str
    message: str


class AgentExportData(BaseModel):
    """Model for agent export data."""
    name: str
    description: Optional[str] = None
    system_prompt: str
    agentpress_tools: Dict[str, Any]
    configured_mcps: List[Dict[str, Any]]
    custom_mcps: List[Dict[str, Any]]
    profile_image_url: Optional[str] = None
    tags: Optional[List[str]] = []
    metadata: Optional[Dict[str, Any]] = None
    export_version: str = "1.1"
    exported_at: str
    exported_by: Optional[str] = None


class AgentImportRequest(BaseModel):
    """Request to import an agent from JSON."""
    import_data: AgentExportData
    import_as_new: bool = True  # Always true, only creating new agents is supported


