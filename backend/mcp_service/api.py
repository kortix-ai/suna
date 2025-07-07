"""
MCP (Model Context Protocol) API module

This module handles MCP server discovery and configuration management.

Architecture:
1. Registry API (https://registry.smithery.ai) - For discovering MCP servers and getting metadata
2. Server API (https://server.smithery.ai) - For actually connecting to and using MCP servers

The flow:
1. Browse available MCP servers from the registry (this module)
2. Configure MCP servers with credentials and save to agent's configured_mcps
3. When agent runs, it connects to MCP servers using:
   https://server.smithery.ai/{qualifiedName}/mcp?config={base64_encoded_config}&api_key={smithery_api_key}
"""

from fastapi import APIRouter, HTTPException, Depends, Query
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, validator, HttpUrl
import httpx
import os
from urllib.parse import quote
from utils.logger import logger
from utils.auth_utils import get_current_user_id_from_jwt
from mcp_service.mcp_custom import discover_custom_tools
from collections import OrderedDict

router = APIRouter()

# Smithery API configuration
SMITHERY_API_BASE_URL = "https://registry.smithery.ai"
SMITHERY_SERVER_BASE_URL = "https://server.smithery.ai" 
SMITHERY_API_KEY = os.getenv("SMITHERY_API_KEY")


class MCPServer(BaseModel):
    """Represents an MCP server from Smithery"""
    qualifiedName: str
    displayName: str
    description: str
    createdAt: str
    useCount: int  # Changed from str to int
    homepage: str
    # These fields are only available in the detail endpoint
    iconUrl: Optional[str] = None
    isDeployed: Optional[bool] = None
    connections: Optional[List[Dict[str, Any]]] = None
    tools: Optional[List[Dict[str, Any]]] = None
    security: Optional[Dict[str, Any]] = None

class MCPServerListResponse(BaseModel):
    """Response model for MCP server list"""
    servers: List[MCPServer]
    pagination: Dict[str, int]

class MCPServerDetailResponse(BaseModel):
    """Response model for detailed MCP server information"""
    qualifiedName: str
    displayName: str
    iconUrl: Optional[str] = None
    deploymentUrl: Optional[str] = None
    connections: List[Dict[str, Any]]
    security: Optional[Dict[str, Any]] = None
    tools: Optional[List[Dict[str, Any]]] = None

class PopularServersResponse(BaseModel):
    """Response model for popular servers with categorization"""
    success: bool
    servers: List[Dict[str, Any]]
    categorized: Dict[str, List[Dict[str, Any]]]
    total: int
    categoryCount: int
    pagination: Dict[str, int]

class CustomMCPConnectionRequest(BaseModel):
    """Request model for connecting to a custom MCP server"""
    url: str
    config: Optional[Dict[str, Any]] = {}
    
    @validator('url')
    def validate_smithery_url(cls, v):
        """Validate that the URL is a Smithery server URL"""
        if not v.startswith('https://server.smithery.ai/'):
            raise ValueError('URL must be a Smithery server URL starting with https://server.smithery.ai/')
        return v

class CustomMCPConnectionResponse(BaseModel):
    """Response model for custom MCP connection"""
    success: bool
    qualifiedName: str
    displayName: str
    tools: list[Dict[str, Any]]
    config: Dict[str, Any]
    url: str
    message: str

