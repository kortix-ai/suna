"""
Convex HTTP client for backend integration.

This module provides an HTTP client for communicating with the Convex backend,
replacing Supabase for the data layer while maintaining compatibility with
the existing FastAPI backend architecture.
"""

import httpx
from typing import Any, Optional, Dict, List
import os
import logging
import json

logger = logging.getLogger(__name__)


class ConvexError(Exception):
    """Base exception for Convex client errors."""

    def __init__(self, message: str, status_code: int = None, details: dict = None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details or {}


class ConvexClient:
    """HTTP client for Convex backend integration.

    This client handles all communication with the Convex deployment,
    including authentication, thread management, agent runs, and memory operations.

    Attributes:
        convex_url: The base URL of the Convex deployment
        api_key: API key for authentication
        client: Async HTTP client instance
    """

    def __init__(self, convex_url: str, api_key: str):
        """Initialize the Convex client.

        Args:
            convex_url: The base URL of the Convex deployment (e.g., https://your-deployment.convex.cloud)
            api_key: API key for authentication with Convex
        """
        self.convex_url = convex_url.rstrip('/')
        self.api_key = api_key
        self.client = httpx.AsyncClient(
            timeout=60.0,
            headers={
                "User-Agent": "Kortix-Backend/1.0",
            }
        )
        logger.info(f"ConvexClient initialized for {self.convex_url}")

    async def close(self):
        """Close the HTTP client connection."""
        await self.client.aclose()

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.close()

    def _get_headers(self, account_id: str = None) -> dict:
        """Build request headers with authentication.

        Args:
            account_id: Optional account ID for multi-tenant requests

        Returns:
            Dict of headers for the request
        """
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        if account_id:
            headers["X-Account-Id"] = account_id
        return headers

    async def call(
        self,
        path: str,
        method: str = "POST",
        data: dict = None,
        account_id: str = None,
        params: dict = None
    ) -> dict:
        """Make an HTTP request to the Convex API.

        Args:
            path: API endpoint path (e.g., /threads)
            method: HTTP method (GET, POST, PATCH, DELETE)
            data: Request body data
            account_id: Optional account ID for multi-tenant requests
            params: Optional query parameters

        Returns:
            Response JSON data

        Raises:
            ConvexError: If the request fails
        """
        url = f"{self.convex_url}/api{path}"
        headers = self._get_headers(account_id)

        try:
            if method == "GET":
                response = await self.client.get(url, headers=headers, params=data or params)
            elif method == "POST":
                response = await self.client.post(url, headers=headers, json=data)
            elif method == "PUT":
                response = await self.client.put(url, headers=headers, json=data)
            elif method == "PATCH":
                response = await self.client.patch(url, headers=headers, json=data)
            elif method == "DELETE":
                response = await self.client.delete(url, headers=headers, params=data)
            else:
                raise ValueError(f"Unsupported HTTP method: {method}")

            # Check for errors
            if response.status_code >= 400:
                error_details = {}
                try:
                    error_details = response.json()
                except Exception:
                    error_details = {"raw": response.text}

                logger.error(f"Convex API error: {response.status_code} - {error_details}")
                raise ConvexError(
                    f"Convex API request failed: {response.status_code}",
                    status_code=response.status_code,
                    details=error_details
                )

            # Handle empty responses
            if response.status_code == 204 or not response.content:
                return {}

            return response.json()

        except httpx.TimeoutException as e:
            logger.error(f"Convex API timeout: {e}")
            raise ConvexError(f"Request timeout: {e}", status_code=408)
        except httpx.RequestError as e:
            logger.error(f"Convex API request error: {e}")
            raise ConvexError(f"Request failed: {e}")

    # ==========================================
    # Thread Operations
    # ==========================================

    async def create_thread(
        self,
        account_id: str,
        project_id: str = None,
        agent_id: str = None,
        is_public: bool = False,
        metadata: dict = None
    ) -> dict:
        """Create a new thread.

        Args:
            account_id: Account ID that owns the thread
            project_id: Optional project ID to associate with
            agent_id: Optional agent ID to associate with
            is_public: Whether the thread is publicly accessible
            metadata: Optional metadata dict

        Returns:
            Created thread data including ID
        """
        data = {
            "accountId": account_id,
            "isPublic": is_public
        }
        if project_id:
            data["projectId"] = project_id
        if agent_id:
            data["agentId"] = agent_id
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Creating thread for account {account_id}")
        return await self.call("/threads", "POST", data, account_id)

    async def get_thread(self, thread_id: str, account_id: str) -> dict:
        """Get a thread by ID.

        Args:
            thread_id: Thread ID to retrieve
            account_id: Account ID that owns the thread

        Returns:
            Thread data
        """
        return await self.call(f"/threads/{thread_id}", "GET", account_id=account_id)

    async def list_threads(
        self,
        account_id: str,
        project_id: str = None,
        limit: int = 50,
        cursor: str = None
    ) -> dict:
        """List threads for an account.

        Args:
            account_id: Account ID to list threads for
            project_id: Optional project ID to filter by
            limit: Maximum number of threads to return
            cursor: Pagination cursor

        Returns:
            Dict with threads list and pagination info
        """
        params = {"limit": limit}
        if project_id:
            params["projectId"] = project_id
        if cursor:
            params["cursor"] = cursor

        return await self.call(f"/threads", "GET", params, account_id)

    async def update_thread(
        self,
        thread_id: str,
        account_id: str,
        updates: dict
    ) -> dict:
        """Update a thread.

        Args:
            thread_id: Thread ID to update
            account_id: Account ID that owns the thread
            updates: Dict of fields to update

        Returns:
            Updated thread data
        """
        return await self.call(f"/threads/{thread_id}", "PATCH", updates, account_id)

    async def delete_thread(self, thread_id: str, account_id: str) -> dict:
        """Delete a thread.

        Args:
            thread_id: Thread ID to delete
            account_id: Account ID that owns the thread

        Returns:
            Deletion confirmation
        """
        return await self.call(f"/threads/{thread_id}", "DELETE", account_id=account_id)

    # ==========================================
    # Message Operations
    # ==========================================

    async def add_message(
        self,
        thread_id: str,
        message_type: str,
        content: Any,
        account_id: str,
        metadata: dict = None,
        is_llm_message: bool = True
    ) -> dict:
        """Add a message to a thread.

        Args:
            thread_id: Thread ID to add message to
            message_type: Type of message (user, assistant, system, tool)
            content: Message content (string or structured data)
            account_id: Account ID that owns the thread
            metadata: Optional metadata dict
            is_llm_message: Whether this is an LLM-formatted message

        Returns:
            Created message data
        """
        data = {
            "threadId": thread_id,
            "type": message_type,
            "content": content,
            "isLlmMessage": is_llm_message
        }
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Adding {message_type} message to thread {thread_id}")
        return await self.call(f"/threads/{thread_id}/messages", "POST", data, account_id)

    async def get_messages(
        self,
        thread_id: str,
        account_id: str,
        limit: int = 100,
        before: str = None,
        after: str = None
    ) -> list:
        """Get messages for a thread.

        Args:
            thread_id: Thread ID to get messages for
            account_id: Account ID that owns the thread
            limit: Maximum number of messages to return
            before: Get messages before this message ID
            after: Get messages after this message ID

        Returns:
            List of messages
        """
        params = {"limit": limit}
        if before:
            params["before"] = before
        if after:
            params["after"] = after

        return await self.call(f"/threads/{thread_id}/messages", "GET", params, account_id)

    # ==========================================
    # Agent Run Operations
    # ==========================================

    async def create_agent_run(
        self,
        thread_id: str,
        account_id: str,
        agent_id: str = None,
        model: str = None,
        metadata: dict = None
    ) -> dict:
        """Create a new agent run.

        Args:
            thread_id: Thread ID to run agent on
            account_id: Account ID that owns the thread
            agent_id: Optional agent ID to run
            model: Optional model override
            metadata: Optional metadata dict

        Returns:
            Created agent run data including ID
        """
        data = {"threadId": thread_id}
        if agent_id:
            data["agentId"] = agent_id
        if model:
            data["model"] = model
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Creating agent run for thread {thread_id}")
        return await self.call("/agent-runs", "POST", data, account_id)

    async def get_agent_run(self, run_id: str, account_id: str) -> dict:
        """Get an agent run by ID.

        Args:
            run_id: Agent run ID
            account_id: Account ID that owns the run

        Returns:
            Agent run data
        """
        return await self.call(f"/agent-runs/{run_id}", "GET", account_id=account_id)

    async def update_agent_run(
        self,
        run_id: str,
        account_id: str,
        status: str = None,
        error: str = None,
        metadata: dict = None
    ) -> dict:
        """Update an agent run.

        Args:
            run_id: Agent run ID to update
            account_id: Account ID that owns the run
            status: New status (queued, running, completed, failed)
            error: Optional error message
            metadata: Optional metadata updates

        Returns:
            Updated agent run data
        """
        data = {"runId": run_id}
        if status:
            data["status"] = status
        if error:
            data["error"] = error
        if metadata:
            data["metadata"] = metadata

        return await self.call(f"/agent-runs/{run_id}", "PATCH", data, account_id)

    async def list_agent_runs(
        self,
        account_id: str,
        thread_id: str = None,
        status: str = None,
        limit: int = 50
    ) -> list:
        """List agent runs for an account.

        Args:
            account_id: Account ID to list runs for
            thread_id: Optional thread ID to filter by
            status: Optional status to filter by
            limit: Maximum number of runs to return

        Returns:
            List of agent runs
        """
        params = {"limit": limit}
        if thread_id:
            params["threadId"] = thread_id
        if status:
            params["status"] = status

        return await self.call("/agent-runs", "GET", params, account_id)

    # ==========================================
    # Memory Operations
    # ==========================================

    async def store_memory(
        self,
        memory_space_id: str,
        content: str,
        source_type: str,
        user_id: str = None,
        account_id: str = None,
        metadata: dict = None
    ) -> dict:
        """Store a memory.

        Args:
            memory_space_id: Memory space ID to store in
            content: Memory content text
            source_type: Type of source (conversation, document, etc.)
            user_id: Optional user ID associated with memory
            account_id: Optional account ID
            metadata: Optional metadata dict

        Returns:
            Created memory data
        """
        data = {
            "memorySpaceId": memory_space_id,
            "content": content,
            "sourceType": source_type
        }
        if user_id:
            data["userId"] = user_id
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Storing memory in space {memory_space_id}")
        return await self.call("/memories", "POST", data, account_id)

    async def search_memories(
        self,
        memory_space_id: str,
        query: str,
        account_id: str = None,
        limit: int = 10,
        threshold: float = 0.5
    ) -> list:
        """Search memories by semantic similarity.

        Args:
            memory_space_id: Memory space ID to search in
            query: Search query text
            account_id: Optional account ID
            limit: Maximum number of results
            threshold: Minimum similarity threshold (0-1)

        Returns:
            List of matching memories with similarity scores
        """
        data = {
            "memorySpaceId": memory_space_id,
            "query": query,
            "limit": limit,
            "threshold": threshold
        }

        return await self.call("/memories/search", "POST", data, account_id)

    async def get_memories(
        self,
        memory_space_id: str,
        account_id: str = None,
        limit: int = 50,
        cursor: str = None
    ) -> list:
        """Get memories for a memory space.

        Args:
            memory_space_id: Memory space ID to get memories for
            account_id: Optional account ID
            limit: Maximum number of memories to return
            cursor: Pagination cursor

        Returns:
            List of memories
        """
        params = {"memorySpaceId": memory_space_id, "limit": limit}
        if cursor:
            params["cursor"] = cursor

        return await self.call("/memories", "GET", params, account_id)

    async def delete_memory(
        self,
        memory_id: str,
        account_id: str = None
    ) -> dict:
        """Delete a memory.

        Args:
            memory_id: Memory ID to delete
            account_id: Optional account ID

        Returns:
            Deletion confirmation
        """
        return await self.call(f"/memories/{memory_id}", "DELETE", account_id=account_id)

    # ==========================================
    # Agent Operations
    # ==========================================

    async def get_agent(self, agent_id: str, account_id: str) -> dict:
        """Get an agent by ID.

        Args:
            agent_id: Agent ID to retrieve
            account_id: Account ID that owns the agent

        Returns:
            Agent configuration data
        """
        return await self.call(f"/agents/{agent_id}", "GET", account_id=account_id)

    async def list_agents(
        self,
        account_id: str,
        include_shared: bool = True,
        limit: int = 100
    ) -> list:
        """List agents for an account.

        Args:
            account_id: Account ID to list agents for
            include_shared: Whether to include shared agents
            limit: Maximum number of agents to return

        Returns:
            List of agents
        """
        params = {"limit": limit, "includeShared": include_shared}
        return await self.call(f"/agents", "GET", params, account_id)

    async def create_agent(
        self,
        account_id: str,
        name: str,
        description: str = None,
        system_prompt: str = None,
        model: str = None,
        tools: list = None,
        metadata: dict = None
    ) -> dict:
        """Create a new agent.

        Args:
            account_id: Account ID that will own the agent
            name: Agent name
            description: Optional agent description
            system_prompt: Optional system prompt
            model: Optional model override
            tools: Optional list of tool configurations
            metadata: Optional metadata dict

        Returns:
            Created agent data including ID
        """
        data = {"name": name}
        if description:
            data["description"] = description
        if system_prompt:
            data["systemPrompt"] = system_prompt
        if model:
            data["model"] = model
        if tools:
            data["tools"] = tools
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Creating agent '{name}' for account {account_id}")
        return await self.call("/agents", "POST", data, account_id)

    async def update_agent(
        self,
        agent_id: str,
        account_id: str,
        updates: dict
    ) -> dict:
        """Update an agent.

        Args:
            agent_id: Agent ID to update
            account_id: Account ID that owns the agent
            updates: Dict of fields to update

        Returns:
            Updated agent data
        """
        return await self.call(f"/agents/{agent_id}", "PATCH", updates, account_id)

    async def delete_agent(self, agent_id: str, account_id: str) -> dict:
        """Delete an agent.

        Args:
            agent_id: Agent ID to delete
            account_id: Account ID that owns the agent

        Returns:
            Deletion confirmation
        """
        return await self.call(f"/agents/{agent_id}", "DELETE", account_id=account_id)

    # ==========================================
    # Project Operations
    # ==========================================

    async def get_project(self, project_id: str, account_id: str) -> dict:
        """Get a project by ID.

        Args:
            project_id: Project ID to retrieve
            account_id: Account ID that owns the project

        Returns:
            Project data
        """
        return await self.call(f"/projects/{project_id}", "GET", account_id=account_id)

    async def list_projects(
        self,
        account_id: str,
        limit: int = 50
    ) -> list:
        """List projects for an account.

        Args:
            account_id: Account ID to list projects for
            limit: Maximum number of projects to return

        Returns:
            List of projects
        """
        params = {"limit": limit}
        return await self.call("/projects", "GET", params, account_id)

    async def create_project(
        self,
        account_id: str,
        name: str,
        description: str = None,
        metadata: dict = None
    ) -> dict:
        """Create a new project.

        Args:
            account_id: Account ID that will own the project
            name: Project name
            description: Optional project description
            metadata: Optional metadata dict

        Returns:
            Created project data including ID
        """
        data = {"name": name}
        if description:
            data["description"] = description
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Creating project '{name}' for account {account_id}")
        return await self.call("/projects", "POST", data, account_id)

    # ==========================================
    # Account Operations
    # ==========================================

    async def get_account(self, account_id: str) -> dict:
        """Get an account by ID.

        Args:
            account_id: Account ID to retrieve

        Returns:
            Account data
        """
        return await self.call(f"/accounts/{account_id}", "GET")

    async def get_account_usage(self, account_id: str) -> dict:
        """Get usage statistics for an account.

        Args:
            account_id: Account ID to get usage for

        Returns:
            Usage statistics data
        """
        return await self.call(f"/accounts/{account_id}/usage", "GET")

    # ==========================================
    # File Operations
    # ==========================================

    async def upload_file(
        self,
        account_id: str,
        file_name: str,
        file_content: bytes,
        content_type: str = None,
        metadata: dict = None
    ) -> dict:
        """Upload a file.

        Args:
            account_id: Account ID that owns the file
            file_name: Name of the file
            file_content: File content as bytes
            content_type: Optional MIME type
            metadata: Optional metadata dict

        Returns:
            File upload data including URL
        """
        # For file uploads, we need to use multipart/form-data
        url = f"{self.convex_url}/api/files"
        headers = self._get_headers(account_id)
        headers.pop("Content-Type", None)  # Let httpx set it for multipart

        files = {
            "file": (file_name, file_content, content_type or "application/octet-stream")
        }
        data = {}
        if metadata:
            data["metadata"] = json.dumps(metadata)

        response = await self.client.post(url, headers=headers, files=files, data=data)

        if response.status_code >= 400:
            error_details = {}
            try:
                error_details = response.json()
            except Exception:
                error_details = {"raw": response.text}

            raise ConvexError(
                f"File upload failed: {response.status_code}",
                status_code=response.status_code,
                details=error_details
            )

        return response.json()

    async def get_file_url(self, file_id: str, account_id: str) -> str:
        """Get a signed URL for a file.

        Args:
            file_id: File ID to get URL for
            account_id: Account ID that owns the file

        Returns:
            Signed URL for the file
        """
        result = await self.call(f"/files/{file_id}/url", "GET", account_id=account_id)
        return result.get("url")


# ==========================================
# Singleton Instance Management
# ==========================================

_convex_client: Optional[ConvexClient] = None


def get_convex_client() -> ConvexClient:
    """Get or create the singleton Convex client instance.

    Returns:
        ConvexClient instance

    Raises:
        ValueError: If CONVEX_URL or CONVEX_API_KEY are not set
    """
    global _convex_client
    if _convex_client is None:
        convex_url = os.getenv("CONVEX_URL")
        convex_api_key = os.getenv("CONVEX_API_KEY")

        if not convex_url or not convex_api_key:
            raise ValueError(
                "CONVEX_URL and CONVEX_API_KEY must be set to use Convex backend. "
                "Set these environment variables or disable Convex integration."
            )

        _convex_client = ConvexClient(convex_url, convex_api_key)
        logger.info("Convex client singleton created")

    return _convex_client


def reset_convex_client():
    """Reset the singleton Convex client instance.

    This is useful for testing or when configuration changes.
    """
    global _convex_client
    if _convex_client is not None:
        # Note: In async context, should await _convex_client.close()
        _convex_client = None
        logger.info("Convex client singleton reset")


async def get_convex_client_async() -> ConvexClient:
    """Get the Convex client instance (async version for proper cleanup).

    Returns:
        ConvexClient instance
    """
    return get_convex_client()
