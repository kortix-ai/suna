"""
Sub-Agent Tool: Spawn and manage parallel sub-agent executions.

Sub-agents run asynchronously within the same project sandbox, enabling
parallel task execution while keeping the main agent context clean.
"""

import json
import uuid
import asyncio
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone

from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.utils.logger import logger


# Configurable max depth - currently 1 (main->sub only), future-proof for deeper nesting
MAX_SUB_AGENT_DEPTH = 1


@tool_metadata(
    display_name="Sub-Agent",
    description="Spawn parallel sub-agents for independent task execution",
    icon="Users",
    color="bg-indigo-100 dark:bg-indigo-800/50",
    is_core=True,
    usage_guide="""
### SUB-AGENT PARALLEL EXECUTION

Spawn sub-agents to handle tasks in parallel while you continue orchestrating.

**WHEN TO USE:**
- Research multiple items simultaneously (companies, topics, products)
- Execute independent tasks that don't depend on each other
- Parallelize work that would take too long sequentially
- Delegate focused tasks while continuing main orchestration

**WORKFLOW:**
1. Use `spawn_sub_agent` to start async task execution
2. Continue other work or spawn more sub-agents
3. Use `list_sub_agents` to check status
4. Use `get_sub_agent_result` to retrieve completed results
5. Use `wait_for_sub_agents` to block until all complete

**CONTEXT:**
- Sub-agents share the same project sandbox (files, environment)
- Sub-agents receive the task description as their prompt
- Sub-agents run independently with focused context
- Sub-agents cannot spawn their own sub-agents (depth=1 limit)

**BEST PRACTICES:**
- Give clear, specific task descriptions
- Include relevant context/files the sub-agent needs
- Don't spawn too many at once (5-10 is reasonable)
- Wait for results before final output
""",
    weight=8,
    visible=True
)
class SubAgentTool(SandboxToolsBase):
    """Tool for spawning and managing parallel sub-agent executions."""
    
    def __init__(self, project_id: str, thread_manager, thread_id: str):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        self._current_depth: Optional[int] = None
    
    async def _get_current_depth(self) -> int:
        """Get the depth level of the current thread."""
        if self._current_depth is not None:
            return self._current_depth
        
        try:
            client = await self.thread_manager.db.client
            result = await client.table('threads').select('depth_level').eq('thread_id', self.thread_id).maybe_single().execute()
            
            if result.data:
                self._current_depth = result.data.get('depth_level', 0) or 0
            else:
                self._current_depth = 0
                
            return self._current_depth
        except Exception as e:
            logger.warning(f"Failed to get thread depth, assuming 0: {e}")
            return 0
    
    async def _get_account_id(self) -> Optional[str]:
        """Get the account_id for the current thread."""
        try:
            client = await self.thread_manager.db.client
            result = await client.table('threads').select('account_id').eq('thread_id', self.thread_id).maybe_single().execute()
            
            if result.data:
                return result.data.get('account_id')
            return None
        except Exception as e:
            logger.warning(f"Failed to get account_id: {e}")
            return None

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "spawn_sub_agent",
            "description": "Spawn a sub-agent to execute a task asynchronously in parallel. The sub-agent runs independently, sharing the same project sandbox (files, environment). Returns immediately - use list_sub_agents or wait_for_sub_agents to track progress. Sub-agents cannot spawn their own sub-agents. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `task` (REQUIRED), `context` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "**REQUIRED** - Clear description of what the sub-agent should accomplish. Be specific about: 1) The exact objective, 2) What output/files to produce, 3) Any constraints or requirements. This becomes the sub-agent's main instruction."
                    },
                    "context": {
                        "type": "string",
                        "description": "**OPTIONAL** - Additional context to help the sub-agent. Include: 1) Relevant file paths to read, 2) Background information, 3) Format requirements for output. Keep concise but comprehensive."
                    }
                },
                "required": ["task"],
                "additionalProperties": False
            }
        }
    })
    async def spawn_sub_agent(self, task: str, context: Optional[str] = None) -> ToolResult:
        """Spawn a sub-agent to execute a task asynchronously."""
        try:
            # Check depth limit
            current_depth = await self._get_current_depth()
            if current_depth >= MAX_SUB_AGENT_DEPTH:
                return ToolResult(
                    success=False,
                    output=f"Cannot spawn sub-agent: maximum nesting depth ({MAX_SUB_AGENT_DEPTH}) reached. Sub-agents cannot spawn their own sub-agents."
                )
            
            client = await self.thread_manager.db.client
            account_id = await self._get_account_id()
            
            if not account_id:
                return ToolResult(success=False, output="Failed to determine account for sub-agent")
            
            # Create sub-thread (child of current thread)
            sub_thread_id = str(uuid.uuid4())
            sub_thread_name = f"Sub-agent: {task[:50]}..." if len(task) > 50 else f"Sub-agent: {task}"
            
            await client.table('threads').insert({
                "thread_id": sub_thread_id,
                "project_id": self.project_id,  # Same project = same sandbox
                "account_id": account_id,
                "parent_thread_id": self.thread_id,  # Link to parent
                "depth_level": current_depth + 1,  # Increment depth
                "name": sub_thread_name,
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()
            
            # Compose the sub-agent's instruction message
            instruction = task
            if context:
                instruction = f"{task}\n\n---\nContext:\n{context}"
            
            # Add instruction as user message
            await client.table('messages').insert({
                "message_id": str(uuid.uuid4()),
                "thread_id": sub_thread_id,
                "type": "user",
                "is_llm_message": True,
                "content": {"role": "user", "content": instruction},
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()
            
            # Create agent_run record with task metadata
            agent_run_id = str(uuid.uuid4())
            run_metadata = {
                "task_description": task[:500],  # Store for UI display
                "parent_thread_id": self.thread_id,
                "spawned_as_sub_agent": True,
                "actual_user_id": account_id
            }
            
            await client.table('agent_runs').insert({
                "id": agent_run_id,
                "thread_id": sub_thread_id,
                "status": "pending",  # Will become "running" when worker picks it up
                "started_at": datetime.now(timezone.utc).isoformat(),
                "metadata": run_metadata
            }).execute()
            
            # Queue the sub-agent execution via Dramatiq
            try:
                from run_agent_background import run_agent_background
                from core import core_utils as utils
                
                run_agent_background.send(
                    agent_run_id=agent_run_id,
                    thread_id=sub_thread_id,
                    instance_id=utils.instance_id,
                    project_id=self.project_id,
                    model_name="anthropic/claude-sonnet-4-20250514",
                    agent_id=None,
                    account_id=account_id,
                )
            except Exception as e:
                logger.error(f"Failed to queue sub-agent execution: {e}", exc_info=True)
                # Clean up the created thread and agent_run
                await client.table('agent_runs').delete().eq('id', agent_run_id).execute()
                await client.table('threads').delete().eq('thread_id', sub_thread_id).execute()
                return ToolResult(success=False, output=f"Failed to queue sub-agent: {str(e)}")
            
            logger.info(f"🚀 Spawned sub-agent {agent_run_id} for task: {task[:100]}...")
            
            return ToolResult(
                success=True,
                output=json.dumps({
                    "sub_agent_id": agent_run_id,
                    "thread_id": sub_thread_id,
                    "task": task[:200],
                    "status": "spawned",
                    "message": "Sub-agent spawned successfully. Use list_sub_agents to track progress."
                }, indent=2)
            )
            
        except Exception as e:
            logger.error(f"Failed to spawn sub-agent: {e}", exc_info=True)
            return ToolResult(success=False, output=f"Failed to spawn sub-agent: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_sub_agents",
            "description": "List all sub-agents spawned from this thread with their current status. Use to monitor progress of parallel tasks. **🚨 PARAMETER NAMES**: This function takes no parameters.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def list_sub_agents(self) -> ToolResult:
        """List all sub-agents spawned from this thread."""
        try:
            client = await self.thread_manager.db.client
            
            # Get all child threads
            sub_threads = await client.table('threads').select(
                'thread_id, name, created_at'
            ).eq('parent_thread_id', self.thread_id).execute()
            
            if not sub_threads.data:
                return ToolResult(
                    success=True,
                    output=json.dumps({
                        "sub_agents": [],
                        "message": "No sub-agents have been spawned from this thread."
                    }, indent=2)
                )
            
            # Get agent_runs for these threads
            thread_ids = [t['thread_id'] for t in sub_threads.data]
            
            agent_runs = await client.table('agent_runs').select(
                'id, thread_id, status, started_at, completed_at, error, metadata'
            ).in_('thread_id', thread_ids).order('created_at', desc=True).execute()
            
            # Build status map (latest run per thread)
            runs_by_thread = {}
            for run in (agent_runs.data or []):
                tid = run['thread_id']
                if tid not in runs_by_thread:
                    runs_by_thread[tid] = run
            
            # Compose result
            sub_agents = []
            for thread in sub_threads.data:
                tid = thread['thread_id']
                run = runs_by_thread.get(tid, {})
                metadata = run.get('metadata', {}) or {}
                
                sub_agents.append({
                    "sub_agent_id": run.get('id'),
                    "thread_id": tid,
                    "task": metadata.get('task_description', thread.get('name', 'Unknown task')),
                    "status": run.get('status', 'unknown'),
                    "started_at": run.get('started_at'),
                    "completed_at": run.get('completed_at'),
                    "error": run.get('error')
                })
            
            # Summary counts
            status_counts = {}
            for sa in sub_agents:
                s = sa['status']
                status_counts[s] = status_counts.get(s, 0) + 1
            
            return ToolResult(
                success=True,
                output=json.dumps({
                    "sub_agents": sub_agents,
                    "total": len(sub_agents),
                    "status_summary": status_counts
                }, indent=2)
            )
            
        except Exception as e:
            logger.error(f"Failed to list sub-agents: {e}", exc_info=True)
            return ToolResult(success=False, output=f"Failed to list sub-agents: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_sub_agent_result",
            "description": "Get the result/output from a completed sub-agent. Returns the sub-agent's final assistant message or completion summary. **🚨 PARAMETER NAMES**: Use EXACTLY this parameter name: `sub_agent_id` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "sub_agent_id": {
                        "type": "string",
                        "description": "**REQUIRED** - The sub_agent_id returned from spawn_sub_agent or list_sub_agents."
                    }
                },
                "required": ["sub_agent_id"],
                "additionalProperties": False
            }
        }
    })
    async def get_sub_agent_result(self, sub_agent_id: str) -> ToolResult:
        """Get the result from a completed sub-agent."""
        try:
            client = await self.thread_manager.db.client
            
            # Get the agent run
            run_result = await client.table('agent_runs').select(
                'id, thread_id, status, completed_at, error, metadata'
            ).eq('id', sub_agent_id).maybe_single().execute()
            
            if not run_result.data:
                return ToolResult(success=False, output=f"Sub-agent {sub_agent_id} not found")
            
            run = run_result.data
            thread_id = run['thread_id']
            status = run['status']
            
            # Verify it's a child of this thread
            thread_result = await client.table('threads').select(
                'parent_thread_id'
            ).eq('thread_id', thread_id).maybe_single().execute()
            
            if not thread_result.data or thread_result.data.get('parent_thread_id') != self.thread_id:
                return ToolResult(success=False, output=f"Sub-agent {sub_agent_id} is not a child of this thread")
            
            # Get the last few assistant messages from the sub-agent thread
            messages_result = await client.table('messages').select(
                'content, metadata, type, created_at'
            ).eq('thread_id', thread_id).eq('type', 'assistant').order('created_at', desc=True).limit(3).execute()
            
            # Extract text content from messages
            result_content = []
            for msg in reversed(messages_result.data or []):
                content = msg.get('content', {})
                if isinstance(content, dict):
                    text = content.get('content', '')
                elif isinstance(content, str):
                    text = content
                else:
                    text = str(content)
                
                # Also check metadata for text_content
                metadata = msg.get('metadata', {}) or {}
                if isinstance(metadata, str):
                    try:
                        metadata = json.loads(metadata)
                    except:
                        metadata = {}
                
                text_content = metadata.get('text_content', '')
                if text_content:
                    result_content.append(text_content)
                elif text:
                    result_content.append(text)
            
            task_description = (run.get('metadata') or {}).get('task_description', 'Unknown task')
            
            return ToolResult(
                success=True,
                output=json.dumps({
                    "sub_agent_id": sub_agent_id,
                    "thread_id": thread_id,
                    "task": task_description,
                    "status": status,
                    "error": run.get('error'),
                    "result": "\n\n".join(result_content) if result_content else "(No output captured)",
                    "completed_at": run.get('completed_at')
                }, indent=2)
            )
            
        except Exception as e:
            logger.error(f"Failed to get sub-agent result: {e}", exc_info=True)
            return ToolResult(success=False, output=f"Failed to get sub-agent result: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "wait_for_sub_agents",
            "description": "Wait for one or more sub-agents to complete. Blocks until all specified sub-agents finish (or timeout). If no IDs specified, waits for all sub-agents from this thread. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `sub_agent_ids` (optional), `timeout_seconds` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "sub_agent_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "**OPTIONAL** - List of sub_agent_ids to wait for. If not provided, waits for ALL sub-agents spawned from this thread."
                    },
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "**OPTIONAL** - Maximum seconds to wait. Default 300 (5 minutes). Range: 10-600.",
                        "minimum": 10,
                        "maximum": 600,
                        "default": 300
                    }
                },
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def wait_for_sub_agents(
        self, 
        sub_agent_ids: Optional[List[str]] = None,
        timeout_seconds: int = 300
    ) -> ToolResult:
        """Wait for sub-agents to complete."""
        try:
            client = await self.thread_manager.db.client
            
            # Clamp timeout
            timeout_seconds = max(10, min(600, timeout_seconds))
            
            # If no IDs provided, get all sub-agents for this thread
            if not sub_agent_ids:
                sub_threads = await client.table('threads').select('thread_id').eq('parent_thread_id', self.thread_id).execute()
                
                if not sub_threads.data:
                    return ToolResult(
                        success=True,
                        output=json.dumps({
                            "message": "No sub-agents to wait for.",
                            "sub_agents": []
                        }, indent=2)
                    )
                
                thread_ids = [t['thread_id'] for t in sub_threads.data]
                
                # Get agent run IDs
                runs = await client.table('agent_runs').select('id').in_('thread_id', thread_ids).execute()
                sub_agent_ids = [r['id'] for r in (runs.data or [])]
            
            if not sub_agent_ids:
                return ToolResult(
                    success=True,
                    output=json.dumps({
                        "message": "No sub-agents to wait for.",
                        "sub_agents": []
                    }, indent=2)
                )
            
            # Poll for completion
            start_time = asyncio.get_event_loop().time()
            poll_interval = 2  # seconds
            
            while True:
                elapsed = asyncio.get_event_loop().time() - start_time
                if elapsed >= timeout_seconds:
                    # Timeout - return current status
                    runs = await client.table('agent_runs').select(
                        'id, status, metadata'
                    ).in_('id', sub_agent_ids).execute()
                    
                    results = []
                    for run in (runs.data or []):
                        results.append({
                            "sub_agent_id": run['id'],
                            "status": run['status'],
                            "task": (run.get('metadata') or {}).get('task_description', 'Unknown')
                        })
                    
                    return ToolResult(
                        success=True,
                        output=json.dumps({
                            "message": f"Timeout after {timeout_seconds}s. Some sub-agents may still be running.",
                            "timed_out": True,
                            "sub_agents": results
                        }, indent=2)
                    )
                
                # Check status of all sub-agents
                runs = await client.table('agent_runs').select(
                    'id, status, completed_at, error, metadata'
                ).in_('id', sub_agent_ids).execute()
                
                all_complete = True
                results = []
                
                for run in (runs.data or []):
                    status = run['status']
                    if status not in ('completed', 'failed', 'stopped'):
                        all_complete = False
                    
                    results.append({
                        "sub_agent_id": run['id'],
                        "status": status,
                        "task": (run.get('metadata') or {}).get('task_description', 'Unknown'),
                        "error": run.get('error'),
                        "completed_at": run.get('completed_at')
                    })
                
                if all_complete:
                    successful = sum(1 for r in results if r['status'] == 'completed')
                    failed = sum(1 for r in results if r['status'] in ('failed', 'stopped'))
                    
                    return ToolResult(
                        success=True,
                        output=json.dumps({
                            "message": f"All {len(results)} sub-agents completed. {successful} successful, {failed} failed.",
                            "timed_out": False,
                            "sub_agents": results
                        }, indent=2)
                    )
                
                # Wait before next poll
                await asyncio.sleep(poll_interval)
                
        except Exception as e:
            logger.error(f"Failed to wait for sub-agents: {e}", exc_info=True)
            return ToolResult(success=False, output=f"Failed to wait for sub-agents: {str(e)}")