@router.get("/mcp/servers", response_model=MCPServerListResponse)
async def list_mcp_servers(
    q: Optional[str] = Query(None, description="Search query for semantic search"),
    page: int = Query(1, ge=1, description="Page number"),
    pageSize: int = Query(20, ge=1, le=100, description="Items per page"),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """
    List available MCP servers from Smithery.
    
    Query parameters:
    - q: Search query (semantic search)
    - page: Page number (default: 1)
    - pageSize: Number of items per page (default: 20, max: 100)
    
    Example queries:
    - "machine learning" - semantic search
    - "owner:smithery-ai" - filter by owner
    - "repo:fetch" - filter by repository
    - "is:deployed" - only deployed servers
    - "is:verified" - only verified servers
    """
    logger.info(f"Fetching MCP servers from Smithery for user {user_id} with query: {q}")
    
    try:
        async with httpx.AsyncClient() as client:
            headers = {
                "Accept": "application/json",
                "User-Agent": "Suna-MCP-Integration/1.0"
            }
            
            # Add API key if available
            if SMITHERY_API_KEY:
                headers["Authorization"] = f"Bearer {SMITHERY_API_KEY}"
                logger.debug("Using Smithery API key for authentication")
            else:
                logger.warning("No Smithery API key found in environment variables")
            
            params = {
                "page": page,
                "pageSize": pageSize
            }
            
            if q:
                params["q"] = q
            
            response = await client.get(
                f"{SMITHERY_API_BASE_URL}/servers",
                headers=headers,
                params=params,
                timeout=30.0
            )
            
            if response.status_code == 401:
                logger.warning("Smithery API authentication failed. API key may be required.")
                # Continue without auth - public servers should still be accessible
            
            response.raise_for_status()
            data = response.json()
            
            logger.info(f"Successfully fetched {len(data.get('servers', []))} MCP servers")
            return MCPServerListResponse(**data)
            
    except httpx.HTTPStatusError as e:
        logger.error(f"HTTP error fetching MCP servers: {e.response.status_code} - {e.response.text}")
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Failed to fetch MCP servers from Smithery: {e.response.text}"
        )
    except Exception as e:
        logger.error(f"Error fetching MCP servers: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch MCP servers: {str(e)}"
        )

@router.get("/mcp/servers/{qualified_name:path}", response_model=MCPServerDetailResponse)
async def get_mcp_server_details(
    qualified_name: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """
    Get detailed information about a specific MCP server.
    
    Parameters:
    - qualified_name: The unique identifier for the server (e.g., "exa", "@smithery-ai/github")
    """
    logger.info(f"Fetching details for MCP server: {qualified_name} for user {user_id}")
    
    try:
        async with httpx.AsyncClient() as client:
            headers = {
                "Accept": "application/json",
                "User-Agent": "Suna-MCP-Integration/1.0"
            }
            
            # Add API key if available
            if SMITHERY_API_KEY:
                headers["Authorization"] = f"Bearer {SMITHERY_API_KEY}"
            
            # URL encode the qualified name only if it contains special characters
            if '@' in qualified_name or '/' in qualified_name:
                encoded_name = quote(qualified_name, safe='')
            else:
                # Don't encode simple names like "exa"
                encoded_name = qualified_name
            
            url = f"{SMITHERY_API_BASE_URL}/servers/{encoded_name}"
            logger.debug(f"Requesting MCP server details from: {url}")
            
            response = await client.get(
                url,  # Use registry API for metadata
                headers=headers,
                timeout=30.0
            )
            
            logger.debug(f"Response status: {response.status_code}")
            
            response.raise_for_status()
            data = response.json()
            
            logger.info(f"Successfully fetched details for MCP server: {qualified_name}")
            logger.debug(f"Response data keys: {list(data.keys()) if isinstance(data, dict) else 'not a dict'}")
            
            return MCPServerDetailResponse(**data)
            
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            logger.error(f"Server not found. Response: {e.response.text}")
            raise HTTPException(status_code=404, detail=f"MCP server '{qualified_name}' not found")
        
        logger.error(f"HTTP error fetching MCP server details: {e.response.status_code} - {e.response.text}")
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Failed to fetch MCP server details: {e.response.text}"
        )
    except Exception as e:
        logger.error(f"Error fetching MCP server details: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch MCP server details: {str(e)}"
        )

