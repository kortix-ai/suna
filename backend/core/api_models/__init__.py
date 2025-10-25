"""API Models for AgentPress

This module contains all Pydantic models used for API request/response validation.
Models are organized by domain for better maintainability.
"""

from .common import (
    PaginationInfo,
)

from .agents import (
    AgentCreateRequest,
    AgentUpdateRequest,
    AgentResponse,
    AgentVersionResponse,
    AgentVersionCreateRequest,
    AgentsResponse,
    ThreadAgentResponse,
    AgentExportData,
    AgentImportRequest,
    AgentIconGenerationRequest,
    AgentIconGenerationResponse,
)

from .threads import (
    UnifiedAgentStartResponse,
    CreateThreadResponse,
    MessageCreateRequest,
)

from .imports import (
    JsonAnalysisRequest,
    JsonAnalysisResponse,
    JsonImportRequestModel,
    JsonImportResponse,
)


__all__ = [
    # Agent models
    "AgentCreateRequest",
    "AgentUpdateRequest", 
    "AgentResponse",
    "AgentVersionResponse",
    "AgentVersionCreateRequest",
    "AgentsResponse",
    "ThreadAgentResponse",
    "AgentExportData",
    "AgentImportRequest",
    "AgentIconGenerationRequest",
    "AgentIconGenerationResponse",
    
    # Thread models
    "UnifiedAgentStartResponse",
    "CreateThreadResponse",
    "MessageCreateRequest",
    
    # Import models
    "JsonAnalysisRequest",
    "JsonAnalysisResponse", 
    "JsonImportRequestModel",
    "JsonImportResponse",
    
    # Common models
    "PaginationInfo",
]