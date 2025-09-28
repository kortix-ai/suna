from typing import List, Dict, Any, Optional
from pydantic import BaseModel
from core.utils.logger import logger
from .client import ComposioClient


class CategoryInfo(BaseModel):
    id: str
    name: str


class ToolkitInfo(BaseModel):
    slug: str
    name: str
    description: Optional[str] = None
    logo: Optional[str] = None
    tags: List[str] = []
    auth_schemes: List[str] = []
    categories: List[str] = []


class AuthConfigField(BaseModel):
    name: str
    displayName: str
    type: str
    description: Optional[str] = None
    required: bool = False
    default: Optional[str] = None
    legacy_template_name: Optional[str] = None


class AuthConfigDetails(BaseModel):
    name: str
    mode: str
    fields: Dict[str, Dict[str, List[AuthConfigField]]]


class DetailedToolkitInfo(BaseModel):
    slug: str
    name: str
    description: Optional[str] = None
    logo: Optional[str] = None
    tags: List[str] = []
    auth_schemes: List[str] = []
    categories: List[str] = []
    auth_config_details: List[AuthConfigDetails] = []
    connected_account_initiation_fields: Optional[Dict[str, List[AuthConfigField]]] = None
    base_url: Optional[str] = None


class ParameterSchema(BaseModel):
    properties: Dict[str, Any] = {}
    required: Optional[List[str]] = None


class ToolInfo(BaseModel):
    slug: str
    name: str
    description: str
    version: str
    input_parameters: ParameterSchema = ParameterSchema()
    output_parameters: ParameterSchema = ParameterSchema()
    scopes: List[str] = []
    tags: List[str] = []
    no_auth: bool = False


class ToolsListResponse(BaseModel):
    items: List[ToolInfo]
    next_cursor: Optional[str] = None
    total_items: int
    current_page: int = 1
    total_pages: int = 1