@router.get("/mcp/popular-servers", response_model=PopularServersResponse)
async def get_popular_mcp_servers(
    page: int = Query(1, ge=1, description="Page number"),
    pageSize: int = Query(100, ge=1, le=200, description="Items per page (max 500 for comprehensive categorization)"),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """
    Get a comprehensive categorized list of popular MCP servers from Smithery Registry.
    
    Returns servers grouped by category with proper metadata and usage statistics.
    This endpoint fetches real data from the Smithery registry API and categorizes it.
    
    Query parameters:
    - page: Page number (default: 1)
    - pageSize: Number of items per page (default: 200, max: 500)
    """
    logger.info(f"Fetching  popular MCP servers for user {user_id}")
    
    try:
        async with httpx.AsyncClient() as client:
            headers = {
                "Accept": "application/json",
                "User-Agent": "Suna-MCP-Integration/1.0"
            }
            
            # Add API key if available
            if SMITHERY_API_KEY:
                headers["Authorization"] = f"Bearer {SMITHERY_API_KEY}"
                logger.debug("Using Smithery API key for authentication")
            else:
                logger.warning("No Smithery API key found in environment variables")
            
            # Use provided pagination parameters
            params = {
                "page": page,
                "pageSize": pageSize
            }
            
            response = await client.get(
                f"{SMITHERY_API_BASE_URL}/servers",
                headers=headers,
                params=params,
                timeout=30.0
            )
            
            if response.status_code != 200:
                logger.error(f"Failed to fetch MCP servers: {response.status_code} - {response.text}")
                return PopularServersResponse(
                    success=False,
                    servers=[],
                    categorized={},
                    total=0,
                    categoryCount=0,
                    pagination={"currentPage": page, "pageSize": pageSize, "totalPages": 0, "totalCount": 0}
                )
            
            data = response.json()
            servers = data.get("servers", [])
            pagination_data = data.get("pagination", {})
            
            # Category mappings based on server types and names
            category_mappings = {
                # AI & Search
                "exa": "AI & Search",
                "perplexity": "AI & Search", 
                "openai": "AI & Search",
                "anthropic": "AI & Search",
                "duckduckgo": "AI & Search",
                "brave": "AI & Search",
                "google": "AI & Search",
                "search": "AI & Search",
                
                # Development & Version Control
                "github": "Development & Version Control",
                "gitlab": "Development & Version Control",
                "bitbucket": "Development & Version Control",
                "git": "Development & Version Control",
                
                # Communication & Collaboration
                "slack": "Communication & Collaboration",
                "discord": "Communication & Collaboration",
                "teams": "Communication & Collaboration",
                "zoom": "Communication & Collaboration",
                "telegram": "Communication & Collaboration",
                
                # Project Management
                "linear": "Project Management",
                "jira": "Project Management",
                "asana": "Project Management",
                "notion": "Project Management",
                "trello": "Project Management",
                "monday": "Project Management",
                "clickup": "Project Management",
                
                # Data & Analytics
                "postgres": "Data & Analytics",
                "mysql": "Data & Analytics",
                "mongodb": "Data & Analytics",
                "bigquery": "Data & Analytics",
                "snowflake": "Data & Analytics",
                "sqlite": "Data & Analytics",
                "redis": "Data & Analytics",
                "database": "Data & Analytics",
                
                # Cloud & Infrastructure
                "aws": "Cloud & Infrastructure",
                "gcp": "Cloud & Infrastructure",
                "azure": "Cloud & Infrastructure",
                "vercel": "Cloud & Infrastructure",
                "netlify": "Cloud & Infrastructure",
                "cloudflare": "Cloud & Infrastructure",
                "docker": "Cloud & Infrastructure",
                
                # File Storage
                "gdrive": "File Storage",
                "google-drive": "File Storage",
                "dropbox": "File Storage",
                "box": "File Storage",
                "onedrive": "File Storage",
                "s3": "File Storage",
                "drive": "File Storage",
                
                # Customer Support
                "zendesk": "Customer Support",
                "intercom": "Customer Support",
                "freshdesk": "Customer Support",
                "helpscout": "Customer Support",
                
                # Marketing & Sales
                "hubspot": "Marketing & Sales",
                "salesforce": "Marketing & Sales",
                "mailchimp": "Marketing & Sales",
                "sendgrid": "Marketing & Sales",
                
                # Finance
                "stripe": "Finance",
                "quickbooks": "Finance",
                "xero": "Finance",
                "plaid": "Finance",
                
                # Automation & Productivity
                "playwright": "Automation & Productivity",
                "puppeteer": "Automation & Productivity",
                "selenium": "Automation & Productivity",
                "desktop-commander": "Automation & Productivity",
                "sequential-thinking": "Automation & Productivity",
                "automation": "Automation & Productivity",
                
                # Utilities
                "filesystem": "Utilities",
                "memory": "Utilities",
                "fetch": "Utilities",
                "time": "Utilities",
                "weather": "Utilities",
                "currency": "Utilities",
                "file": "Utilities",
            }
            
            # Categorize servers
            categorized_servers = {}
            
            for server in servers:
                qualified_name = server.get("qualifiedName", "")
                display_name = server.get("displayName", server.get("name", "Unknown"))
                description = server.get("description", "")
                
                # Determine category based on qualified name and description
                category = "Other"
                qualified_lower = qualified_name.lower()
                description_lower = description.lower()
                
                # Check qualified name first (most reliable)
                for key, cat in category_mappings.items():
                    if key in qualified_lower:
                        category = cat
                        break
                
                # If no match found, check description for category hints
                if category == "Other":
                    for key, cat in category_mappings.items():
                        if key in description_lower:
                            category = cat
                            break
                
                if category not in categorized_servers:
                    categorized_servers[category] = []
                
                categorized_servers[category].append({
                    "name": display_name,
                    "qualifiedName": qualified_name,
                    "description": description,
                    "iconUrl": server.get("iconUrl"),
                    "homepage": server.get("homepage"),
                    "useCount": server.get("useCount", 0),
                    "createdAt": server.get("createdAt"),
                    "isDeployed": server.get("isDeployed", False)
                })
            
            # Sort categories and servers within each category
            sorted_categories = OrderedDict()
            
            # Define priority order for categories
            priority_categories = [
                "AI & Search",
                "Development & Version Control", 
                "Automation & Productivity",
                "Communication & Collaboration",
                "Project Management",
                "Data & Analytics",
                "Cloud & Infrastructure",
                "File Storage",
                "Marketing & Sales",
                "Customer Support",
                "Finance",
                "Utilities",
                "Other"
            ]
            
            # Add categories in priority order
            for cat in priority_categories:
                if cat in categorized_servers:
                    sorted_categories[cat] = sorted(
                        categorized_servers[cat],
                        key=lambda x: (-x.get("useCount", 0), x["name"].lower())  # Sort by useCount desc, then name
                    )
            
            # Add any remaining categories
            for cat in sorted(categorized_servers.keys()):
                if cat not in sorted_categories:
                    sorted_categories[cat] = sorted(
                        categorized_servers[cat],
                        key=lambda x: (-x.get("useCount", 0), x["name"].lower())
                    )
            
            logger.info(f"Successfully categorized {len(servers)} servers into {len(sorted_categories)} categories")
            
            return PopularServersResponse(
                success=True,
                servers=servers,
                categorized=sorted_categories,
                total=pagination_data.get("totalCount", len(servers)),
                categoryCount=len(sorted_categories),
                pagination={
                    "currentPage": pagination_data.get("currentPage", page),
                    "pageSize": pagination_data.get("pageSize", pageSize),
                    "totalPages": pagination_data.get("totalPages", 1),
                    "totalCount": pagination_data.get("totalCount", len(servers))
                }
            )
            
    except Exception as e:
        logger.error(f"Error fetching  popular MCP servers: {str(e)}")
        return PopularServersResponse(
            success=False,
            servers=[],
            categorized={},
            total=0,
            categoryCount=0,
            pagination={"currentPage": page, "pageSize": pageSize, "totalPages": 0, "totalCount": 0}
        ) 
    

class CustomMCPDiscoverRequest(BaseModel):
    type: str
    config: Dict[str, Any]

@router.post("/mcp/discover-custom-tools")
async def discover_custom_mcp_tools(request: CustomMCPDiscoverRequest):
    try:
        return await discover_custom_tools(request.type, request.config)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error discovering custom MCP tools: {e}")
        raise HTTPException(status_code=500, detail=str(e))
