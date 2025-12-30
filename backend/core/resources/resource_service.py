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
        Automatically migrates sandbox data from JSONB if needed.
        
        Args:
            project_id: Project ID
            
        Returns:
            Resource record if found, None otherwise
        """
        # Lazy migration: Migrate sandbox JSONB to resources table if needed
        await self.migrate_project_sandbox_if_needed(project_id)
        
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
    
    async def migrate_project_sandbox_if_needed(self, project_id: str) -> Optional[Dict[str, Any]]:
        """
        Lazy migration: Migrate sandbox data from projects.sandbox JSONB to resources table.
        This is called automatically when accessing a project to migrate on-demand.
        
        Args:
            project_id: Project ID to check and migrate if needed
            
        Returns:
            Resource record if migration happened, None otherwise
        """
        try:
            # First, check if already migrated (query only columns that always exist)
            project_result = await self.client.table('projects').select(
                'project_id, account_id, sandbox_resource_id'
            ).eq('project_id', project_id).execute()
            
            if not project_result.data or len(project_result.data) == 0:
                return None
            
            project_data = project_result.data[0]
            sandbox_resource_id = project_data.get('sandbox_resource_id')
            account_id = project_data.get('account_id')
            
            # If already migrated, nothing to do
            if sandbox_resource_id:
                return None
            
            # Try to get sandbox JSONB data (column only exists in production)
            try:
                sandbox_result = await self.client.table('projects').select(
                    'sandbox'
                ).eq('project_id', project_id).execute()
                sandbox_jsonb = sandbox_result.data[0].get('sandbox') if sandbox_result.data else None
            except Exception as col_error:
                # Column doesn't exist in this environment (e.g., local/dev)
                # This is expected - only production has the legacy sandbox column
                if '42703' in str(col_error) or 'does not exist' in str(col_error):
                    return None
                raise  # Re-raise unexpected errors
            
            # If no sandbox data in JSONB, nothing to migrate
            if not sandbox_jsonb or not isinstance(sandbox_jsonb, dict):
                return None
            
            sandbox_id = sandbox_jsonb.get('id')
            if not sandbox_id:
                return None
            
            # Check if resource already exists for this external_id + account_id
            existing_resource = await self.get_resource_by_external_id(
                sandbox_id,
                ResourceType.SANDBOX
            )
            
            if existing_resource:
                # Resource exists, just link it to the project
                resource_id = existing_resource['id']
                if await self.link_resource_to_project(project_id, resource_id):
                    logger.info(f"Lazy migration: Linked existing resource {resource_id} to project {project_id}")
                    return existing_resource
                return None
            
            # Create new resource from sandbox JSONB data
            sandbox_config = {
                'pass': sandbox_jsonb.get('pass'),
                'vnc_preview': sandbox_jsonb.get('vnc_preview'),
                'sandbox_url': sandbox_jsonb.get('sandbox_url'),
                'token': sandbox_jsonb.get('token')
            }
            
            # Remove None values
            sandbox_config = {k: v for k, v in sandbox_config.items() if v is not None}
            
            resource = await self.create_resource(
                account_id=account_id,
                resource_type=ResourceType.SANDBOX,
                external_id=sandbox_id,
                config=sandbox_config,
                status=ResourceStatus.ACTIVE
            )
            
            # Link resource to project
            if await self.link_resource_to_project(project_id, resource['id']):
                logger.info(f"Lazy migration: Migrated sandbox data for project {project_id} to resource {resource['id']}")
                return resource
            else:
                # Cleanup if linking failed
                await self.delete_resource(resource['id'])
                logger.error(f"Lazy migration: Failed to link resource to project {project_id}, cleaned up resource")
                return None
                
        except Exception as e:
            logger.error(f"Lazy migration failed for project {project_id}: {str(e)}", exc_info=True)
            return None


def get_resource_service(client) -> ResourceService:
    """Factory function to create a ResourceService instance."""
    return ResourceService(client)