class ToolkitService:
    def __init__(self, api_key: Optional[str] = None):
        self.client = ComposioClient.get_client(api_key)
    
    async def list_categories(self) -> List[CategoryInfo]:
        try:
            logger.debug("Fetching Composio categories")
            popular_categories = [
                {"id": "popular", "name": "Popular"},
                {"id": "productivity", "name": "Productivity"},
                {"id": "crm", "name": "CRM"},
                {"id": "marketing", "name": "Marketing"},
                {"id": "analytics", "name": "Analytics"},
                {"id": "communication", "name": "Communication"},
                {"id": "project-management", "name": "Project Management"},
                {"id": "scheduling", "name": "Scheduling"},
            ]

            special_apps=[
                "googlesuper",
                'googleclassroom',
                "docusign"
            ]
            
            categories = [CategoryInfo(**cat) for cat in popular_categories]
            logger.debug(f"Successfully fetched {len(categories)} categories")
            return categories
            
        except Exception as e:
            logger.error(f"Failed to list categories: {e}", exc_info=True)
            raise
    
    async def list_toolkits(self, limit: int = 500, cursor: Optional[str] = None, category: Optional[str] = None) -> Dict[str, Any]:
        try:
            logger.debug(f"Fetching toolkits with limit: {limit}, cursor: {cursor}, category: {category}")
            params = {
                "limit": limit,
                "managed_by": "composio"
            }
            
            if cursor:
                params["cursor"] = cursor
            if category:
                params["category"] = category
            
            toolkits_response = self.client.toolkits.list(**params)
            
            if hasattr(toolkits_response, '__dict__'):
                response_data = toolkits_response.__dict__
            else:
                response_data = toolkits_response
            
            items = response_data.get('items', [])
            
            toolkits = []
            for item in items:
                if hasattr(item, '__dict__'):
                    toolkit_data = item.__dict__
                elif hasattr(item, '_asdict'):
                    toolkit_data = item._asdict()
                else:
                    toolkit_data = item
                
                auth_schemes = toolkit_data.get("auth_schemes", [])
                composio_managed_auth_schemes = toolkit_data.get("composio_managed_auth_schemes", [])

                if "OAUTH2" not in auth_schemes or "OAUTH2" not in composio_managed_auth_schemes:
                    continue
                
                logo_url = None
                meta = toolkit_data.get("meta", {})
                if isinstance(meta, dict):
                    logo_url = meta.get("logo")
                elif hasattr(meta, '__dict__'):
                    logo_url = meta.__dict__.get("logo")
                
                if not logo_url:
                    logo_url = toolkit_data.get("logo")
                
                tags = []
                categories = []
                if isinstance(meta, dict) and "categories" in meta:
                    category_list = meta.get("categories", [])
                    for cat in category_list:
                        if isinstance(cat, dict):
                            cat_name = cat.get("name", "")
                            cat_id = cat.get("id", "")
                            tags.append(cat_name)
                            categories.append(cat_id)
                        elif hasattr(cat, '__dict__'):
                            cat_name = cat.__dict__.get("name", "")
                            cat_id = cat.__dict__.get("id", "")
                            tags.append(cat_name)
                            categories.append(cat_id)
                
                description = None
                if isinstance(meta, dict):
                    description = meta.get("description")
                elif hasattr(meta, '__dict__'):
                    description = meta.__dict__.get("description")
                
                if not description:
                    description = toolkit_data.get("description")
                
                toolkit = ToolkitInfo(
                    slug=toolkit_data.get("slug", ""),
                    name=toolkit_data.get("name", ""),
                    description=description,
                    logo=logo_url,
                    tags=tags,
                    auth_schemes=auth_schemes,
                    categories=categories
                )
                toolkits.append(toolkit)
            
            result = {
                "items": toolkits,
                "total_items": response_data.get("total_items", len(toolkits)),
                "total_pages": response_data.get("total_pages", 1),
                "current_page": response_data.get("current_page", 1),
                "next_cursor": response_data.get("next_cursor")
            }
            
            logger.debug(f"Successfully fetched {len(toolkits)} toolkits with OAUTH2 in both auth schemes" + (f" for category {category}" if category else ""))
            return result
            
        except Exception as e:
            logger.error(f"Failed to list toolkits: {e}", exc_info=True)
            raise
    
    async def get_toolkit_by_slug(self, slug: str) -> Optional[ToolkitInfo]:
        try:
            toolkits_response = await self.list_toolkits()
            toolkits = toolkits_response.get("items", [])
            for toolkit in toolkits:
                if toolkit.slug == slug:
                    return toolkit
            return None
        except Exception as e:
            logger.error(f"Failed to get toolkit {slug}: {e}", exc_info=True)
            raise
    
    async def search_toolkits(self, query: str, category: Optional[str] = None, limit: int = 100, cursor: Optional[str] = None) -> Dict[str, Any]:
        try:
            all_toolkits_response = await self.list_toolkits(limit=500, cursor=cursor, category=category)
            toolkits = all_toolkits_response.get("items", [])
            query_lower = query.lower()
            
            filtered_toolkits = [
                toolkit for toolkit in toolkits
                if query_lower in toolkit.name.lower() 
                or (toolkit.description and query_lower in toolkit.description.lower())
                or any(query_lower in tag.lower() for tag in toolkit.tags)
            ]
            
            limited_results = filtered_toolkits[:limit]
            
            result = {
                "items": limited_results,
                "total_items": len(filtered_toolkits),
                "total_pages": 1,
                "current_page": 1,
                "next_cursor": None
            }
            
            logger.debug(f"Found {len(filtered_toolkits)} toolkits with OAUTH2 in both auth schemes matching query: {query}" + (f" in category {category}" if category else ""))
            return result
            
        except Exception as e:
            logger.error(f"Failed to search toolkits: {e}", exc_info=True)
            raise
    
    async def get_toolkit_icon(self, toolkit_slug: str) -> Optional[str]:
        try:
            logger.debug(f"Fetching toolkit icon for: {toolkit_slug}")
            toolkit_response = self.client.toolkits.retrieve(toolkit_slug)
            
            if hasattr(toolkit_response, 'model_dump'):
                toolkit_dict = toolkit_response.model_dump()
            elif hasattr(toolkit_response, '__dict__'):
                toolkit_dict = toolkit_response.__dict__
            else:
                toolkit_dict = dict(toolkit_response)
            
            meta = toolkit_dict.get('meta', {})
            if isinstance(meta, dict):
                logo = meta.get('logo')
            elif hasattr(meta, '__dict__'):
                logo = meta.__dict__.get('logo')
            else:
                logo = None
            
            logger.debug(f"Successfully fetched icon for {toolkit_slug}: {logo}")
            return logo
            
        except Exception as e:
            logger.error(f"Failed to get toolkit icon for {toolkit_slug}: {e}")
            return None

    async def get_detailed_toolkit_info(self, toolkit_slug: str) -> Optional[DetailedToolkitInfo]:
        try:
            logger.debug(f"Fetching detailed toolkit info for: {toolkit_slug}")
            toolkit_response = self.client.toolkits.retrieve(toolkit_slug)
            
            if hasattr(toolkit_response, 'model_dump'):
                toolkit_dict = toolkit_response.model_dump()
            elif hasattr(toolkit_response, '__dict__'):
                toolkit_dict = toolkit_response.__dict__
            else:
                toolkit_dict = dict(toolkit_response)
            
            logger.debug(f"Raw toolkit response for {toolkit_slug}: {toolkit_response}")
            
            meta = toolkit_dict.get('meta', {})
            if hasattr(meta, '__dict__'):
                meta = meta.__dict__
            
            detailed_toolkit = DetailedToolkitInfo(
                slug=toolkit_dict.get('slug', ''),
                name=toolkit_dict.get('name', ''),
                description=meta.get('description', '') if isinstance(meta, dict) else getattr(meta, 'description', ''),
                logo=meta.get('logo') if isinstance(meta, dict) else getattr(meta, 'logo', None),
                tags=[],
                auth_schemes=toolkit_dict.get('composio_managed_auth_schemes', []),
                categories=[],
                base_url=toolkit_dict.get('base_url')
            )
            
            categories_data = meta.get('categories', []) if isinstance(meta, dict) else getattr(meta, 'categories', [])
            detailed_toolkit.categories = [
                cat.get('name', '') if isinstance(cat, dict) else getattr(cat, 'name', '') 
                for cat in categories_data
            ]
            
            logger.debug(f"Parsed basic toolkit info: {detailed_toolkit}")
            
            auth_config_details = []
            raw_auth_configs = toolkit_dict.get('auth_config_details', [])
            
            for config in raw_auth_configs:
                if hasattr(config, '__dict__'):
                    config_dict = config.__dict__
                else:
                    config_dict = config
                
                fields_obj = config_dict.get('fields')
                if hasattr(fields_obj, '__dict__'):
                    fields_dict = fields_obj.__dict__
                else:
                    fields_dict = fields_obj or {}
                
                auth_fields = {}
                
                for field_type, field_type_obj in fields_dict.items():
                    auth_fields[field_type] = {}
                    
                    if hasattr(field_type_obj, '__dict__'):
                        field_type_dict = field_type_obj.__dict__
                    else:
                        field_type_dict = field_type_obj or {}
                    
                    for requirement_level in ['required', 'optional']:
                        field_list = field_type_dict.get(requirement_level, [])
                        
                        auth_config_fields = []
                        for field in field_list:
                            if hasattr(field, '__dict__'):
                                field_dict = field.__dict__
                            else:
                                field_dict = field
                            
                            auth_config_fields.append(AuthConfigField(
                                name=field_dict.get('name', ''),
                                displayName=field_dict.get('display_name', ''),
                                type=field_dict.get('type', 'string'),
                                description=field_dict.get('description'),
                                required=field_dict.get('required', False),
                                default=field_dict.get('default'),
                                legacy_template_name=field_dict.get('legacy_template_name')
                            ))
                        auth_fields[field_type][requirement_level] = auth_config_fields
                
                auth_config_details.append(AuthConfigDetails(
                    name=config_dict.get('name', ''),
                    mode=config_dict.get('mode', ''),
                    fields=auth_fields
                ))
            
            detailed_toolkit.auth_config_details = auth_config_details
            
            connected_account_initiation = None
            for config in raw_auth_configs:
                if hasattr(config, '__dict__'):
                    config_dict = config.__dict__
                else:
                    config_dict = config
                
                fields_obj = config_dict.get('fields')
                if hasattr(fields_obj, '__dict__'):
                    fields_dict = fields_obj.__dict__
                else:
                    fields_dict = fields_obj or {}
                
                initiation_obj = fields_dict.get('connected_account_initiation')
                if initiation_obj:
                    if hasattr(initiation_obj, '__dict__'):
                        initiation_dict = initiation_obj.__dict__
                    else:
                        initiation_dict = initiation_obj
                    
                    connected_account_initiation = {}
                    for requirement_level in ['required', 'optional']:
                        field_list = initiation_dict.get(requirement_level, [])
                        initiation_fields = []
                        for field in field_list:
                            if hasattr(field, '__dict__'):
                                field_dict = field.__dict__
                            else:
                                field_dict = field
                            
                            initiation_fields.append(AuthConfigField(
                                name=field_dict.get('name', ''),
                                displayName=field_dict.get('display_name', ''),
                                type=field_dict.get('type', 'string'),
                                description=field_dict.get('description'),
                                required=field_dict.get('required', False),
                                default=field_dict.get('default'),
                                legacy_template_name=field_dict.get('legacy_template_name')
                            ))
                        connected_account_initiation[requirement_level] = initiation_fields
                    break
            
            detailed_toolkit.connected_account_initiation_fields = connected_account_initiation
            
            logger.debug(f"Successfully fetched detailed info for {toolkit_slug}")
            logger.debug(f"Initiation fields: {connected_account_initiation}")
            return detailed_toolkit
            
        except Exception as e:
            logger.error(f"Failed to get detailed toolkit info for {toolkit_slug}: {e}", exc_info=True)
            return None

    async def get_toolkit_tools(self, toolkit_slug: str, limit: int = 50, cursor: Optional[str] = None) -> ToolsListResponse:
        try:
            logger.debug(f"Fetching tools for toolkit: {toolkit_slug}")
            
            params = {
                "limit": limit,
                "toolkit_slug": toolkit_slug
            }
            
            if cursor:
                params["cursor"] = cursor
            
            tools_response = self.client.tools.list(**params)
            
            if hasattr(tools_response, '__dict__'):
                response_data = tools_response.__dict__
            else:
                response_data = tools_response
            
            items = response_data.get('items', [])
            
            tools = []
            for item in items:
                if hasattr(item, '__dict__'):
                    tool_data = item.__dict__
                elif hasattr(item, '_asdict'):
                    tool_data = item._asdict()
                else:
                    tool_data = item
                
                input_params_raw = tool_data.get("input_parameters", {})
                output_params_raw = tool_data.get("output_parameters", {})
                
                input_parameters = ParameterSchema()
                if isinstance(input_params_raw, dict):
                    input_parameters.properties = input_params_raw.get("properties", input_params_raw)
                    input_parameters.required = input_params_raw.get("required")
                
                output_parameters = ParameterSchema()  
                if isinstance(output_params_raw, dict):
                    output_parameters.properties = output_params_raw.get("properties", output_params_raw)
                    output_parameters.required = output_params_raw.get("required")
                
                tool = ToolInfo(
                    slug=tool_data.get("slug", ""),
                    name=tool_data.get("name", ""),
                    description=tool_data.get("description", ""),
                    version=tool_data.get("version", "1.0.0"),
                    input_parameters=input_parameters,
                    output_parameters=output_parameters,
                    scopes=tool_data.get("scopes", []),
                    tags=tool_data.get("tags", []),
                    no_auth=tool_data.get("no_auth", False)
                )
                tools.append(tool)
            
            result = ToolsListResponse(
                items=tools,
                total_items=response_data.get("total_items", len(tools)),
                total_pages=response_data.get("total_pages", 1),
                current_page=response_data.get("current_page", 1),
                next_cursor=response_data.get("next_cursor")
            )
            
            logger.debug(f"Successfully fetched {len(tools)} tools for toolkit {toolkit_slug}")
            return result
            
        except Exception as e:
            logger.error(f"Failed to get tools for toolkit {toolkit_slug}: {e}", exc_info=True)
            return ToolsListResponse(
                items=[],
                total_items=0,
                current_page=1,
                total_pages=1
            ) 
