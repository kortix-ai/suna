"""
Convex HTTP client for backend integration.

This module provides an HTTP client for communicating with the Convex backend,
replacing Supabase for the data layer while maintaining compatibility with
the existing FastAPI backend architecture.

API Routes (matching Convex http.ts):
- POST /api/threads - Create thread
- GET /api/threads - List threads (accountId, limit, offset)
- GET /api/threads/get?id=... - Get thread
- PATCH /api/threads/delete - Delete thread
- POST /api/threads/messages/add - Add message
- GET /api/threads/messages?threadId=... - Get messages
- POST /api/agent-runs - Create agent run
- GET /api/agent-runs/get?id=... - Get agent run
- PATCH /api/agent-runs/update - Update agent run (runId in body)
- POST /api/memories - Store memory
- POST /api/memories/search - Search memories
- GET /api/memories/list?memorySpaceId=... - List memories
- POST /api/facts - Store fact
- GET /api/facts/list?memorySpaceId=... - List facts
- POST /api/agents - Create agent
- GET /api/agents/list?accountId=... - List agents
- PATCH /api/agents/update - Update agent
- POST /api/triggers - Create trigger
- GET /api/triggers/list?agentId=... - List triggers
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


class NotFoundError(ConvexError):
    """Resource not found error."""
    pass


class ValidationError(ConvexError):
    """Validation error from Convex API."""
    pass


class AuthError(ConvexError):
    """Authentication error."""
    pass


class ConvexClient:
    """HTTP client for Convex backend integration.

    This client handles all communication with the Convex deployment,
    including authentication, thread management, agent runs, and memory operations.

    Attributes:
        convex_url: The base URL of the Convex deployment (e.g., https://xxx.convex.site)
        api_key: API key for authentication
        client: Async HTTP client instance
    """

    def __init__(self, convex_url: str, api_key: str):
        """Initialize the Convex client.

        Args:
            convex_url: The base URL of the Convex deployment (e.g., https://xxx.convex.site)
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

    async def _request(
        self,
        path: str,
        method: str = "GET",
        data: dict = None,
        account_id: str = None,
        params: dict = None
    ) -> dict:
        """Make an HTTP request to the Convex API.

        Args:
            path: API endpoint path (e.g., /api/threads)
            method: HTTP method (GET, POST, PATCH, DELETE)
            data: Request body data (for POST/PATCH)
            account_id: Optional account ID for multi-tenant requests
            params: Query parameters (for GET)

        Returns:
            Response JSON data

        Raises:
            ConvexError: If the request fails
        """
        url = f"{self.convex_url}{path}"
        headers = self._get_headers(account_id)

        try:
            if method == "GET":
                response = await self.client.get(url, headers=headers, params=params)
            elif method == "POST":
                response = await self.client.post(url, headers=headers, json=data)
            elif method == "PUT":
                response = await self.client.put(url, headers=headers, json=data)
            elif method == "PATCH":
                response = await self.client.patch(url, headers=headers, json=data)
            elif method == "DELETE":
                response = await self.client.delete(url, headers=headers, params=params)
            else:
                raise ValueError(f"Unsupported HTTP method: {method}")

            # Check for errors
            if response.status_code >= 400:
                error_details = {}
                try:
                    error_details = response.json()
                except Exception:
                    error_details = {"raw": response.text}

                error_code = error_details.get("error", "UNKNOWN")
                error_message = error_details.get("message", str(error_details))

                logger.error(f"Convex API error: {response.status_code} - {error_code}: {error_message}")

                if response.status_code == 401:
                    raise AuthError(f"Authentication failed: {error_message}", status_code=401, details=error_details)
                if response.status_code == 404 or error_code == "NOT_FOUND":
                    raise NotFoundError(f"Resource not found: {error_message}", status_code=404, details=error_details)
                if error_code in ("MISSING_FIELD", "INVALID_BODY", "MISSING_ID"):
                    raise ValidationError(f"Validation error: {error_message}", status_code=response.status_code, details=error_details)

                raise ConvexError(
                    f"Convex API request failed: {error_code} - {error_message}",
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
    # Generic RPC Method
    # ==========================================

    async def rpc(
        self,
        function_name: str,
        params: dict = None,
        account_id: str = None
    ) -> dict:
        """Call a Convex function via HTTP endpoint.

        This is a generic method for calling any Convex HTTP endpoint,
        similar to Supabase's rpc() method.

        Args:
            function_name: Name of the Convex function/endpoint (e.g., 'get_analytics_summary')
            params: Parameters to pass to the function
            account_id: Optional account ID for multi-tenant requests

        Returns:
            Response data from the Convex function

        Raises:
            ConvexError: If the request fails
        """
        # Convex HTTP endpoints are typically at /api/{function_name}
        # For analytics/admin functions, they may be at /api/admin/{function_name}
        path = f"/api/{function_name}"
        return await self._request(path, "POST", data=params or {}, account_id=account_id)

    async def admin_rpc(
        self,
        function_name: str,
        params: dict = None,
        account_id: str = None
    ) -> dict:
        """Call a Convex admin function via HTTP endpoint.

        Admin functions require elevated privileges and are prefixed with /api/admin/.

        Args:
            function_name: Name of the admin function (e.g., 'get_retention_data')
            params: Parameters to pass to the function
            account_id: Optional account ID

        Returns:
            Response data from the Convex function

        Raises:
            ConvexError: If the request fails
        """
        path = f"/api/admin/{function_name}"
        return await self._request(path, "POST", data=params or {}, account_id=account_id)

    async def query(
        self,
        function_name: str,
        params: dict = None,
        account_id: str = None
    ) -> dict:
        """Call a Convex query function via HTTP endpoint.

        Query functions are read-only operations in Convex.

        Args:
            function_name: Name of the query function (e.g., 'projects:getProjectAccount')
                          Can include namespace prefix like 'internal:functionName'
            params: Parameters to pass to the function
            account_id: Optional account ID

        Returns:
            Response data from the Convex function

        Raises:
            ConvexError: If the request fails
        """
        # Handle internal: prefix for internal functions
        if function_name.startswith("internal:"):
            path = f"/api/internal/{function_name[9:]}"
        else:
            path = f"/api/query/{function_name}"
        return await self._request(path, "POST", data=params or {}, account_id=account_id)

    async def mutation(
        self,
        function_name: str,
        params: dict = None,
        account_id: str = None
    ) -> dict:
        """Call a Convex mutation function via HTTP endpoint.

        Mutation functions modify data in Convex.

        Args:
            function_name: Name of the mutation function
            params: Parameters to pass to the function
            account_id: Optional account ID

        Returns:
            Response data from the Convex function

        Raises:
            ConvexError: If the request fails
        """
        path = f"/api/mutation/{function_name}"
        return await self._request(path, "POST", data=params or {}, account_id=account_id)

    # ==========================================
    # Thread Operations
    # ==========================================

    async def create_thread(
        self,
        thread_id: str,
        account_id: str,
        project_id: str = None,
        agent_id: str = None,
        is_public: bool = False,
        metadata: dict = None
    ) -> dict:
        """Create a new thread.

        Args:
            thread_id: Unique thread identifier
            account_id: Account ID that owns the thread
            project_id: Optional project ID to associate with
            agent_id: Optional agent ID to associate with
            is_public: Whether the thread is publicly accessible
            metadata: Optional metadata dict

        Returns:
            Created thread data including ID
        """
        data = {
            "threadId": thread_id,
            "accountId": account_id,
            "isPublic": is_public
        }
        if project_id:
            data["projectId"] = project_id
        if agent_id:
            data["agentId"] = agent_id
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Creating thread {thread_id} for account {account_id}")
        return await self._request("/api/threads", "POST", data, account_id)

    async def get_thread(self, thread_id: str, account_id: str = None) -> dict:
        """Get a thread by ID.

        Args:
            thread_id: Thread ID to retrieve
            account_id: Optional account ID

        Returns:
            Thread data
        """
        params = {"id": thread_id}
        return await self._request("/api/threads/get", "GET", params=params, account_id=account_id)

    async def list_threads(
        self,
        account_id: str,
        project_id: str = None,
        limit: int = 100,
        offset: int = 0
    ) -> list:
        """List threads for an account.

        Args:
            account_id: Account ID to list threads for
            project_id: Optional project ID to filter by
            limit: Maximum number of threads to return
            offset: Pagination offset

        Returns:
            List of threads
        """
        params = {"accountId": account_id, "limit": limit, "offset": offset}
        if project_id:
            params["projectId"] = project_id

        return await self._request("/api/threads", "GET", params=params, account_id=account_id)

    async def update_thread(
        self,
        thread_id: str,
        account_id: str = None,
        project_id: str = None,
        agent_id: str = None,
        is_public: bool = None,
        metadata: dict = None
    ) -> dict:
        """Update a thread.

        Args:
            thread_id: Thread ID to update
            account_id: Optional account ID
            project_id: Optional new project ID
            agent_id: Optional new agent ID
            is_public: Optional new public status
            metadata: Optional metadata updates

        Returns:
            Updated thread data
        """
        data = {}
        if project_id is not None:
            data["projectId"] = project_id
        if agent_id is not None:
            data["agentId"] = agent_id
        if is_public is not None:
            data["isPublic"] = is_public
        if metadata is not None:
            data["metadata"] = metadata

        # The Convex API expects thread_id in the path, but we need to handle this
        # The current http.ts uses extractIdFromPath which expects /api/threads/:id
        # But the route is registered as /api/threads/update
        # For now, we'll pass the ID in the body
        data["threadId"] = thread_id

        return await self._request("/api/threads/update", "PATCH", data, account_id)

    async def delete_thread(self, thread_id: str, account_id: str = None) -> dict:
        """Delete a thread.

        Args:
            thread_id: Thread ID to delete
            account_id: Optional account ID

        Returns:
            Deletion confirmation
        """
        # Pass thread_id in body for now since the route uses path extraction
        data = {"threadId": thread_id}
        return await self._request("/api/threads/delete", "DELETE", data, account_id)

    # ==========================================
    # Message Operations
    # ==========================================

    async def add_message(
        self,
        message_id: str,
        thread_id: str,
        message_type: str,
        content: Any,
        is_llm_message: bool = True,
        agent_id: str = None,
        metadata: dict = None,
        account_id: str = None
    ) -> dict:
        """Add a message to a thread.

        Args:
            message_id: Unique message identifier
            thread_id: Thread ID to add message to
            message_type: Type of message (user, assistant, system, tool)
            content: Message content (string or structured data)
            is_llm_message: Whether this is an LLM-formatted message
            agent_id: Optional agent ID that created the message
            metadata: Optional metadata dict
            account_id: Optional account ID

        Returns:
            Created message data
        """
        data = {
            "messageId": message_id,
            "threadId": thread_id,
            "type": message_type,
            "content": content,
            "isLlmMessage": is_llm_message
        }
        if agent_id:
            data["agentId"] = agent_id
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Adding {message_type} message {message_id} to thread {thread_id}")
        return await self._request("/api/threads/messages/add", "POST", data, account_id)

    async def get_messages(
        self,
        thread_id: str,
        account_id: str = None,
        limit: int = 100,
        offset: int = 0
    ) -> list:
        """Get messages for a thread.

        Args:
            thread_id: Thread ID to get messages for
            account_id: Optional account ID
            limit: Maximum number of messages to return
            offset: Pagination offset

        Returns:
            List of messages
        """
        params = {"threadId": thread_id, "limit": limit, "offset": offset}
        return await self._request("/api/threads/messages", "GET", params=params, account_id=account_id)

    # ==========================================
    # Agent Run Operations
    # ==========================================

    async def create_agent_run(
        self,
        run_id: str,
        thread_id: str,
        account_id: str = None,
        status: str = "queued",
        metadata: dict = None
    ) -> dict:
        """Create a new agent run.

        Args:
            run_id: Unique run identifier
            thread_id: Thread ID to run agent on
            account_id: Optional account ID
            status: Initial status (default: queued)
            metadata: Optional metadata dict

        Returns:
            Created agent run data including ID
        """
        data = {
            "runId": run_id,
            "threadId": thread_id,
            "status": status
        }
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Creating agent run {run_id} for thread {thread_id}")
        return await self._request("/api/agent-runs", "POST", data, account_id)

    async def get_agent_run(self, run_id: str, account_id: str = None) -> dict:
        """Get an agent run by ID.

        Args:
            run_id: Agent run ID
            account_id: Optional account ID

        Returns:
            Agent run data
        """
        params = {"id": run_id}
        return await self._request("/api/agent-runs/get", "GET", params=params, account_id=account_id)

    async def update_agent_run(
        self,
        run_id: str,
        account_id: str = None,
        status: str = None,
        error: str = None,
        completed_at: str = None,
        metadata: dict = None
    ) -> dict:
        """Update an agent run.

        Args:
            run_id: Agent run ID to update
            account_id: Optional account ID
            status: New status (queued, running, completed, failed)
            error: Optional error message
            completed_at: Optional completion timestamp
            metadata: Optional metadata updates

        Returns:
            Updated agent run data
        """
        data = {"runId": run_id}
        if status is not None:
            data["status"] = status
        if error is not None:
            data["error"] = error
        if completed_at is not None:
            data["completedAt"] = completed_at
        if metadata is not None:
            data["metadata"] = metadata

        return await self._request("/api/agent-runs/update", "PATCH", data, account_id)

    async def count_active_runs(self, account_id: str = None) -> int:
        """Count active agent runs (queued + running).

        Args:
            account_id: Optional account ID

        Returns:
            Number of active runs
        """
        result = await self._request("/api/agent-runs/count", "GET", account_id=account_id)
        return result.get("count", 0) if isinstance(result, dict) else 0

    # ==========================================
    # Memory Operations (Cortex Memory SDK)
    # ==========================================

    async def store_memory(
        self,
        memory_space_id: str,
        content: str,
        memory_id: str = None,
        participant_id: str = None,
        content_type: str = "raw",
        embedding: list = None,
        source_type: str = "system",
        source_user_id: str = None,
        source_user_name: str = None,
        user_id: str = None,
        agent_id: str = None,
        message_role: str = None,
        enriched_content: str = None,
        fact_category: str = None,
        conversation_ref: dict = None,
        importance: int = 50,
        tags: list = None,
        metadata: dict = None,
        account_id: str = None
    ) -> dict:
        """Store a memory.

        Args:
            memory_space_id: Memory space ID to store in
            content: Memory content text
            memory_id: Optional unique memory ID (auto-generated if not provided)
            participant_id: Optional participant ID
            content_type: Type of content (raw, text, etc.)
            embedding: Optional pre-computed embedding vector
            source_type: Type of source (conversation, document, etc.)
            source_user_id: Optional source user ID
            source_user_name: Optional source user name
            user_id: Optional user ID associated with memory
            agent_id: Optional agent ID
            message_role: Optional message role
            enriched_content: Optional enriched/processed content
            fact_category: Optional fact category
            conversation_ref: Optional conversation reference
            importance: Importance score (0-100)
            tags: Optional list of tags
            metadata: Optional metadata dict
            account_id: Optional account ID

        Returns:
            Created memory data
        """
        data = {
            "memorySpaceId": memory_space_id,
            "content": content,
            "contentType": content_type,
            "sourceType": source_type,
            "importance": importance
        }
        if memory_id:
            data["memoryId"] = memory_id
        if participant_id:
            data["participantId"] = participant_id
        if embedding:
            data["embedding"] = embedding
        if source_user_id:
            data["sourceUserId"] = source_user_id
        if source_user_name:
            data["sourceUserName"] = source_user_name
        if user_id:
            data["userId"] = user_id
        if agent_id:
            data["agentId"] = agent_id
        if message_role:
            data["messageRole"] = message_role
        if enriched_content:
            data["enrichedContent"] = enriched_content
        if fact_category:
            data["factCategory"] = fact_category
        if conversation_ref:
            data["conversationRef"] = conversation_ref
        if tags:
            data["tags"] = tags
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Storing memory in space {memory_space_id}")
        return await self._request("/api/memories", "POST", data, account_id)

    async def search_memories(
        self,
        memory_space_id: str,
        query: str,
        account_id: str = None,
        embedding: list = None,
        limit: int = 10
    ) -> list:
        """Search memories by semantic similarity.

        Args:
            memory_space_id: Memory space ID to search in
            query: Search query text
            account_id: Optional account ID
            embedding: Optional pre-computed query embedding
            limit: Maximum number of results

        Returns:
            List of matching memories with similarity scores
        """
        data = {
            "memorySpaceId": memory_space_id,
            "query": query,
            "limit": limit
        }
        if embedding:
            data["embedding"] = embedding

        return await self._request("/api/memories/search", "POST", data, account_id)

    async def list_memories(
        self,
        memory_space_id: str,
        account_id: str = None,
        limit: int = 100
    ) -> list:
        """Get memories for a memory space.

        Args:
            memory_space_id: Memory space ID to get memories for
            account_id: Optional account ID
            limit: Maximum number of memories to return

        Returns:
            List of memories
        """
        params = {"memorySpaceId": memory_space_id, "limit": limit}
        return await self._request("/api/memories/list", "GET", params=params, account_id=account_id)

    # Alias for backward compatibility
    async def get_memories(self, *args, **kwargs):
        """Alias for list_memories."""
        return await self.list_memories(*args, **kwargs)

    # ==========================================
    # Fact Operations (Cortex Memory SDK)
    # ==========================================

    async def store_fact(
        self,
        memory_space_id: str,
        fact: str,
        fact_id: str = None,
        participant_id: str = None,
        user_id: str = None,
        fact_type: str = "knowledge",
        subject: str = None,
        predicate: str = None,
        object: str = None,
        confidence: int = 80,
        source_type: str = "system",
        tags: list = None,
        category: str = None,
        metadata: dict = None,
        account_id: str = None
    ) -> dict:
        """Store a fact.

        Args:
            memory_space_id: Memory space ID to store in
            fact: Fact content text
            fact_id: Optional unique fact ID (auto-generated if not provided)
            participant_id: Optional participant ID
            user_id: Optional user ID
            fact_type: Type of fact (knowledge, preference, etc.)
            subject: Optional subject for structured fact
            predicate: Optional predicate for structured fact
            object: Optional object for structured fact
            confidence: Confidence score (0-100)
            source_type: Type of source
            tags: Optional list of tags
            category: Optional category
            metadata: Optional metadata dict
            account_id: Optional account ID

        Returns:
            Created fact data
        """
        data = {
            "memorySpaceId": memory_space_id,
            "fact": fact,
            "factType": fact_type,
            "confidence": confidence,
            "sourceType": source_type
        }
        if fact_id:
            data["factId"] = fact_id
        if participant_id:
            data["participantId"] = participant_id
        if user_id:
            data["userId"] = user_id
        if subject:
            data["subject"] = subject
        if predicate:
            data["predicate"] = predicate
        if object:
            data["object"] = object
        if tags:
            data["tags"] = tags
        if category:
            data["category"] = category
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Storing fact in space {memory_space_id}")
        return await self._request("/api/facts", "POST", data, account_id)

    async def list_facts(
        self,
        memory_space_id: str,
        account_id: str = None,
        limit: int = 100
    ) -> list:
        """Get facts for a memory space.

        Args:
            memory_space_id: Memory space ID to get facts for
            account_id: Optional account ID
            limit: Maximum number of facts to return

        Returns:
            List of facts
        """
        params = {"memorySpaceId": memory_space_id, "limit": limit}
        return await self._request("/api/facts/list", "GET", params=params, account_id=account_id)

    # ==========================================
    # Agent Operations
    # ==========================================

    async def create_agent(
        self,
        agent_id: str,
        account_id: str,
        name: str,
        description: str = None,
        system_prompt: str = None,
        configured_mcps: list = None,
        custom_mcps: list = None,
        agentpress_tools: list = None,
        is_default: bool = False,
        avatar: str = None,
        avatar_color: str = None,
        icon_name: str = None,
        metadata: dict = None,
        tags: list = None
    ) -> dict:
        """Create a new agent.

        Args:
            agent_id: Unique agent identifier
            account_id: Account ID that will own the agent
            name: Agent name
            description: Optional agent description
            system_prompt: Optional system prompt
            configured_mcps: Optional list of configured MCPs
            custom_mcps: Optional list of custom MCPs
            agentpress_tools: Optional list of agentpress tools
            is_default: Whether this is the default agent
            avatar: Optional avatar
            avatar_color: Optional avatar color
            icon_name: Optional icon name
            metadata: Optional metadata dict
            tags: Optional list of tags

        Returns:
            Created agent data including ID
        """
        data = {
            "agentId": agent_id,
            "accountId": account_id,
            "name": name,
            "isDefault": is_default
        }
        if description:
            data["description"] = description
        if system_prompt:
            data["systemPrompt"] = system_prompt
        if configured_mcps:
            data["configuredMcps"] = configured_mcps
        if custom_mcps:
            data["customMcps"] = custom_mcps
        if agentpress_tools:
            data["agentpressTools"] = agentpress_tools
        if avatar:
            data["avatar"] = avatar
        if avatar_color:
            data["avatarColor"] = avatar_color
        if icon_name:
            data["iconName"] = icon_name
        if metadata:
            data["metadata"] = metadata
        if tags:
            data["tags"] = tags

        logger.debug(f"Creating agent '{name}' ({agent_id}) for account {account_id}")
        return await self._request("/api/agents", "POST", data, account_id)

    async def list_agents(
        self,
        account_id: str,
        limit: int = 100
    ) -> list:
        """List agents for an account.

        Args:
            account_id: Account ID to list agents for
            limit: Maximum number of agents to return

        Returns:
            List of agents
        """
        # The Convex API expects accountId as a query param for /api/agents/list
        # But the route handler uses extractIdFromPath(url.pathname, "agents")
        # which doesn't work with /api/agents/list?accountId=xxx
        # We need to check the actual implementation...

        # Based on http.ts, the route is /api/agents/list and handler uses path extraction
        # This is broken - the handler expects the account ID in the path but the route
        # is registered as /api/agents/list
        # For now, we'll pass it as a query param and see if it works
        params = {"accountId": account_id, "limit": limit}
        return await self._request("/api/agents/list", "GET", params=params, account_id=account_id)

    async def update_agent(
        self,
        agent_id: str,
        account_id: str = None,
        name: str = None,
        description: str = None,
        system_prompt: str = None,
        configured_mcps: list = None,
        custom_mcps: list = None,
        agentpress_tools: list = None,
        is_default: bool = None,
        avatar: str = None,
        avatar_color: str = None,
        icon_name: str = None,
        metadata: dict = None,
        tags: list = None
    ) -> dict:
        """Update an agent.

        Args:
            agent_id: Agent ID to update
            account_id: Optional account ID
            name: Optional new name
            description: Optional new description
            system_prompt: Optional new system prompt
            configured_mcps: Optional new configured MCPs
            custom_mcps: Optional new custom MCPs
            agentpress_tools: Optional new agentpress tools
            is_default: Optional new default status
            avatar: Optional new avatar
            avatar_color: Optional new avatar color
            icon_name: Optional new icon name
            metadata: Optional new metadata
            tags: Optional new tags

        Returns:
            Updated agent data
        """
        data = {"agentId": agent_id}
        if name is not None:
            data["name"] = name
        if description is not None:
            data["description"] = description
        if system_prompt is not None:
            data["systemPrompt"] = system_prompt
        if configured_mcps is not None:
            data["configuredMcps"] = configured_mcps
        if custom_mcps is not None:
            data["customMcps"] = custom_mcps
        if agentpress_tools is not None:
            data["agentpressTools"] = agentpress_tools
        if is_default is not None:
            data["isDefault"] = is_default
        if avatar is not None:
            data["avatar"] = avatar
        if avatar_color is not None:
            data["avatarColor"] = avatar_color
        if icon_name is not None:
            data["iconName"] = icon_name
        if metadata is not None:
            data["metadata"] = metadata
        if tags is not None:
            data["tags"] = tags

        return await self._request("/api/agents/update", "PATCH", data, account_id)

    async def delete_agent(
        self,
        agent_id: str,
        account_id: str = None
    ) -> dict:
        """Delete an agent.

        Args:
            agent_id: Agent ID to delete
            account_id: Optional account ID

        Returns:
            Deletion confirmation with success status
        """
        data = {"agentId": agent_id}
        return await self._request("/api/agents/delete", "DELETE", data, account_id)

    async def clear_default_agents(
        self,
        account_id: str
    ) -> dict:
        """Clear is_default flag for all agents in an account.

        Args:
            account_id: Account ID to clear defaults for

        Returns:
            Confirmation with count of agents updated
        """
        data = {"accountId": account_id}
        return await self._request("/api/agents/clear-default", "POST", data, account_id)

    # ==========================================
    # Trigger Operations
    # ==========================================

    async def create_trigger(
        self,
        trigger_id: str,
        agent_id: str,
        trigger_type: str,
        name: str,
        description: str = None,
        is_active: bool = True,
        config: dict = None,
        account_id: str = None
    ) -> dict:
        """Create a new trigger.

        Args:
            trigger_id: Unique trigger identifier
            agent_id: Agent ID to associate with
            trigger_type: Type of trigger (manual, schedule, webhook, etc.)
            name: Trigger name
            description: Optional trigger description
            is_active: Whether trigger is active
            config: Optional trigger configuration
            account_id: Optional account ID

        Returns:
            Created trigger data
        """
        data = {
            "triggerId": trigger_id,
            "agentId": agent_id,
            "triggerType": trigger_type,
            "name": name,
            "isActive": is_active
        }
        if description:
            data["description"] = description
        if config:
            data["config"] = config

        logger.debug(f"Creating trigger '{name}' ({trigger_id}) for agent {agent_id}")
        return await self._request("/api/triggers", "POST", data, account_id)

    async def list_triggers(
        self,
        agent_id: str,
        account_id: str = None,
        limit: int = 100
    ) -> list:
        """List triggers for an agent.

        Args:
            agent_id: Agent ID to list triggers for
            account_id: Optional account ID
            limit: Maximum number of triggers to return

        Returns:
            List of triggers
        """
        # Same issue as agents/list - handler uses path extraction
        params = {"agentId": agent_id, "limit": limit}
        return await self._request("/api/triggers/list", "GET", params=params, account_id=account_id)

    async def get_trigger(
        self,
        trigger_id: str,
        account_id: str = None
    ) -> dict:
        """Get a trigger by ID.

        Args:
            trigger_id: Trigger ID to retrieve
            account_id: Optional account ID

        Returns:
            Trigger data
        """
        params = {"id": trigger_id}
        return await self._request("/api/triggers/get", "GET", params=params, account_id=account_id)

    async def update_trigger(
        self,
        trigger_id: str,
        account_id: str = None,
        name: str = None,
        description: str = None,
        is_active: bool = None,
        config: dict = None
    ) -> dict:
        """Update a trigger.

        Args:
            trigger_id: Trigger ID to update
            account_id: Optional account ID
            name: Optional new name
            description: Optional new description
            is_active: Optional new active status
            config: Optional new configuration

        Returns:
            Updated trigger data
        """
        data = {"triggerId": trigger_id}
        if name is not None:
            data["name"] = name
        if description is not None:
            data["description"] = description
        if is_active is not None:
            data["isActive"] = is_active
        if config is not None:
            data["config"] = config

        return await self._request("/api/triggers/update", "PATCH", data, account_id)

    async def delete_trigger(
        self,
        trigger_id: str,
        account_id: str = None
    ) -> dict:
        """Delete a trigger.

        Args:
            trigger_id: Trigger ID to delete
            account_id: Optional account ID

        Returns:
            Deletion confirmation
        """
        data = {"triggerId": trigger_id}
        return await self._request("/api/triggers/delete", "DELETE", data, account_id)

    async def get_agent(
        self,
        agent_id: str,
        account_id: str = None
    ) -> dict:
        """Get an agent by ID.

        Args:
            agent_id: Agent ID to retrieve
            account_id: Optional account ID

        Returns:
            Agent data
        """
        params = {"id": agent_id}
        return await self._request("/api/agents/get", "GET", params=params, account_id=account_id)

    async def list_agent_runs(
        self,
        thread_id: str = None,
        agent_id: str = None,
        account_id: str = None,
        trigger_id: str = None,
        limit: int = 100,
        offset: int = 0
    ) -> list:
        """List agent runs with optional filters.

        Args:
            thread_id: Optional thread ID to filter by
            agent_id: Optional agent ID to filter by
            account_id: Optional account ID
            trigger_id: Optional trigger ID to filter by (in metadata)
            limit: Maximum number of runs to return
            offset: Pagination offset

        Returns:
            List of agent runs
        """
        params = {"limit": limit, "offset": offset}
        if thread_id:
            params["threadId"] = thread_id
        if agent_id:
            params["agentId"] = agent_id
        if trigger_id:
            params["triggerId"] = trigger_id

        return await self._request("/api/agent-runs/list", "GET", params=params, account_id=account_id)

    async def count_active_agent_runs(self, account_id: str = None) -> int:
        """Count active agent runs (status: running or queued).

        This is used for worker metrics to track active runs across all instances.

        Args:
            account_id: Optional account ID (not required for global count)

        Returns:
            Count of active agent runs
        """
        result = await self._request("/api/agent-runs/count", "GET", params={}, account_id=account_id)
        return result.get("count", 0)

    async def log_trigger_event(
        self,
        log_id: str,
        trigger_id: str,
        agent_id: str,
        trigger_type: str,
        event_data: Any,
        success: bool,
        should_execute_agent: bool = False,
        agent_prompt: str = None,
        execution_variables: dict = None,
        error_message: str = None,
        event_timestamp: str = None,
        account_id: str = None
    ) -> dict:
        """Log a trigger event.

        Args:
            log_id: Unique log identifier
            trigger_id: Trigger ID
            agent_id: Agent ID
            trigger_type: Type of trigger
            event_data: Event data/payload
            success: Whether event processing succeeded
            should_execute_agent: Whether agent execution was triggered
            agent_prompt: Optional agent prompt
            execution_variables: Optional execution variables
            error_message: Optional error message
            event_timestamp: Optional event timestamp
            account_id: Optional account ID

        Returns:
            Created log data
        """
        data = {
            "logId": log_id,
            "triggerId": trigger_id,
            "agentId": agent_id,
            "triggerType": trigger_type,
            "eventData": event_data,
            "success": success,
            "shouldExecuteAgent": should_execute_agent
        }
        if agent_prompt:
            data["agentPrompt"] = agent_prompt
        if execution_variables:
            data["executionVariables"] = execution_variables
        if error_message:
            data["errorMessage"] = error_message
        if event_timestamp:
            data["eventTimestamp"] = event_timestamp

        return await self._request("/api/triggers/events/log", "POST", data, account_id)

    async def count_triggers_by_config(
        self,
        config_key: str,
        config_value: str,
        trigger_type: str = None,
        is_active: bool = None,
        exclude_trigger_id: str = None,
        account_id: str = None
    ) -> int:
        """Count triggers matching a config key-value pair.

        This is used for Composio trigger deduplication.

        Args:
            config_key: Config key to match (e.g., "composio_trigger_id")
            config_value: Config value to match
            trigger_type: Optional trigger type filter
            is_active: Optional active status filter
            exclude_trigger_id: Optional trigger ID to exclude from count
            account_id: Optional account ID

        Returns:
            Count of matching triggers
        """
        params = {
            "configKey": config_key,
            "configValue": config_value
        }
        if trigger_type:
            params["triggerType"] = trigger_type
        if is_active is not None:
            params["isActive"] = is_active
        if exclude_trigger_id:
            params["excludeTriggerId"] = exclude_trigger_id

        result = await self._request("/api/triggers/count-by-config", "GET", params=params, account_id=account_id)
        return result.get("count", 0)

    # ==========================================
    # VAPI Call Operations
    # ==========================================

    async def upsert_vapi_call(
        self,
        call_id: str,
        thread_id: str,
        agent_id: str = None,
        account_id: str = None,
        status: str = "pending",
        metadata: dict = None
    ) -> dict:
        """Create or update a VAPI call record.

        Args:
            call_id: Unique call identifier
            thread_id: Thread ID associated with the call
            agent_id: Optional agent ID
            account_id: Optional account ID
            status: Call status (pending, queued, active, ended, etc.)
            metadata: Optional metadata dict (phone_number, direction, transcript, etc.)

        Returns:
            Created/updated call data
        """
        data = {
            "callId": call_id,
            "threadId": thread_id,
            "status": status
        }
        if agent_id:
            data["agentId"] = agent_id
        if metadata:
            data["metadata"] = metadata
        return await self._request("/api/vapi-calls/upsert", "POST", data, account_id)

    async def get_vapi_call(self, call_id: str, account_id: str = None) -> dict:
        """Get a VAPI call by ID.

        Args:
            call_id: Call ID to retrieve
            account_id: Optional account ID

        Returns:
            Call data
        """
        params = {"id": call_id}
        return await self._request("/api/vapi-calls/get", "GET", params=params, account_id=account_id)

    async def list_vapi_calls(self, thread_id: str, account_id: str = None, limit: int = 100) -> list:
        """List VAPI calls for a thread.

        Args:
            thread_id: Thread ID to list calls for
            account_id: Optional account ID
            limit: Maximum number of calls to return

        Returns:
            List of calls
        """
        params = {"threadId": thread_id, "limit": limit}
        return await self._request("/api/vapi-calls/list", "GET", params=params, account_id=account_id)

    async def update_vapi_call(
        self,
        call_id: str,
        account_id: str = None,
        status: str = None,
        metadata: dict = None
    ) -> dict:
        """Update a VAPI call.

        Args:
            call_id: Call ID to update
            account_id: Optional account ID
            status: Optional new status
            metadata: Optional metadata updates

        Returns:
            Updated call data
        """
        data = {"callId": call_id}
        if status is not None:
            data["status"] = status
        if metadata is not None:
            data["metadata"] = metadata
        return await self._request("/api/vapi-calls/update", "PATCH", data, account_id)

    # ==========================================
    # File Operations
    # ==========================================

    async def create_file_record(
        self,
        file_id: str,
        thread_id: str,
        account_id: str,
        filename: str,
        content_type: str = None,
        size: int = None,
        storage_path: str = None,
        bucket_name: str = None,
        signed_url: str = None,
        url_expires_at: str = None,
        project_id: str = None,
        agent_id: str = None,
        metadata: dict = None
    ) -> dict:
        """Create a file record.

        Args:
            file_id: Unique file identifier
            thread_id: Thread ID associated with the file
            account_id: Account ID that owns the file
            filename: Original filename
            content_type: Optional MIME type
            size: Optional file size in bytes
            storage_path: Optional storage path in bucket
            bucket_name: Optional storage bucket name
            signed_url: Optional signed URL for access
            url_expires_at: Optional ISO timestamp when URL expires
            project_id: Optional project ID
            agent_id: Optional agent ID
            metadata: Optional metadata dict

        Returns:
            Created file record data
        """
        data = {
            "fileId": file_id,
            "threadId": thread_id,
            "accountId": account_id,
            "filename": filename
        }
        if content_type:
            data["contentType"] = content_type
        if size is not None:
            data["size"] = size
        if storage_path:
            data["storagePath"] = storage_path
        if bucket_name:
            data["bucketName"] = bucket_name
        if signed_url:
            data["signedUrl"] = signed_url
        if url_expires_at:
            data["urlExpiresAt"] = url_expires_at
        if project_id:
            data["projectId"] = project_id
        if agent_id:
            data["agentId"] = agent_id
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Creating file record {file_id} for thread {thread_id}")
        return await self._request("/api/files", "POST", data, account_id)

    async def get_file(self, file_id: str, account_id: str = None) -> dict:
        """Get a file record.

        Args:
            file_id: File ID to retrieve
            account_id: Optional account ID

        Returns:
            File record data
        """
        params = {"id": file_id}
        return await self._request("/api/files/get", "GET", params=params, account_id=account_id)

    async def list_files(self, thread_id: str, account_id: str = None, limit: int = 100) -> list:
        """List files for a thread.

        Args:
            thread_id: Thread ID to list files for
            account_id: Optional account ID
            limit: Maximum number of files to return

        Returns:
            List of file records
        """
        params = {"threadId": thread_id, "limit": limit}
        return await self._request("/api/files/list", "GET", params=params, account_id=account_id)

    async def update_file(
        self,
        file_id: str,
        account_id: str = None,
        signed_url: str = None,
        url_expires_at: str = None,
        metadata: dict = None
    ) -> dict:
        """Update a file record.

        Args:
            file_id: File ID to update
            account_id: Optional account ID
            signed_url: Optional new signed URL
            url_expires_at: Optional new URL expiration timestamp
            metadata: Optional metadata updates

        Returns:
            Updated file record data
        """
        data = {"fileId": file_id}
        if signed_url is not None:
            data["signedUrl"] = signed_url
        if url_expires_at is not None:
            data["urlExpiresAt"] = url_expires_at
        if metadata is not None:
            data["metadata"] = metadata
        return await self._request("/api/files/update", "PATCH", data, account_id)

    async def create_file_upload(
        self,
        upload_id: str,
        account_id: str,
        storage_path: str,
        bucket_name: str,
        original_filename: str,
        file_size: int,
        content_type: str,
        signed_url: str,
        url_expires_at: str,
        project_id: str = None,
        thread_id: str = None,
        agent_id: str = None,
        user_id: str = None,
        metadata: dict = None
    ) -> dict:
        """Create a file upload record (for sandbox uploads).

        Args:
            upload_id: Unique upload identifier
            account_id: Account ID that owns the upload
            storage_path: Storage path in bucket
            bucket_name: Storage bucket name
            original_filename: Original filename
            file_size: File size in bytes
            content_type: MIME type
            signed_url: Signed URL for access
            url_expires_at: ISO timestamp when URL expires
            project_id: Optional project ID
            thread_id: Optional thread ID
            agent_id: Optional agent ID
            user_id: Optional user ID
            metadata: Optional metadata dict

        Returns:
            Created upload record data
        """
        data = {
            "uploadId": upload_id,
            "accountId": account_id,
            "storagePath": storage_path,
            "bucketName": bucket_name,
            "originalFilename": original_filename,
            "fileSize": file_size,
            "contentType": content_type,
            "signedUrl": signed_url,
            "urlExpiresAt": url_expires_at
        }
        if project_id:
            data["projectId"] = project_id
        if thread_id:
            data["threadId"] = thread_id
        if agent_id:
            data["agentId"] = agent_id
        if user_id:
            data["userId"] = user_id
        if metadata:
            data["metadata"] = metadata

        logger.debug(f"Creating file upload record {upload_id} for account {account_id}")
        return await self._request("/api/file-uploads", "POST", data, account_id)

    # ==========================================
    # Template Operations
    # ==========================================

    async def list_templates(
        self,
        account_id: str = None,
        is_public: bool = None,
        creator_id: str = None,
        is_kortix_team: bool = None,
        search: str = None,
        tags: list = None,
        sort_by: str = "download_count",
        sort_order: str = "desc",
        limit: int = 100,
        offset: int = 0
    ) -> list:
        """List agent templates.

        Args:
            account_id: Optional account ID
            is_public: Filter by public status
            creator_id: Filter by creator ID
            is_kortix_team: Filter for Kortix team templates
            search: Search term for name
            tags: Optional list of tags to filter by
            sort_by: Sort field (download_count, created_at, name)
            sort_order: Sort order (asc, desc)
            limit: Maximum number of templates to return
            offset: Pagination offset

        Returns:
            List of templates
        """
        params = {"limit": limit, "offset": offset}
        if is_public is not None:
            params["isPublic"] = is_public
        if creator_id:
            params["creatorId"] = creator_id
        if is_kortix_team is not None:
            params["isKortixTeam"] = is_kortix_team
        if search:
            params["search"] = search
        if tags:
            params["tags"] = tags
        if sort_by:
            params["sortBy"] = sort_by
        if sort_order:
            params["sortOrder"] = sort_order

        return await self._request("/api/templates/list", "GET", params=params, account_id=account_id)

    async def get_template(self, template_id: str, account_id: str = None) -> dict:
        """Get a template by ID.

        Args:
            template_id: Template ID to retrieve
            account_id: Optional account ID

        Returns:
            Template data
        """
        params = {"id": template_id}
        return await self._request("/api/templates/get", "GET", params=params, account_id=account_id)

    async def create_template(
        self,
        template_id: str,
        name: str,
        creator_id: str,
        config: dict = None,
        tags: list = None,
        categories: list = None,
        is_public: bool = False,
        is_kortix_team: bool = False,
        icon_name: str = None,
        icon_color: str = None,
        icon_background: str = None,
        metadata: dict = None,
        usage_examples: list = None,
        account_id: str = None
    ) -> dict:
        """Create a new template.

        Args:
            template_id: Unique template identifier
            name: Template name
            creator_id: Creator account ID
            config: Template configuration
            tags: Optional list of tags
            categories: Optional list of categories
            is_public: Whether template is public
            is_kortix_team: Whether this is a Kortix team template
            icon_name: Optional icon name
            icon_color: Optional icon color
            icon_background: Optional icon background
            metadata: Optional metadata dict
            usage_examples: Optional usage examples
            account_id: Optional account ID for request

        Returns:
            Created template data
        """
        data = {
            "templateId": template_id,
            "name": name,
            "creatorId": creator_id,
            "isPublic": is_public,
            "isKortixTeam": is_kortix_team
        }
        if config:
            data["config"] = config
        if tags:
            data["tags"] = tags
        if categories:
            data["categories"] = categories
        if icon_name:
            data["iconName"] = icon_name
        if icon_color:
            data["iconColor"] = icon_color
        if icon_background:
            data["iconBackground"] = icon_background
        if metadata:
            data["metadata"] = metadata
        if usage_examples:
            data["usageExamples"] = usage_examples

        logger.debug(f"Creating template '{name}' ({template_id}) for creator {creator_id}")
        return await self._request("/api/templates", "POST", data, account_id=account_id or creator_id)

    async def update_template(
        self,
        template_id: str,
        account_id: str = None,
        name: str = None,
        config: dict = None,
        tags: list = None,
        categories: list = None,
        is_public: bool = None,
        is_kortix_team: bool = None,
        icon_name: str = None,
        icon_color: str = None,
        icon_background: str = None,
        metadata: dict = None,
        usage_examples: list = None
    ) -> dict:
        """Update a template.

        Args:
            template_id: Template ID to update
            account_id: Optional account ID
            name: Optional new name
            config: Optional new configuration
            tags: Optional new tags
            categories: Optional new categories
            is_public: Optional new public status
            is_kortix_team: Optional new Kortix team status
            icon_name: Optional new icon name
            icon_color: Optional new icon color
            icon_background: Optional new icon background
            metadata: Optional new metadata
            usage_examples: Optional new usage examples

        Returns:
            Updated template data
        """
        data = {"templateId": template_id}
        if name is not None:
            data["name"] = name
        if config is not None:
            data["config"] = config
        if tags is not None:
            data["tags"] = tags
        if categories is not None:
            data["categories"] = categories
        if is_public is not None:
            data["isPublic"] = is_public
        if is_kortix_team is not None:
            data["isKortixTeam"] = is_kortix_team
        if icon_name is not None:
            data["iconName"] = icon_name
        if icon_color is not None:
            data["iconColor"] = icon_color
        if icon_background is not None:
            data["iconBackground"] = icon_background
        if metadata is not None:
            data["metadata"] = metadata
        if usage_examples is not None:
            data["usageExamples"] = usage_examples

        return await self._request("/api/templates/update", "PATCH", data, account_id)

    async def delete_template(self, template_id: str, creator_id: str = None) -> dict:
        """Delete a template.

        Args:
            template_id: Template ID to delete
            creator_id: Creator account ID for validation

        Returns:
            Deletion confirmation
        """
        data = {"templateId": template_id}
        if creator_id:
            data["creatorId"] = creator_id
        return await self._request("/api/templates/delete", "DELETE", data, creator_id)

    async def publish_template(
        self,
        template_id: str,
        creator_id: str,
        usage_examples: list = None
    ) -> dict:
        """Publish a template to the marketplace.

        Args:
            template_id: Template ID to publish
            creator_id: Creator account ID
            usage_examples: Optional usage examples

        Returns:
            Updated template data
        """
        data = {"templateId": template_id, "creatorId": creator_id}
        if usage_examples:
            data["usageExamples"] = usage_examples
        return await self._request("/api/templates/publish", "PATCH", data, creator_id)

    async def unpublish_template(
        self,
        template_id: str,
        creator_id: str
    ) -> dict:
        """Unpublish a template from the marketplace.

        Args:
            template_id: Template ID to unpublish
            creator_id: Creator account ID

        Returns:
            Updated template data
        """
        data = {"templateId": template_id, "creatorId": creator_id}
        return await self._request("/api/templates/unpublish", "PATCH", data, creator_id)

    async def increment_template_download_count(self, template_id: str) -> dict:
        """Increment the download count for a template.

        Args:
            template_id: Template ID

        Returns:
            Updated template data
        """
        data = {"templateId": template_id}
        return await self._request("/api/templates/increment-downloads", "POST", data)


    # ==========================================
    # Message Operations (Extended)
    # ==========================================

    async def get_message(self, message_id: str, account_id: str = None) -> dict:
        """Get a message by ID.

        Args:
            message_id: Message ID to retrieve
            account_id: Optional account ID

        Returns:
            Message data
        """
        params = {"id": message_id}
        return await self._request("/api/messages/get", "GET", params=params, account_id=account_id)

    async def get_messages_by_type(
        self,
        thread_id: str,
        message_type: str,
        account_id: str = None,
        limit: int = 10
    ) -> list:
        """Get messages by type for a thread.

        Args:
            thread_id: Thread ID to get messages for
            message_type: Type of message to filter by (e.g., 'task_list')
            account_id: Optional account ID
            limit: Maximum number of messages to return

        Returns:
            List of messages of the specified type
        """
        params = {
            "threadId": thread_id,
            "type": message_type,
            "limit": limit
        }
        return await self._request("/api/messages/by-type", "GET", params=params, account_id=account_id)

    async def update_message(
        self,
        message_id: str,
        account_id: str = None,
        content: Any = None,
        metadata: dict = None
    ) -> dict:
        """Update a message.

        Args:
            message_id: Message ID to update
            account_id: Optional account ID
            content: Optional new content
            metadata: Optional metadata updates

        Returns:
            Updated message data
        """
        data = {"messageId": message_id}
        if content is not None:
            data["content"] = content
        if metadata is not None:
            data["metadata"] = metadata
        return await self._request("/api/messages/update", "PATCH", data, account_id)

    async def upsert_message(
        self,
        message_id: str,
        thread_id: str,
        message_type: str,
        content: Any,
        account_id: str = None,
        metadata: dict = None
    ) -> dict:
        """Create or update a message.

        Args:
            message_id: Unique message identifier
            thread_id: Thread ID
            message_type: Type of message
            content: Message content
            account_id: Optional account ID
            metadata: Optional metadata

        Returns:
            Created/updated message data
        """
        data = {
            "messageId": message_id,
            "threadId": thread_id,
            "type": message_type,
            "content": content
        }
        if metadata:
            data["metadata"] = metadata
        return await self._request("/api/messages/upsert", "POST", data, account_id)

    # ==========================================
    # Agent Version Operations
    # ==========================================

    async def get_agent_version(self, version_id: str, account_id: str = None) -> dict:
        """Get an agent version by ID.

        Args:
            version_id: Version ID to retrieve
            account_id: Optional account ID

        Returns:
            Agent version data
        """
        params = {"id": version_id}
        return await self._request("/api/agent-versions/get", "GET", params=params, account_id=account_id)

    async def get_agent_current_version(self, agent_id: str, account_id: str = None) -> dict:
        """Get the current active version for an agent.

        Args:
            agent_id: Agent ID
            account_id: Optional account ID

        Returns:
            Current agent version data
        """
        params = {"agentId": agent_id}
        return await self._request("/api/agent-versions/current", "GET", params=params, account_id=account_id)

    async def update_agent_version(
        self,
        version_id: str,
        account_id: str = None,
        config: dict = None,
        metadata: dict = None
    ) -> dict:
        """Update an agent version.

        Args:
            version_id: Version ID to update
            account_id: Optional account ID
            config: Optional new config
            metadata: Optional metadata updates

        Returns:
            Updated version data
        """
        data = {"versionId": version_id}
        if config is not None:
            data["config"] = config
        if metadata is not None:
            data["metadata"] = metadata
        return await self._request("/api/agent-versions/update", "PATCH", data, account_id)

    async def list_agent_versions(self, agent_id: str, account_id: str = None, limit: int = 100) -> list:
        """List versions for an agent.

        Args:
            agent_id: Agent ID to list versions for
            account_id: Optional account ID
            limit: Maximum number of versions to return

        Returns:
            List of agent versions
        """
        params = {"agentId": agent_id, "limit": limit}
        return await self._request("/api/agent-versions/list", "GET", params=params, account_id=account_id)

    # ==========================================
    # Credit Operations
    # ==========================================

    async def get_credit_account(self, account_id: str) -> dict:
        """Get credit account for a user.

        Args:
            account_id: Account ID

        Returns:
            Credit account data
        """
        params = {"accountId": account_id}
        return await self._request("/api/credits/account", "GET", params=params, account_id=account_id)

    async def upsert_credit_account(
        self,
        account_id: str,
        balance: int = 0,
        tier: str = "free",
        metadata: dict = None
    ) -> dict:
        """Create or update a credit account.

        Args:
            account_id: Account ID
            balance: Initial/updated balance
            tier: Account tier
            metadata: Optional metadata

        Returns:
            Credit account data
        """
        data = {
            "accountId": account_id,
            "balance": balance,
            "tier": tier
        }
        if metadata:
            data["metadata"] = metadata
        return await self._request("/api/credits/account/upsert", "POST", data, account_id)

    async def add_credits(
        self,
        account_id: str,
        amount: int,
        description: str = None,
        transaction_type: str = "purchase",
        metadata: dict = None
    ) -> dict:
        """Add credits to an account.

        Args:
            account_id: Account ID
            amount: Amount of credits to add
            description: Optional description
            transaction_type: Type of transaction
            metadata: Optional metadata

        Returns:
            Transaction result
        """
        data = {
            "accountId": account_id,
            "amount": amount,
            "type": transaction_type
        }
        if description:
            data["description"] = description
        if metadata:
            data["metadata"] = metadata
        return await self._request("/api/credits/add", "POST", data, account_id)

    async def deduct_credits(
        self,
        account_id: str,
        amount: int,
        description: str = None,
        agent_id: str = None,
        model: str = None,
        metadata: dict = None
    ) -> dict:
        """Deduct credits from an account.

        Args:
            account_id: Account ID
            amount: Amount of credits to deduct
            description: Optional description
            agent_id: Optional agent ID that used credits
            model: Optional model that used credits
            metadata: Optional metadata

        Returns:
            Transaction result
        """
        data = {
            "accountId": account_id,
            "amount": -amount,  # Negative for deduction
            "type": "usage"
        }
        if description:
            data["description"] = description
        if agent_id:
            data["agentId"] = agent_id
        if model:
            data["model"] = model
        if metadata:
            data["metadata"] = metadata
        return await self._request("/api/credits/deduct", "POST", data, account_id)

    async def get_credit_transactions(
        self,
        account_id: str,
        limit: int = 100,
        offset: int = 0
    ) -> list:
        """Get credit transaction history for an account.

        Args:
            account_id: Account ID
            limit: Maximum number of transactions
            offset: Pagination offset

        Returns:
            List of credit transactions
        """
        params = {"accountId": account_id, "limit": limit, "offset": offset}
        return await self._request("/api/credits/transactions", "GET", params=params, account_id=account_id)

    async def get_credit_balance(self, account_id: str) -> dict:
        """Get credit balance for an account.

        Args:
            account_id: Account ID to get balance for

        Returns:
            Balance data including expiring and non-expiring credits
        """
        params = {"accountId": account_id}
        return await self._request("/api/credits/balance", "GET", params=params, account_id=account_id)

    async def refresh_daily_credits(self, account_id: str) -> dict:
        """Perform daily credit refresh for an account.

        Args:
            account_id: Account ID to refresh credits for

        Returns:
            Refresh result with new balance and amount granted
        """
        data = {"accountId": account_id}
        return await self._request("/api/credits/daily-refresh", "POST", data, account_id)

    async def grant_tier_credits(
        self,
        account_id: str,
        tier_name: str,
        price_id: str = None,
        grant_type: str = "subscription"
    ) -> dict:
        """Grant tier-based credits to an account.

        Args:
            account_id: Account ID to grant credits to
            tier_name: Name of the tier for credit calculation
            price_id: Optional price ID for tier lookup
            grant_type: Type of grant (subscription, upgrade, etc.)

        Returns:
            Grant result with new balance and amount granted
        """
        data = {
            "accountId": account_id,
            "tierName": tier_name,
            "grantType": grant_type
        }
        if price_id:
            data["priceId"] = price_id
        return await self._request("/api/credits/grant-tier", "POST", data, account_id)

    async def get_credit_summary(self, account_id: str) -> dict:
        """Get comprehensive credit account summary.

        Args:
            account_id: Account ID to get summary for

        Returns:
            Summary including balance, tier, lifetime stats, etc.
        """
        params = {"accountId": account_id}
        return await self._request("/api/credits/summary", "GET", params=params, account_id=account_id)



    # ==========================================
    # Credential Operations
    # ==========================================

    async def store_credential(
        self,
        credential_id: str,
        account_id: str,
        mcp_qualified_name: str,
        display_name: str,
        encrypted_config: str,
        config_hash: str,
        is_active: bool = True
    ) -> dict:
        """Store a new MCP credential.

        Args:
            credential_id: Unique credential identifier
            account_id: Account ID that owns the credential
            mcp_qualified_name: Qualified name of the MCP service
            display_name: Human-readable display name
            encrypted_config: Base64-encoded encrypted config
            config_hash: SHA256 hash of the original config for integrity
            is_active: Whether the credential is active

        Returns:
            Created credential data
        """
        data = {
            "credentialId": credential_id,
            "accountId": account_id,
            "mcpQualifiedName": mcp_qualified_name,
            "displayName": display_name,
            "encryptedConfig": encrypted_config,
            "configHash": config_hash,
            "isActive": is_active
        }
        logger.debug(f"Storing credential {credential_id} for {mcp_qualified_name}")
        return await self._request("/api/credentials", "POST", data, account_id)

    async def get_credential(
        self,
        account_id: str,
        mcp_qualified_name: str
    ) -> dict:
        """Get a credential by account ID and MCP qualified name.

        Args:
            account_id: Account ID that owns the credential
            mcp_qualified_name: Qualified name of the MCP service

        Returns:
            Credential data
        """
        params = {
            "accountId": account_id,
            "mcpQualifiedName": mcp_qualified_name
        }
        return await self._request("/api/credentials/get", "GET", params=params, account_id=account_id)

    async def get_credential_by_id(
        self,
        credential_id: str,
        account_id: str = None
    ) -> dict:
        """Get a credential by ID.

        Args:
            credential_id: Credential ID to retrieve
            account_id: Optional account ID

        Returns:
            Credential data
        """
        params = {"id": credential_id}
        return await self._request("/api/credentials/get-by-id", "GET", params=params, account_id=account_id)

    async def list_credentials(
        self,
        account_id: str,
        limit: int = 100
    ) -> list:
        """List all credentials for an account.

        Args:
            account_id: Account ID to list credentials for
            limit: Maximum number of credentials to return

        Returns:
            List of credentials
        """
        params = {"accountId": account_id, "limit": limit}
        return await self._request("/api/credentials", "GET", params=params, account_id=account_id)

    async def update_credential(
        self,
        credential_id: str,
        account_id: str = None,
        display_name: str = None,
        encrypted_config: str = None,
        config_hash: str = None,
        is_active: bool = None
    ) -> dict:
        """Update a credential.

        Args:
            credential_id: Credential ID to update
            account_id: Optional account ID
            display_name: Optional new display name
            encrypted_config: Optional new encrypted config
            config_hash: Optional new config hash
            is_active: Optional new active status

        Returns:
            Updated credential data
        """
        data = {"credentialId": credential_id}
        if display_name is not None:
            data["displayName"] = display_name
        if encrypted_config is not None:
            data["encryptedConfig"] = encrypted_config
        if config_hash is not None:
            data["configHash"] = config_hash
        if is_active is not None:
            data["isActive"] = is_active
        return await self._request("/api/credentials/update", "PATCH", data, account_id)

    async def delete_credential(
        self,
        account_id: str,
        mcp_qualified_name: str
    ) -> dict:
        """Delete a credential.

        Args:
            account_id: Account ID that owns the credential
            mcp_qualified_name: Qualified name of the MCP service

        Returns:
            Deletion confirmation
        """
        data = {
            "accountId": account_id,
            "mcpQualifiedName": mcp_qualified_name
        }
        return await self._request("/api/credentials/delete", "DELETE", data, account_id)

    async def update_credential_last_used(
        self,
        credential_id: str,
        account_id: str = None
    ) -> dict:
        """Update the last_used_at timestamp for a credential.

        Args:
            credential_id: Credential ID to update
            account_id: Optional account ID

        Returns:
            Updated credential data
        """
        data = {"credentialId": credential_id}
        return await self._request("/api/credentials/update-last-used", "POST", data, account_id)

    # ==========================================
    # Credential Profile Operations
    # ==========================================

    async def list_credential_profiles(self, account_id: str, service_name: str = None) -> list:
        """List credential profiles for an account.

        Args:
            account_id: Account ID to list profiles for
            service_name: Optional service name filter

        Returns:
            List of credential profiles
        """
        params = {"accountId": account_id}
        if service_name:
            params["serviceName"] = service_name
        return await self._request("/api/credential-profiles/list", "GET", params=params, account_id=account_id)

    async def get_credential_profile(self, profile_id: str, account_id: str = None) -> dict:
        """Get a specific credential profile.

        Args:
            profile_id: Profile ID to get
            account_id: Optional account ID

        Returns:
            Credential profile data
        """
        params = {"profileId": profile_id}
        return await self._request("/api/credential-profiles/get", "GET", params=params, account_id=account_id)

    async def create_credential_profile(
        self,
        account_id: str,
        profile_name: str,
        description: str = None,
        tools: list = None,
        is_default: bool = False
    ) -> dict:
        """Create a new credential profile.

        Args:
            account_id: Account ID
            profile_name: Profile name
            description: Optional description
            tools: Optional list of tools
            is_default: Whether this is the default profile

        Returns:
            Created credential profile
        """
        data = {
            "accountId": account_id,
            "profileName": profile_name,
            "isDefault": is_default
        }
        if description:
            data["description"] = description
        if tools:
            data["tools"] = tools

        return await self._request("/api/credential-profiles", "POST", data, account_id)

    async def update_credential_profile(
        self,
        profile_id: str,
        account_id: str = None,
        profile_name: str = None,
        description: str = None,
        tools: list = None,
        is_default: bool = None,
        is_connected: bool = None
    ) -> dict:
        """Update a credential profile.

        Args:
            profile_id: Profile ID to update
            account_id: Optional account ID
            profile_name: Optional new profile name
            description: Optional new description
            tools: Optional new tools list
            is_default: Optional new default status
            is_connected: Optional new connected status

        Returns:
            Updated credential profile
        """
        data = {"profileId": profile_id}
        if profile_name is not None:
            data["profileName"] = profile_name
        if description is not None:
            data["description"] = description
        if tools is not None:
            data["tools"] = tools
        if is_default is not None:
            data["isDefault"] = is_default
        if is_connected is not None:
            data["isConnected"] = is_connected

        return await self._request("/api/credential-profiles/update", "PATCH", data, account_id)

    async def delete_credential_profile(self, profile_id: str, account_id: str = None) -> dict:
        """Delete a credential profile.

        Args:
            profile_id: Profile ID to delete
            account_id: Optional account ID

        Returns:
            Deletion result
        """
        data = {"profileId": profile_id}
        return await self._request("/api/credential-profiles/delete", "DELETE", data, account_id)

    async def get_mcp_url_for_profile(self, profile_id: str, account_id: str = None) -> dict:
        """Get the MCP URL for a credential profile.

        Args:
            profile_id: Profile ID to get MCP URL for
            account_id: Optional account ID

        Returns:
            MCP URL data
        """
        params = {"profileId": profile_id}
        return await self._request("/api/credential-profiles/mcp-url", "GET", params=params, account_id=account_id)

    async def set_default_credential_profile(self, profile_id: str, account_id: str = None) -> dict:
        """Set a credential profile as the default.

        Args:
            profile_id: Profile ID to set as default
            account_id: Optional account ID

        Returns:
            Updated profile data
        """
        data = {"profileId": profile_id}
        return await self._request("/api/credential-profiles/set-default", "POST", data, account_id)

    # ==========================================
    # Composio Integration Operations
    # ==========================================

    async def get_composio_profiles(self, account_id: str, toolkit_slug: str = None) -> list:
        """Get Composio profiles for an account.

        Args:
            account_id: Account ID to get profiles for
            toolkit_slug: Optional toolkit slug filter

        Returns:
            List of Composio profiles
        """
        params = {"accountId": account_id}
        if toolkit_slug:
            params["toolkitSlug"] = toolkit_slug
        return await self._request("/api/composio-profiles/list", "GET", params=params, account_id=account_id)

    async def get_composio_connection_status(self, account_id: str, toolkit_slug: str) -> dict:
        """Get Composio connection status for a toolkit.

        Args:
            account_id: Account ID to check
            toolkit_slug: Toolkit slug to check

        Returns:
            Connection status data
        """
        params = {"accountId": account_id, "toolkitSlug": toolkit_slug}
        return await self._request("/api/composio-profiles/connection-status", "GET", params=params, account_id=account_id)

    # ==========================================
    # Knowledge Base Folder Operations
    # ==========================================

    async def create_knowledge_base_folder(
        self,
        folder_id: str,
        account_id: str,
        name: str,
        description: str = None
    ) -> dict:
        """Create a knowledge base folder.

        Args:
            folder_id: Unique folder identifier
            account_id: Account ID that owns the folder
            name: Folder name
            description: Optional folder description

        Returns:
            Created folder data
        """
        data = {
            "folderId": folder_id,
            "accountId": account_id,
            "name": name
        }
        if description:
            data["description"] = description
        logger.debug(f"Creating knowledge base folder {folder_id} for account {account_id}")
        return await self._request("/api/kb/folders", "POST", data, account_id)

    async def get_knowledge_base_folder(self, folder_id: str, account_id: str = None) -> dict:
        """Get a knowledge base folder by ID.

        Args:
            folder_id: Folder ID to retrieve
            account_id: Optional account ID

        Returns:
            Folder data
        """
        params = {"folderId": folder_id}
        return await self._request("/api/kb/folders/get", "GET", params=params, account_id=account_id)

    async def list_knowledge_base_folders(self, account_id: str) -> list:
        """List all knowledge base folders for an account.

        Args:
            account_id: Account ID to list folders for

        Returns:
            List of folders with entry counts
        """
        params = {"accountId": account_id}
        return await self._request("/api/kb/folders", "GET", params=params, account_id=account_id)

    async def update_knowledge_base_folder(
        self,
        folder_id: str,
        account_id: str = None,
        name: str = None,
        description: str = None
    ) -> dict:
        """Update a knowledge base folder.

        Args:
            folder_id: Folder ID to update
            account_id: Optional account ID
            name: Optional new name
            description: Optional new description

        Returns:
            Updated folder data
        """
        data = {"folderId": folder_id}
        if name is not None:
            data["name"] = name
        if description is not None:
            data["description"] = description
        return await self._request("/api/kb/folders/update", "PATCH", data, account_id)

    async def delete_knowledge_base_folder(self, folder_id: str, account_id: str = None) -> dict:
        """Delete a knowledge base folder (soft-deletes all entries).

        Args:
            folder_id: Folder ID to delete
            account_id: Optional account ID

        Returns:
            Deletion confirmation
        """
        data = {"folderId": folder_id}
        return await self._request("/api/kb/folders/delete", "DELETE", data, account_id)


# Singleton instance variable (module-level)
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


async def close_convex_client():
    """Close the Convex client connection."""
    global _convex_client
    if _convex_client is not None:
        await _convex_client.close()
        _convex_client = None
        logger.info("Convex client closed")


# ==========================================
# Convenience Functions (matching Supabase pattern)
# ==========================================

def threads() -> ConvexClient:
    """Get Convex client for thread operations."""
    return get_convex_client()


def agents() -> ConvexClient:
    """Get Convex client for agent operations."""
    return get_convex_client()


def memories() -> ConvexClient:
    """Get Convex client for memory operations."""
    return get_convex_client()


def convex_client() -> ConvexClient:
    """Get the Convex client instance."""
    return get_convex_client()
