"""Service for managing resources (sandboxes, databases, etc.) in the database."""

from typing import Optional, Dict, Any
from datetime import datetime
from core.utils.logger import logger
from core.resources.resource_types import ResourceType, ResourceStatus, SandboxConfig


class ResourceService:
    """Service for CRUD operations on resources."""
    
    def __init__(self, client):
        """Initialize with a Supabase client."""
        self.client = client
    
    async def create_resource(
        self,
        account_id: str,
        resource_type: ResourceType,
        external_id: str,
        config: Dict[str, Any],
        status: ResourceStatus = ResourceStatus.ACTIVE
    ) -> Dict[str, Any]:
        """
        Create a new resource record.
        
        Args:
            account_id: Account that owns this resource
            resource_type: Type of resource (e.g., ResourceType.SANDBOX)
            external_id: External ID (e.g., Daytona sandbox_id)
            config: Configuration dict (e.g., pass, vnc_preview, sandbox_url, token)
            status: Initial status (default: ACTIVE)
            
        Returns:
            Created resource record
        """
        resource_data = {
            'account_id': account_id,
            'type': resource_type.value,
            'external_id': external_id,
            'status': status.value,
            'config': config,
            'created_at': datetime.utcnow().isoformat(),
            'updated_at': datetime.utcnow().isoformat()
        }
        
        result = await self.client.table('resources').insert(resource_data).execute()
        
        if not result.data or len(result.data) == 0:
            raise Exception("Failed to create resource")
        
        logger.debug(f"Created resource {result.data[0]['id']} of type {resource_type.value} for account {account_id}")
        return result.data[0]
    
    async def get_resource_by_id(self, resource_id: str) -> Optional[Dict[str, Any]]:
        """Get a resource by its ID."""
        result = await self.client.table('resources').select('*').eq('id', resource_id).execute()
        
        if not result.data or len(result.data) == 0:
            return None
        
        return result.data[0]
    
    async def get_resource_by_external_id(
        self,
        external_id: str,
        resource_type: Optional[ResourceType] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Get a resource by its external ID (e.g., Daytona sandbox_id).
        
        Args:
            external_id: External ID to search for
            resource_type: Optional filter by resource type
        """
        query = self.client.table('resources').select('*').eq('external_id', external_id)
        
        if resource_type:
            query = query.eq('type', resource_type.value)
        
        result = await query.execute()
        
        if not result.data or len(result.data) == 0:
            return None
        
        return result.data[0]
    
    async def get_account_resources(
        self,
        account_id: str,
        resource_type: Optional[ResourceType] = None,
        status: Optional[ResourceStatus] = None
    ) -> list[Dict[str, Any]]:
        """
        Get all resources for an account, optionally filtered by type and status.
        
        Args:
            account_id: Account ID
            resource_type: Optional filter by resource type
            status: Optional filter by status
        """
        query = self.client.table('resources').select('*').eq('account_id', account_id)
        
        if resource_type:
            query = query.eq('type', resource_type.value)
        
        if status:
            query = query.eq('status', status.value)
        
        result = await query.execute()
        return result.data or []
    
    async def update_resource(
        self,
        resource_id: str,
        config: Optional[Dict[str, Any]] = None,
        status: Optional[ResourceStatus] = None,
        external_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Update a resource.
        
        Args:
            resource_id: Resource ID to update
            config: Optional new config dict
            status: Optional new status
            external_id: Optional new external_id
        """
        update_data: Dict[str, Any] = {
            'updated_at': datetime.utcnow().isoformat()
        }
        
        if config is not None:
            update_data['config'] = config
        
        if status is not None:
            update_data['status'] = status.value
        
        if external_id is not None:
            update_data['external_id'] = external_id
        
        result = await self.client.table('resources').update(update_data).eq('id', resource_id).execute()
        
        if not result.data or len(result.data) == 0:
            raise Exception(f"Failed to update resource {resource_id}")
        
        logger.debug(f"Updated resource {resource_id}")
        return result.data[0]
    
    async def update_last_used(self, resource_id: str) -> None:
        """Update the last_used_at timestamp for a resource."""
        await self.client.table('resources').update({
            'last_used_at': datetime.utcnow().isoformat()
        }).eq('id', resource_id).execute()
    
    async def delete_resource(self, resource_id: str) -> bool:
        """
        Delete a resource (soft delete by setting status to DELETED).
        
        Args:
            resource_id: Resource ID to delete
            
        Returns:
            True if deleted successfully
        """
        try:
            await self.update_resource(resource_id, status=ResourceStatus.DELETED)
            logger.debug(f"Deleted resource {resource_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete resource {resource_id}: {str(e)}")
            return False
    
    async def get_project_sandbox_resource(self, project_id: str) -> Optional[Dict[str, Any]]:
        """
        Get the sandbox resource for a project.
        
        Args:
            project_id: Project ID
            
        Returns:
            Resource record if found, None otherwise
        """
        # Get project with sandbox_resource_id
        project_result = await self.client.table('projects').select('sandbox_resource_id').eq('project_id', project_id).execute()
        
        if not project_result.data or len(project_result.data) == 0:
            return None
        
        sandbox_resource_id = project_result.data[0].get('sandbox_resource_id')
        
        if not sandbox_resource_id:
            return None
        
        return await self.get_resource_by_id(sandbox_resource_id)
    
    async def link_resource_to_project(
        self,
        project_id: str,
        resource_id: str
    ) -> bool:
        """
        Link a resource to a project.
        
        Args:
            project_id: Project ID
            resource_id: Resource ID to link
            
        Returns:
            True if linked successfully
        """
        result = await self.client.table('projects').update({
            'sandbox_resource_id': resource_id
        }).eq('project_id', project_id).execute()
        
        if not result.data:
            logger.error(f"Failed to link resource {resource_id} to project {project_id}")
            return False
        
        logger.debug(f"Linked resource {resource_id} to project {project_id}")
        return True


def get_resource_service(client) -> ResourceService:
    """Factory function to create a ResourceService instance."""
    return ResourceService(client)

