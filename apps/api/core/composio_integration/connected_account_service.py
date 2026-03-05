from typing import Optional, List, Dict, Any
from pydantic import BaseModel
from core.utils.logger import logger
from enum import Enum
from .client import ComposioClient
import json


class ConnectionState(BaseModel):
    auth_scheme: str = "OAUTH2"
    val: Dict[str, Any] = {}


class ConnectedAccount(BaseModel):
    id: str
    status: str
    redirect_url: Optional[str] = None
    redirect_uri: Optional[str] = None
    connection_data: ConnectionState
    auth_config_id: str
    user_id: str
    deprecated: Optional[bool] = None


class ConnectedAccountService:
    def __init__(self, api_key: Optional[str] = None):
        self.client = ComposioClient.get_client(api_key)
    
    def _extract_deprecated_value(self, deprecated_obj) -> Optional[bool]:
        if deprecated_obj is None:
            return None
        
        if isinstance(deprecated_obj, bool):
            return deprecated_obj

        if hasattr(deprecated_obj, '__dict__'):
            deprecated_dict = deprecated_obj.__dict__
            if deprecated_dict:
                return True
        
        return False
    
    def _extract_val_dict(self, val_obj) -> Dict[str, Any]:
        if val_obj is None:
            return {}
        
        if isinstance(val_obj, dict):
            return val_obj
        
        if hasattr(val_obj, 'model_dump'):
            return val_obj.model_dump()
        elif hasattr(val_obj, 'dict'):
            return val_obj.dict()
        elif hasattr(val_obj, '__dict__'):
            return val_obj.__dict__

        return {}
    
    async def create_connected_account(
        self, 
        auth_config_id: str, 
        user_id: str,
        initiation_fields: Optional[Dict[str, str]] = None
    ) -> ConnectedAccount:
        try:
            print("[DEBUG] Auth config id: ", auth_config_id)
            print("[DEBUG] User id: ", user_id)
            print("[DEBUG] Initiation fields: ", initiation_fields)
            
            state_val = {"status": "INITIALIZING"}
            
            if initiation_fields:
                for field_name, field_value in initiation_fields.items():
                    if field_value:
                        if field_name == "suffix.one":
                            state_val["extension"] = str(field_value)
                        else:
                            state_val[field_name] = str(field_value)
            
            logger.debug(f"Using state.val: {state_val}")
            logger.debug(f"Final state.val for Composio API: {json.dumps(state_val, indent=2)}")
            
            response = self.client.connected_accounts.create(
                auth_config={
                    "id": auth_config_id
                },
                connection={
                    "user_id": user_id,
                    "state": {
                        "authScheme": "OAUTH2",
                        "val": state_val,
                    }
                }
            )
            
            connection_data_obj = getattr(response, 'connection_data', None)
            if not connection_data_obj:
                connection_data_obj = getattr(response, 'connectionData', None)
            
            if connection_data_obj and hasattr(connection_data_obj, '__dict__'):
                connection_data_dict = connection_data_obj.__dict__
                
                val_obj = connection_data_dict.get('val', {})
                val_dict = self._extract_val_dict(val_obj)
                
                connection_data = ConnectionState(
                    auth_scheme=connection_data_dict.get('auth_scheme', 'OAUTH2'),
                    val=val_dict
                )
            else:
                connection_data = ConnectionState()
            
            deprecated_obj = getattr(response, 'deprecated', None)
            deprecated_value = self._extract_deprecated_value(deprecated_obj)
            
            connected_account = ConnectedAccount(
                id=response.id,
                status=response.status,
                redirect_url=getattr(response, 'redirect_url', None),
                redirect_uri=getattr(response, 'redirect_uri', None),
                connection_data=connection_data,
                auth_config_id=auth_config_id,
                user_id=user_id,
                deprecated=deprecated_value
            )
            
            logger.debug(f"Successfully created connected account: {connected_account.id}")
            return connected_account
            
        except Exception as e:
            logger.error(f"Failed to create connected account: {e}", exc_info=True)
            raise
    
    async def get_connected_account(self, connected_account_id: str) -> Optional[ConnectedAccount]:
        try:
            logger.debug(f"Fetching connected account: {connected_account_id}")
            
            response = self.client.connected_accounts.get(connected_account_id)
            
            if not response:
                return None
            
            connection_data_obj = getattr(response, 'connection_data', None)
            if not connection_data_obj:
                connection_data_obj = getattr(response, 'connectionData', None)
            
            if connection_data_obj and hasattr(connection_data_obj, '__dict__'):
                connection_data_dict = connection_data_obj.__dict__
                
                val_obj = connection_data_dict.get('val', {})
                val_dict = self._extract_val_dict(val_obj)
                
                connection_data = ConnectionState(
                    auth_scheme=connection_data_dict.get('auth_scheme', 'OAUTH2'),
                    val=val_dict
                )
            else:
                connection_data = ConnectionState()
            
            deprecated_obj = getattr(response, 'deprecated', None)
            deprecated_value = self._extract_deprecated_value(deprecated_obj)
            
            return ConnectedAccount(
                id=response.id,
                status=response.status,
                redirect_url=getattr(response, 'redirect_url', None),
                redirect_uri=getattr(response, 'redirect_uri', None),
                connection_data=connection_data,
                auth_config_id=getattr(response, 'auth_config_id', ''),
                user_id=getattr(response, 'user_id', ''),
                deprecated=deprecated_value
            )
            
        except Exception as e:
            logger.error(f"Failed to get connected account {connected_account_id}: {e}", exc_info=True)
            raise
    
    async def get_auth_status(self, connected_account_id: str) -> Dict[str, Any]:
        try:
            logger.debug(f"Getting auth status for connected account: {connected_account_id}")
            
            connected_account = await self.get_connected_account(connected_account_id)
            
            if not connected_account:
                return {"status": "not_found", "message": "Connected account not found"}
            
            return {
                "status": connected_account.status,
                "redirect_url": connected_account.redirect_url,
                "connection_data": connected_account.connection_data.dict()
            }
            
        except Exception as e:
            logger.error(f"Failed to get auth status: {e}", exc_info=True)
            raise
    
    async def list_connected_accounts(self, auth_config_id: Optional[str] = None) -> List[ConnectedAccount]:
        try:
            logger.debug(f"Listing connected accounts for auth_config: {auth_config_id}")
            
            if auth_config_id:
                response = self.client.connected_accounts.list(auth_config_id=auth_config_id)
            else:
                response = self.client.connected_accounts.list()
            
            connected_accounts = []
            items = getattr(response, 'items', [])
            
            for item in items:
                connection_data_obj = getattr(item, 'connection_data', None)
                if not connection_data_obj:
                    connection_data_obj = getattr(item, 'connectionData', None)
                
                if connection_data_obj and hasattr(connection_data_obj, '__dict__'):
                    connection_data_dict = connection_data_obj.__dict__
                    
                    val_obj = connection_data_dict.get('val', {})
                    val_dict = self._extract_val_dict(val_obj)
                    
                    connection_data = ConnectionState(
                        auth_scheme=connection_data_dict.get('auth_scheme', 'OAUTH2'),
                        val=val_dict
                    )
                else:
                    connection_data = ConnectionState()
                
                deprecated_obj = getattr(item, 'deprecated', None)
                deprecated_value = self._extract_deprecated_value(deprecated_obj)
                
                connected_account = ConnectedAccount(
                    id=item.id,
                    status=item.status,
                    redirect_url=getattr(item, 'redirect_url', None),
                    redirect_uri=getattr(item, 'redirect_uri', None),
                    connection_data=connection_data,
                    auth_config_id=getattr(item, 'auth_config_id', auth_config_id or ''),
                    user_id=getattr(item, 'user_id', ''),
                    deprecated=deprecated_value
                )
                connected_accounts.append(connected_account)
            
            logger.debug(f"Successfully listed {len(connected_accounts)} connected accounts")
            return connected_accounts
            
        except Exception as e:
            logger.error(f"Failed to list connected accounts: {e}", exc_info=True)
            raise 