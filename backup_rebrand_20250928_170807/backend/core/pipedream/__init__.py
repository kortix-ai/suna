from core.utils.logger import logger
from core.services.supabase import DBConnection

from .profile_service import ProfileService, Profile
from .connection_service import ConnectionService, Connection, AuthType
from .app_service import get_app_service, App
from .mcp_service import MCPService, MCPServer, MCPTool, ConnectionStatus
from .connection_token_service import ConnectionTokenService

db = DBConnection()

profile_service = ProfileService()
connection_service = ConnectionService()
app_service = get_app_service()
mcp_service = MCPService()
connection_token_service = ConnectionTokenService()

from . import api
api.profile_service = profile_service
api.connection_service = connection_service
api.app_service = app_service
api.mcp_service = mcp_service
api.connection_token_service = connection_token_service

__all__ = [
    'Profile',
    'Connection', 
    'App',
    'MCPServer',
    'MCPTool',
    'ConnectionStatus',
    'AuthType',
    'profile_service',
    'connection_service',
    'app_service',
    'mcp_service',
    'connection_token_service',
    'api'
]
