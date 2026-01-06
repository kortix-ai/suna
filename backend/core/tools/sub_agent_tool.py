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
### SUB-AGENT CAPABILITIES

Sub-agents have ALL tools:
- Research: web_search, browser, scraping
- Visuals: image_generate, image_edit  
- Files: create_file, edit_file, code
- Presentations: create_slide, HTML/CSS
- Code: execute_command, dev tools

### TASK DESIGN

**1. DIVERSITY over QUANTITY**
- Don't spawn multiple agents for same work type
- Spawn agents for DIFFERENT types of tasks

**2. CONSOLIDATE similar work**
- Research = 1-2 agents (comprehensive)
- Images = 1 agent for all visuals
- Final output = 1 agent

### HANDLING DEPENDENCIES

**CRITICAL: Tasks that need outputs from other tasks require PHASES!**

**INDEPENDENT tasks** → spawn together
**DEPENDENT tasks** → spawn AFTER dependencies complete

**Example: Presentation with images**
```
# Phase 1: Independent work
spawn("Research topic. SAVE to /workspace/research/")
spawn("Generate images. SAVE to /workspace/images/")
wait_for_sub_agents()

# Phase 2: Dependent work (needs phase 1 outputs)
spawn("Create presentation. READ from /workspace/research/. EMBED images from /workspace/images/ as <img> tags. SAVE to /workspace/output/")
wait_for_sub_agents()
```

**WHY?** If you spawn presentation with research/images, it STARTS before they finish and WON'T use them!

### MAKING FILES USED

Be EXPLICIT about file usage in dependent tasks:
- "READ research from /workspace/research/data.md"
- "EMBED images from /workspace/images/*.png as <img src='...'>"
- "List all images and INCLUDE each in final output"

### FILE COORDINATION

Sub-agents share /workspace:
- Research: /workspace/research/
- Images: /workspace/images/
- Output: /workspace/output/

### VALIDATION LEVELS
- 1 = Basic (not broken)
- 2 = Good (addresses task)
- 3 = Top-notch (final deliverables)

