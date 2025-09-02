from pydantic import BaseModel
from typing import Optional, List, Dict, Any

class AgentStartRequest(BaseModel):
    model_name: Optional[str] = None  # Will be set to default model in the endpoint
    enable_thinking: Optional[bool] = False
    reasoning_effort: Optional[str] = 'low'
    stream: Optional[bool] = True
    enable_context_manager: Optional[bool] = False
    agent_id: Optional[str] = None  # Custom agent to use

class InitiateAgentResponse(BaseModel):
    thread_id: str
    agent_run_id: Optional[str] = None

class CreateThreadResponse(BaseModel):
    thread_id: str
    project_id: str

class MessageCreateRequest(BaseModel):
    type: str
    content: str
    is_llm_message: bool = True

class AgentCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    configured_mcps: Optional[List[Dict[str, Any]]] = []
    custom_mcps: Optional[List[Dict[str, Any]]] = []
    agentpress_tools: Optional[Dict[str, Any]] = {}
    is_default: Optional[bool] = False
    avatar: Optional[str] = None
    avatar_color: Optional[str] = None
    profile_image_url: Optional[str] = None
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None

class AgentVersionResponse(BaseModel):
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
    system_prompt: str
    configured_mcps: Optional[List[Dict[str, Any]]] = []
    custom_mcps: Optional[List[Dict[str, Any]]] = []
    agentpress_tools: Optional[Dict[str, Any]] = {}
    version_name: Optional[str] = None
    description: Optional[str] = None

class AgentUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    configured_mcps: Optional[List[Dict[str, Any]]] = None
    custom_mcps: Optional[List[Dict[str, Any]]] = None
    agentpress_tools: Optional[Dict[str, Any]] = None
    is_default: Optional[bool] = None
    avatar: Optional[str] = None
    avatar_color: Optional[str] = None
    profile_image_url: Optional[str] = None
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None
    replace_mcps: Optional[bool] = None

class AgentResponse(BaseModel):
    agent_id: str
    name: str
    description: Optional[str] = None
    system_prompt: str
    configured_mcps: List[Dict[str, Any]]
    custom_mcps: List[Dict[str, Any]]
    agentpress_tools: Dict[str, Any]
    is_default: bool
    avatar: Optional[str] = None
    avatar_color: Optional[str] = None
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

class PaginationInfo(BaseModel):
    current_page: int
    page_size: int
    total_items: int
    total_pages: int
    has_next: bool
    has_previous: bool

class AgentsResponse(BaseModel):
    agents: List[AgentResponse]
    pagination: PaginationInfo

class ThreadAgentResponse(BaseModel):
    agent: Optional[AgentResponse]
    source: str
    message: str

class AgentExportData(BaseModel):
    name: str
    description: Optional[str] = None
    system_prompt: str
    agentpress_tools: Dict[str, Any]
    configured_mcps: List[Dict[str, Any]]
    custom_mcps: List[Dict[str, Any]]
    # Deprecated
    avatar: Optional[str] = None
    avatar_color: Optional[str] = None
    # New
    profile_image_url: Optional[str] = None
    tags: Optional[List[str]] = []
    metadata: Optional[Dict[str, Any]] = None
    export_version: str = "1.1"
    exported_at: str
    exported_by: Optional[str] = None

class AgentImportRequest(BaseModel):
    """Request to import an agent from JSON"""
    import_data: AgentExportData
    import_as_new: bool = True  # Always true, only creating new agents is supported

class JsonAnalysisRequest(BaseModel):
    """Request to analyze JSON for import requirements"""
    json_data: Dict[str, Any]

class JsonAnalysisResponse(BaseModel):
    """Response from JSON analysis"""
    requires_setup: bool
    missing_regular_credentials: List[Dict[str, Any]] = []
    missing_custom_configs: List[Dict[str, Any]] = []
    agent_info: Dict[str, Any] = {}

class JsonImportRequestModel(BaseModel):
    """Request to import agent from JSON"""
    json_data: Dict[str, Any]
    instance_name: Optional[str] = None
    custom_system_prompt: Optional[str] = None
    profile_mappings: Optional[Dict[str, str]] = None
    custom_mcp_configs: Optional[Dict[str, Dict[str, Any]]] = None

class JsonImportResponse(BaseModel):
    """Response from JSON import"""
    status: str
    instance_id: Optional[str] = None
    name: Optional[str] = None
    missing_regular_credentials: List[Dict[str, Any]] = []
    missing_custom_configs: List[Dict[str, Any]] = []
    agent_info: Dict[str, Any] = {}