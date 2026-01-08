"""Import-related API models."""

from pydantic import BaseModel
from typing import Optional, List, Dict, Any


class JsonAnalysisRequest(BaseModel):
    """Request to analyze JSON for import requirements."""
    json_data: Dict[str, Any]


class JsonAnalysisResponse(BaseModel):
    """Response from JSON analysis."""
    requires_setup: bool
    missing_regular_credentials: List[Dict[str, Any]] = []
    missing_custom_configs: List[Dict[str, Any]] = []
    agent_info: Dict[str, Any] = {}


class JsonImportRequestModel(BaseModel):
    """Request to import agent from JSON."""
    json_data: Dict[str, Any]
    instance_name: Optional[str] = None
    custom_system_prompt: Optional[str] = None
    profile_mappings: Optional[Dict[str, str]] = None
    custom_mcp_configs: Optional[Dict[str, Dict[str, Any]]] = None


class JsonImportResponse(BaseModel):
    """Response from JSON import."""
    status: str
    instance_id: Optional[str] = None
    name: Optional[str] = None
    missing_regular_credentials: List[Dict[str, Any]] = []
    missing_custom_configs: List[Dict[str, Any]] = []
    agent_info: Dict[str, Any] = {}