### ANTI-PATTERNS
❌ Multiple agents for same task type
❌ Spawning dependent tasks with independent ones
❌ Huge context strings (use file paths)
❌ Assuming files will be used (be EXPLICIT!)
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

    @staticmethod
    def _get_validation_prompt(task: str, context: Optional[str], output: str, level: int) -> str:
        """Generate validation prompt based on strictness level (1-3)."""
        level_descriptions = {
            1: "BASIC (Level 1/3) - Pass if the output EXISTS and is not completely broken garbage. The bar is low: just needs to be functional output that somewhat relates to the task. Only fail if output is empty, nonsensical, or completely off-topic.",
            2: "GOOD (Level 2/3) - Pass if the output properly addresses the task with reasonable quality. Should cover the main requirements. Fail if there are significant gaps, major errors, or the task is only partially completed.",
            3: "TOP-NOTCH (Level 3/3) - Pass ONLY if the output is EXCELLENT and production-ready. Must be comprehensive, well-structured, accurate, and thoroughly address every aspect of the task. Be SUPER CRITICAL. Fail if anything is less than perfect."
        }
        
        level_desc = level_descriptions.get(level, level_descriptions[2])
        
        return f"""You are a quality evaluator for AI agent outputs. Evaluate if the sub-agent's output meets the required standard.

## TASK GIVEN TO SUB-AGENT:
{task}

{f"## ADDITIONAL CONTEXT PROVIDED:{chr(10)}{context}" if context else ""}

## SUB-AGENT'S OUTPUT:
{output}

## VALIDATION LEVEL: {level}/3
{level_desc}

## YOUR EVALUATION:
Analyze the output against the task requirements:
1. Does it accomplish what was asked?
2. Is the output complete or are there gaps?
3. Is the quality appropriate for validation level {level}?
4. Are there errors, hallucinations, or issues?

Respond in this EXACT JSON format:
{{
  "passed": true/false,
  "score": <1-10 numeric score>,
  "summary": "<one-line summary>",
  "issues": ["<issue 1>", "<issue 2>", ...],
  "feedback": "<specific feedback if retry needed>"
}}

{"Be lenient - only fail if output is garbage." if level == 1 else "Be balanced - fail if significant issues." if level == 2 else "Be SUPER CRITICAL - only pass if PERFECT."}"""""

    async def _run_validation(
        self, 
        task: str, 
        context: Optional[str], 
        output: str, 
        validation_level: int,
        account_id: str
    ) -> Dict[str, Any]:
        """
        Run LLM validation on sub-agent output.
        Returns: {"passed": bool, "score": int, "feedback": str, "issues": list}
        """
        try:
            import litellm
            from core.billing.credits import bill_llm_completion
            
            # Clamp validation level
            level = max(1, min(5, validation_level))
            
            # Generate validation prompt
            prompt = self._get_validation_prompt(task, context, output, level)
            
            # Use a fast, cheap model for validation
            validation_model = "openrouter/google/gemini-2.0-flash-001"
            
            logger.info(f"🔍 Running validation (level {level}) with {validation_model}")
            
            # Call LLM for validation
            response = await litellm.acompletion(
                model=validation_model,
                messages=[
                    {"role": "system", "content": "You are a critical quality evaluator. Respond only with valid JSON."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.1,  # Low temp for consistent evaluation
                max_tokens=1000,
                response_format={"type": "json_object"}
            )
            
            # Bill the user for validation call
            if response.usage:
                try:
                    client = await self.thread_manager.db.client
                    await bill_llm_completion(
                        client=client,
                        account_id=account_id,
                        model=validation_model,
                        input_tokens=response.usage.prompt_tokens,
                        output_tokens=response.usage.completion_tokens,
                        metadata={"type": "sub_agent_validation", "level": level}
                    )
                    logger.info(f"💰 Billed validation: {response.usage.prompt_tokens}+{response.usage.completion_tokens} tokens")
                except Exception as bill_err:
                    logger.warning(f"Failed to bill validation: {bill_err}")
            
            # Parse response
            result_text = response.choices[0].message.content
            try:
                result = json.loads(result_text)
            except json.JSONDecodeError:
                # Try to extract JSON from response
                import re
                json_match = re.search(r'\{[\s\S]*\}', result_text)
                if json_match:
                    result = json.loads(json_match.group())
                else:
                    logger.warning(f"Failed to parse validation response: {result_text[:200]}")
                    return {"passed": True, "score": 5, "feedback": "Validation parsing failed, assuming pass", "issues": []}
            
            return {
                "passed": result.get("passed", True),
                "score": result.get("score", 5),
                "summary": result.get("summary", ""),
                "issues": result.get("issues", []),
                "feedback": result.get("feedback", "")
            }
            
        except Exception as e:
            logger.error(f"Validation failed: {e}", exc_info=True)
            # On error, don't block - assume pass
            return {"passed": True, "score": 5, "feedback": f"Validation error: {str(e)}", "issues": []}

    async def _get_sub_agent_output(self, thread_id: str) -> str:
        """Get the sub-agent's output (last assistant messages)."""
        try:
            client = await self.thread_manager.db.client
            
            # Get last few assistant messages
            messages = await client.table('messages').select(
                'content, metadata'
            ).eq('thread_id', thread_id).eq('type', 'assistant').order('created_at', desc=True).limit(5).execute()
            
            if not messages.data:
                return ""
            
            output_parts = []
            for msg in reversed(messages.data):
                # Get text content
                text = None
                if msg.get('metadata') and isinstance(msg['metadata'], dict):
                    text = msg['metadata'].get('text_content')
                if not text and msg.get('content') and isinstance(msg['content'], dict):
                    text = msg['content'].get('content')
                if text:
                    output_parts.append(text)
            
            return "\n\n".join(output_parts)
            
        except Exception as e:
            logger.error(f"Failed to get sub-agent output: {e}")
            return ""

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "spawn_sub_agent",
            "description": "Spawn a sub-agent worker with ALL tools (web_search, image_generate, create_file, browser, etc). IMPORTANT: 1) Spawn DIVERSE task types, consolidate similar work. 2) For tasks that DEPEND on other outputs (like presentation needing research+images), spawn them in a SECOND phase after dependencies complete. 3) Be EXPLICIT about using files: 'EMBED images as <img> tags'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "Task description with output path. For DEPENDENT tasks that need files from other agents, be EXPLICIT: 'READ from /workspace/research/. EMBED images from /workspace/images/ as <img src=\"...\"> tags in HTML. SAVE to /workspace/output/'. One agent can handle comprehensive work!"
                    },
                    "context": {
                        "type": "string",
                        "description": "Optional context. Use file paths not content: 'Read from /workspace/research/*.md'"
                    },
                    "validation_level": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 3,
                        "description": "Quality validation: 1=basic, 2=good, 3=top-notch (final deliverables)."
                    }
                },
                "required": ["task"],
                "additionalProperties": False
            }
        }
    })
    async def spawn_sub_agent(self, task: str, context: Optional[str] = None, validation_level: Optional[int] = None) -> ToolResult:
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
            
            # Compose the sub-agent's instruction message with result format requirement
            result_format_instruction = """

---
⚠️ REQUIRED OUTPUT FORMAT:
When you complete this task, you MUST end your final message with a clear summary in this format:

## TASK RESULT
**Status:** [Completed/Failed]
**Files Created:** [List any files you created with full paths]
**Summary:** [2-3 sentence summary of what you accomplished]
"""
            
            instruction = task + result_format_instruction
            if context:
                instruction = f"{task}\n\n---\nContext:\n{context}{result_format_instruction}"
            
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
                "actual_user_id": account_id,
                "validation_level": validation_level if validation_level and 1 <= validation_level <= 3 else None,
                "validation_attempts": 0,
                "full_context": context[:2000] if context else None  # Store for validation
            }
            
            await client.table('agent_runs').insert({
                "id": agent_run_id,
                "thread_id": sub_thread_id,
                "status": "pending",  # Will become "running" when worker picks it up
                "started_at": datetime.now(timezone.utc).isoformat(),
                "metadata": run_metadata
            }).execute()
            
            # Queue the sub-agent execution via Redis Streams
            try:
                from core.worker.dispatcher import dispatch_agent_run
                from core.ai_models import model_manager
                
                # Generate a unique instance_id for this sub-agent run
                # Each sub-agent gets its own instance to avoid conflicts
                sub_instance_id = f"sub-{str(uuid.uuid4())[:8]}"
                
                # Get the user's default model (same model resolution as parent)
                effective_model = await model_manager.get_default_model_for_user(client, account_id)
                logger.info(f"Sub-agent will use model: {effective_model}")
                
                await dispatch_agent_run(
                    agent_run_id=agent_run_id,
                    thread_id=sub_thread_id,
                    instance_id=sub_instance_id,
                    project_id=self.project_id,
                    model_name=effective_model,
                    agent_id=None,
                    account_id=account_id,
                )
            except Exception as e:
                logger.error(f"Failed to queue sub-agent execution: {e}", exc_info=True)
                # Clean up the created thread and agent_run
                await client.table('agent_runs').delete().eq('id', agent_run_id).execute()
                await client.table('threads').delete().eq('thread_id', sub_thread_id).execute()
                return ToolResult(success=False, output=f"Failed to queue sub-agent: {str(e)}")
            
            validation_info = ""
            if validation_level and 1 <= validation_level <= 3:
                validation_info = f" with quality validation (level {validation_level}/3)"
                logger.info(f"🚀 Spawned sub-agent {agent_run_id}{validation_info} for task: {task[:100]}...")
            else:
                logger.info(f"🚀 Spawned sub-agent {agent_run_id} for task: {task[:100]}...")
            
            result_data = {
                "sub_agent_id": agent_run_id,
                "thread_id": sub_thread_id,
                "task": task[:200],
                "status": "spawned",
                "message": f"Sub-agent spawned successfully{validation_info}. Use list_sub_agents to track progress."
            }
            
            if validation_level and 1 <= validation_level <= 3:
                result_data["validation"] = {
                    "enabled": True,
                    "level": validation_level,
                    "description": {
                        1: "Basic - has output, not broken",
                        2: "Good - properly addresses task",
                        3: "Top-notch - perfect, production-ready"
                    }.get(validation_level, "Unknown")
                }
            
            return ToolResult(
                success=True,
                output=json.dumps(result_data, indent=2)
            )
            
        except Exception as e:
            logger.error(f"Failed to spawn sub-agent: {e}", exc_info=True)
            return ToolResult(success=False, output=f"Failed to spawn sub-agent: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_sub_agents",
            "description": "List all sub-agents with status. Use for ONE-TIME status check, NOT for polling loops. For waiting, use wait_for_sub_agents instead. No parameters needed.",
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
                
                sa_info = {
                    "sub_agent_id": run.get('id'),
                    "thread_id": tid,
                    "task": metadata.get('task_description', thread.get('name', 'Unknown task')),
                    "status": run.get('status', 'unknown'),
                    "started_at": run.get('started_at'),
                    "completed_at": run.get('completed_at'),
                    "error": run.get('error')
                }
                
                # Include validation info if configured
                validation_level = metadata.get('validation_level')
                if validation_level:
                    sa_info["validation"] = {
                        "level": validation_level,
                        "attempts": metadata.get('validation_attempts', 0),
                        "last_result": metadata.get('last_validation_result')
                    }
                
                sub_agents.append(sa_info)
            
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
            ).eq('thread_id', thread_id).eq('type', 'assistant').order('created_at', desc=True).limit(5).execute()
            
            # Extract text content and attachments, looking for structured TASK RESULT
            all_text = []
            attachments = []
            task_result_section = None
            
            for msg in reversed(messages_result.data or []):
                content = msg.get('content', {})
                if isinstance(content, dict):
                    text = content.get('content', '')
                elif isinstance(content, str):
                    text = content
                else:
                    text = str(content)
                
                # Also check metadata for text_content and attachments
                metadata = msg.get('metadata', {}) or {}
                if isinstance(metadata, str):
                    try:
                        metadata = json.loads(metadata)
                    except:
                        metadata = {}
                
                text_content = metadata.get('text_content', '')
                full_text = (text_content or text).strip()
                
                if full_text:
                    all_text.append(full_text)
                    
                    # Look for structured TASK RESULT section
                    if '## TASK RESULT' in full_text or '**Status:**' in full_text:
                        # Extract the task result section
                        if '## TASK RESULT' in full_text:
                            idx = full_text.find('## TASK RESULT')
                            task_result_section = full_text[idx:].strip()
                        elif '**Status:**' in full_text:
                            # Try to extract from Status onwards
                            lines = full_text.split('\n')
                            result_lines = []
                            capturing = False
                            for line in lines:
                                if '**Status:**' in line or capturing:
                                    capturing = True
                                    result_lines.append(line)
                            if result_lines:
                                task_result_section = '\n'.join(result_lines).strip()
                
                # Collect any attachments mentioned
                msg_attachments = metadata.get('attachments', [])
                if msg_attachments:
                    if isinstance(msg_attachments, str):
                        try:
                            msg_attachments = json.loads(msg_attachments)
                        except:
                            pass
                    if isinstance(msg_attachments, list):
                        attachments.extend(msg_attachments)
            
            task_description = (run.get('metadata') or {}).get('task_description', 'Unknown task')
            
            # Use structured TASK RESULT if found, otherwise fall back
            if task_result_section:
                result_text = task_result_section
            elif all_text:
                # Use only the last meaningful message (not all of them)
                result_text = all_text[-1] if all_text else ""
                # Truncate if too long (keep last 500 chars)
                if len(result_text) > 500:
                    result_text = "..." + result_text[-500:]
            else:
                result_text = ""
            
            # If no text but we have attachments, mention them
            if not result_text and attachments:
                result_text = f"Task completed. Created {len(attachments)} file(s): {', '.join(attachments)}"
            elif not result_text:
                result_text = "Task completed successfully (no detailed output captured)"
            
            # Append file paths if available and not already in result
            if attachments and 'Files Created:' not in result_text:
                result_text += f"\n\n📁 Files: {', '.join(attachments)}"
            
            return ToolResult(
                success=True,
                output=json.dumps({
                    "sub_agent_id": sub_agent_id,
                    "thread_id": thread_id,
                    "task": task_description,
                    "status": status,
                    "error": run.get('error'),
                    "result": result_text,
                    "attachments": attachments if attachments else None,
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
            "description": "🚨 USE THIS instead of manual wait+list_sub_agents polling! Efficiently waits for sub-agents to complete. Blocks until all finish (or timeout). Call ONCE after spawning all sub-agents - don't poll manually. If no IDs specified, waits for ALL sub-agents. **PARAMS**: `sub_agent_ids` (optional array), `timeout_seconds` (optional, default 300).",
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
                    # 'completed' is the normal success status; 'stopped' for legacy/awaiting input
                    successful = sum(1 for r in results if r['status'] in ('completed', 'stopped'))
                    failed = sum(1 for r in results if r['status'] == 'failed')
                    
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

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "continue_sub_agent",
            "description": "Send a follow-up message to an existing sub-agent to continue or refine its work. Only works with sub-agents that have completed (not running). **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `sub_agent_id` (REQUIRED), `message` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "sub_agent_id": {
                        "type": "string",
                        "description": "**REQUIRED** - The sub_agent_id of the sub-agent to continue."
                    },
                    "message": {
                        "type": "string",
                        "description": "**REQUIRED** - The follow-up message/instruction for the sub-agent."
                    }
                },
                "required": ["sub_agent_id", "message"],
                "additionalProperties": False
            }
        }
    })
    async def continue_sub_agent(self, sub_agent_id: str, message: str) -> ToolResult:
        """Send a follow-up message to an existing sub-agent."""
        try:
            client = await self.thread_manager.db.client
            
            # Get the agent run to find the thread
            run_result = await client.table('agent_runs').select(
                'id, thread_id, status'
            ).eq('id', sub_agent_id).maybe_single().execute()
            
            if not run_result.data:
                return ToolResult(success=False, output=f"Sub-agent {sub_agent_id} not found")
            
            run = run_result.data
            sub_thread_id = run['thread_id']
            status = run['status']
            
            # Check if sub-agent is already running
            if status in ('pending', 'running', 'queued'):
                return ToolResult(
                    success=False,
                    output=f"Sub-agent is still {status}. Wait for it to complete before sending follow-up."
                )
            
            # Verify this is actually a child thread of current thread
            thread_result = await client.table('threads').select(
                'parent_thread_id, account_id'
            ).eq('thread_id', sub_thread_id).maybe_single().execute()
            
            if not thread_result.data or thread_result.data.get('parent_thread_id') != self.thread_id:
                return ToolResult(
                    success=False,
                    output="Cannot continue this sub-agent - it was not spawned from this thread."
                )
            
            account_id = thread_result.data.get('account_id')
            
            # Add the follow-up message to the sub-agent thread
            await client.table('messages').insert({
                "message_id": str(uuid.uuid4()),
                "thread_id": sub_thread_id,
                "type": "user",
                "is_llm_message": True,
                "content": {"role": "user", "content": message},
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()
            
            # Create new agent run
            new_run_id = str(uuid.uuid4())
            run_metadata = {
                "task_description": f"Follow-up: {message[:200]}",
                "parent_thread_id": self.thread_id,
                "spawned_as_sub_agent": True,
                "continued_from": sub_agent_id,
                "actual_user_id": account_id
            }
            
            await client.table('agent_runs').insert({
                "id": new_run_id,
                "thread_id": sub_thread_id,
                "status": "pending",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "metadata": run_metadata
            }).execute()
            
            # Queue the execution
            try:
                from core.worker.dispatcher import dispatch_agent_run
                from core.ai_models import model_manager
                
                sub_instance_id = f"sub-cont-{str(uuid.uuid4())[:8]}"
                effective_model = await model_manager.get_default_model_for_user(client, account_id)
                
                await dispatch_agent_run(
                    agent_run_id=new_run_id,
                    thread_id=sub_thread_id,
                    instance_id=sub_instance_id,
                    project_id=self.project_id,
                    model_name=effective_model,
                    agent_id=None,
                    account_id=account_id,
                )
            except Exception as e:
                logger.error(f"Failed to queue sub-agent continuation: {e}", exc_info=True)
                await client.table('agent_runs').delete().eq('id', new_run_id).execute()
                return ToolResult(success=False, output=f"Failed to queue continuation: {str(e)}")
            
            logger.info(f"🔄 Continued sub-agent {sub_agent_id} with new run {new_run_id}")
            
            return ToolResult(
                success=True,
                output=json.dumps({
                    "sub_agent_id": new_run_id,
                    "thread_id": sub_thread_id,
                    "previous_run_id": sub_agent_id,
                    "message": message[:200],
                    "status": "continued",
                    "info": "Follow-up sent. Use list_sub_agents or get_sub_agent_result to track progress."
                }, indent=2)
            )
            
        except Exception as e:
            logger.error(f"Failed to continue sub-agent: {e}", exc_info=True)
            return ToolResult(success=False, output=f"Failed to continue sub-agent: {str(e)}")

