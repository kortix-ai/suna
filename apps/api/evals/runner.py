"""
Agent Evaluation Runner.

Provides utilities to run agent tasks for evaluation purposes.
Integrates with the existing agent system and Braintrust.
"""

import os
import asyncio
import json
from typing import Any, Dict, List, Optional, Callable, Union
from dataclasses import dataclass, field
from datetime import datetime

import braintrust
from braintrust import Eval, init_logger

# Load config FIRST to get env vars
from core.utils.config import config
from core.utils.logger import logger


@dataclass
class EvalCase:
    """A single evaluation test case."""
    input: str  # User message/prompt
    expected: Optional[str] = None  # Expected output (for exact match)
    expected_tools: Optional[List[str]] = None  # Expected tools to be called
    expected_behavior: Optional[str] = None  # Description of expected behavior (for LLM judge)
    metadata: Dict[str, Any] = field(default_factory=dict)
    tags: List[str] = field(default_factory=list)


@dataclass 
class EvalResult:
    """Result from running an eval case."""
    input: str
    output: str
    expected: Optional[str]
    tools_called: List[str]
    messages: List[Dict[str, Any]]
    duration_ms: float
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    # LLM metrics for Braintrust
    llm_calls: int = 0
    tool_calls: int = 0
    errors: int = 0
    llm_errors: int = 0
    tool_errors: int = 0
    prompt_tokens: int = 0
    prompt_cached_tokens: int = 0
    prompt_cache_creation_tokens: int = 0
    completion_tokens: int = 0
    completion_reasoning_tokens: int = 0
    total_tokens: int = 0
    time_to_first_token_ms: Optional[float] = None
    llm_duration_ms: Optional[float] = None
    estimated_cost: Optional[float] = None


class AgentEvalRunner:
    """
    Runs agent evaluations with Braintrust integration.
    
    This runner:
    1. Creates isolated test threads for each eval case
    2. Runs the agent to completion
    3. Collects outputs and metadata
    4. Integrates with Braintrust for tracking
    """
    
    def __init__(
        self,
        project_name: str = "Kortix Agent",
        model_name: Optional[str] = "kortix/basic",
        max_iterations: int = 50,
        timeout_seconds: float = 120.0,
        project_id: Optional[str] = None,  # Optional project with sandbox for tool access
    ):
        self.project_name = project_name
        self.model_name = model_name or "kortix/basic"  # Fallback to default
        self.max_iterations = max_iterations
        self.timeout_seconds = timeout_seconds
        self.project_id = project_id or os.getenv("EVAL_PROJECT_ID")  # Use env var if not specified
        self._current_project_id: Optional[str] = None  # Set per-case
        self.test_account_id: Optional[str] = None
        self._test_user_initialized = False
        
        if self.project_id:
            logger.info(f"🔧 Using existing project {self.project_id} for evals")
        else:
            logger.info(f"🔧 Will create new project per eval case (sandbox tools enabled)")
        
        # Speed up evals by disabling expensive features
        os.environ["EVAL_MODE"] = "true"
        os.environ["SKIP_MEMORY_RETRIEVAL"] = "true"
        os.environ["SKIP_ENRICHMENT"] = "true"  # Skip Phase B enrichment
        
        # Initialize Braintrust logger if API key is set
        if os.getenv("BRAINTRUST_API_KEY"):
            self.bt_logger = init_logger(project=project_name)
        else:
            self.bt_logger = None
            logger.warning("BRAINTRUST_API_KEY not set - evals will run locally only")
    
    async def _ensure_test_user(self) -> str:
        """
        Ensure test user exists and return their ID.
        
        For evals, we simply use SYSTEM_ADMIN_USER_ID from config.
        
        Returns:
            user_id: UUID of the test user
        """
        if self._test_user_initialized and self.test_account_id:
            return self.test_account_id
        
        from core.utils.config import config
        
        # For evals, just use the system admin user
        if hasattr(config, 'SYSTEM_ADMIN_USER_ID') and config.SYSTEM_ADMIN_USER_ID:
            self.test_account_id = config.SYSTEM_ADMIN_USER_ID
            self._test_user_initialized = True
            logger.info(f"✅ Using SYSTEM_ADMIN_USER_ID for evals: {self.test_account_id}")
            return self.test_account_id
        
        raise ValueError(
            "SYSTEM_ADMIN_USER_ID not set in config. "
            "Please set SYSTEM_ADMIN_USER_ID in your .env file."
        )
    
    async def run_case(self, case: EvalCase) -> EvalResult:
        """
        Run a single evaluation case through the agent.
        
        Creates an isolated thread, sends the input, runs the agent,
        and collects the output.
        """
        from core.agentpress.thread_manager import ThreadManager
        from core.agents.runner import run_agent
        
        start_time = datetime.now()
        tools_called = []
        messages = []
        output = ""
        error = None
        thread_id = None  # Initialize to None in case thread creation fails
        first_token_time = None
        llm_total_time = 0.0
        
        # Track LLM usage from streaming chunks
        usage_data = {
            'llm_calls': 0,
            'prompt_tokens': 0,
            'completion_tokens': 0,
            'total_tokens': 0,
            'cached_tokens': 0,
            'cache_creation_tokens': 0,
            'reasoning_tokens': 0,
        }
        
        try:
            # Ensure test user exists
            account_id = await self._ensure_test_user()
            
            # Create project if not provided (needed for sandbox tools like web_search)
            project_id = self.project_id
            if not project_id:
                from core.services.supabase import DBConnection
                from datetime import timezone
                import uuid
                
                db = DBConnection()
                client = await db.client
                
                project_id = str(uuid.uuid4())
                placeholder_name = f"[Eval] {case.input[:30]}..." if len(case.input) > 30 else f"[Eval] {case.input}"
                
                await client.table('projects').insert({
                    "project_id": project_id,
                    "account_id": account_id,
                    "name": placeholder_name,
                    "created_at": datetime.now(timezone.utc).isoformat()
                }).execute()
                
                logger.info(f"✅ Created eval project: {project_id}")
            
            # Store for use in run_agent
            self._current_project_id = project_id
            
            # Create isolated thread manager for this eval
            thread_manager = ThreadManager(account_id=account_id)
            
            # Create a new thread for this test case (linked to project)
            try:
                from core.services.supabase import DBConnection
                import uuid
                
                db = DBConnection()
                client = await db.client
                
                thread_id = str(uuid.uuid4())
                await client.table('threads').insert({
                    "thread_id": thread_id,
                    "project_id": project_id,
                    "account_id": account_id,
                    "name": "Eval Test",
                    "created_at": datetime.now(timezone.utc).isoformat()
                }).execute()
                
                logger.info(f"✅ Created eval thread: {thread_id} (project: {project_id})")
            except Exception as e:
                error = f"Thread creation failed: {e}"
                logger.error(f"❌ Thread creation failed: {e}")
                raise
            
            # Add user message
            logger.error(f"📝 [{thread_id[:8]}] Adding message to thread...")
            await thread_manager.add_message(
                thread_id=thread_id,
                type="user",
                content={"role": "user", "content": case.input},
                is_llm_message=True
            )
            logger.error(f"✅ [{thread_id[:8]}] Message added successfully")
            
            # Create cancellation event with timeout
            cancellation_event = asyncio.Event()
            logger.error(f"⏰ [{thread_id[:8]}] Created cancellation event with {self.timeout_seconds}s timeout")
            
            async def timeout_handler():
                logger.error(f"⏰ [{thread_id[:8]}] Timeout handler sleeping for {self.timeout_seconds}s...")
                await asyncio.sleep(self.timeout_seconds)
                logger.error(f"⏰ [{thread_id[:8]}] TIMEOUT TRIGGERED! Setting cancellation event")
                cancellation_event.set()
            
            timeout_task = asyncio.create_task(timeout_handler())
            logger.error(f"✅ [{thread_id[:8]}] Timeout task created")
            
            try:
                logger.error(f"🚀 [{thread_id[:8]}] CALLING run_agent() now... timeout={self.timeout_seconds}s, max_iterations={self.max_iterations}")
                chunk_count = 0
                chunk_start_time = asyncio.get_event_loop().time()
                llm_start_time = None
                
                # Run agent and collect response
                logger.error(f"🔄 [{thread_id[:8]}] About to enter async for loop...")
                async for chunk in run_agent(
                    thread_id=thread_id,
                    project_id=self._current_project_id,  # Use project for sandbox tools (web_search, etc.)
                    max_iterations=self.max_iterations,
                    model_name=self.model_name,
                    cancellation_event=cancellation_event,
                    account_id=account_id,
                ):
                    chunk_count += 1
                    elapsed = asyncio.get_event_loop().time() - chunk_start_time
                    
                    if chunk_count == 1:
                        logger.error(f"✅ [{thread_id[:8]}] GOT FIRST CHUNK! Loop started successfully")
                    
                    if chunk_count % 10 == 0:  # Log every 10 chunks
                        logger.warning(f"⏳ [{thread_id[:8]}] Chunk {chunk_count} at {elapsed:.1f}s - output so far: {len(output)} chars, tools: {len(tools_called)}")
                    
                    if isinstance(chunk, dict):
                        chunk_type = chunk.get('type')
                        
                        # Track time to first token (first content chunk)
                        if first_token_time is None and chunk_type == 'content' and chunk.get('content'):
                            first_token_time = elapsed
                            logger.error(f"⚡ [{thread_id[:8]}] First token at {first_token_time:.2f}s")
                        
                        # Track LLM call timing (status marks start of LLM call, assistant marks completion)
                        if chunk_type == 'status':
                            if llm_start_time is None:
                                llm_start_time = elapsed
                        elif chunk_type == 'assistant':
                            if llm_start_time is not None:
                                llm_total_time += (elapsed - llm_start_time)
                                llm_start_time = None
                        
                        # Log important chunks
                        if chunk_type in ('status', 'assistant', 'tool_call', 'error'):
                            logger.warning(f"📦 [{thread_id[:8]}] Chunk #{chunk_count}: {chunk_type}")
                        
                        # Collect text content from streaming chunks
                        if chunk_type == 'content':
                            content_text = chunk.get('content', '')
                            if isinstance(content_text, str):
                                output += content_text
                        elif chunk_type == 'assistant':
                            # Assistant messages - extract the text content
                            content = chunk.get('content', '')
                            if isinstance(content, str) and content.strip():
                                output += content
                            elif isinstance(content, dict):
                                # Content might be structured
                                text = content.get('text', content.get('message', ''))
                                if text:
                                    output += text
                        
                        # Track tool calls
                        if chunk_type == 'tool_call':
                            tool_name = chunk.get('name', chunk.get('function', {}).get('name'))
                            if tool_name:
                                tools_called.append(tool_name)
                        
                        # Collect full messages and extract usage
                        elif chunk_type in ('assistant', 'tool'):
                            messages.append(chunk)
                            
                            # Try to extract usage from assistant messages (only if chunk is a dict)
                            if chunk_type == 'assistant' and isinstance(chunk, dict):
                                metadata = chunk.get('metadata', {})
                                if isinstance(metadata, dict):
                                    usage = metadata.get('usage', {})
                                    if usage and isinstance(usage, dict):
                                        usage_data['llm_calls'] += 1
                                        usage_data['prompt_tokens'] += usage.get('prompt_tokens', 0)
                                        usage_data['completion_tokens'] += usage.get('completion_tokens', 0)
                                        usage_data['total_tokens'] += usage.get('total_tokens', 0)
                                        
                                        prompt_details = usage.get('prompt_tokens_details', {})
                                        if isinstance(prompt_details, dict):
                                            usage_data['cached_tokens'] += prompt_details.get('cached_tokens', 0)
                                            usage_data['cache_creation_tokens'] += prompt_details.get('cache_creation_tokens', 0)
                                        
                                        completion_details = usage.get('completion_tokens_details', {})
                                        if isinstance(completion_details, dict):
                                            usage_data['reasoning_tokens'] += completion_details.get('reasoning_tokens', 0)
                                        
                                        logger.debug(f"✅ Captured usage from chunk: prompt={usage.get('prompt_tokens')}, completion={usage.get('completion_tokens')}, cached={prompt_details.get('cached_tokens', 0) if isinstance(prompt_details, dict) else 0}")
                            
            except asyncio.TimeoutError:
                error = f"Timeout after {self.timeout_seconds}s"
                logger.error(f"⏰ TIMEOUT [{thread_id[:8]}] after {self.timeout_seconds}s! Chunks: {chunk_count}, Output: {len(output)} chars, Tools: {tools_called}")
            finally:                
                logger.warning(f"✅ Agent finished [{thread_id[:8]}] - {chunk_count} chunks, {len(output)} chars output, {len(tools_called)} tools")

                timeout_task.cancel()
                try:
                    await timeout_task
                except asyncio.CancelledError:
                    pass
            
            # Get final conversation for analysis
            try:
                # Query ALL messages from database to extract LLM usage metrics
                client = await thread_manager.db.client
                all_messages_result = await client.table('messages').select('*').eq('thread_id', thread_id).order('created_at').execute()
                all_messages_db = all_messages_result.data if all_messages_result and all_messages_result.data else []
                
                # Extract usage from llm_response_end messages and tools from tool_call messages
                for msg in all_messages_db:
                    msg_type = msg.get('type')
                    
                    # Track tool calls
                    if msg_type == 'tool_call':
                        content = msg.get('content')
                        if isinstance(content, dict):
                            tool_name = content.get('name', content.get('function', {}).get('name'))
                            if tool_name and tool_name not in tools_called:
                                tools_called.append(tool_name)
                    
                    # Also check assistant messages for tool_calls in metadata
                    if msg_type == 'assistant':
                        metadata = msg.get('metadata', {})
                        if isinstance(metadata, dict):
                            msg_tool_calls = metadata.get('tool_calls', [])
                            for tc in msg_tool_calls:
                                if isinstance(tc, dict):
                                    tool_name = tc.get('function_name') or tc.get('name') or (tc.get('function', {}) or {}).get('name')
                                    if tool_name and tool_name not in tools_called:
                                        tools_called.append(tool_name)
                    
                    if msg_type == 'llm_response_end':
                        # Usage data is in content.usage (content is the full LiteLLM response object)
                        content = msg.get('content')
                        usage = content.get('usage', {}) if isinstance(content, dict) else {}
                        
                        if usage:
                            usage_data['llm_calls'] += 1
                            usage_data['prompt_tokens'] += usage.get('prompt_tokens', 0)
                            usage_data['completion_tokens'] += usage.get('completion_tokens', 0)
                            usage_data['total_tokens'] += usage.get('total_tokens', 0)
                            
                            prompt_details = usage.get('prompt_tokens_details', {})
                            if isinstance(prompt_details, dict):
                                usage_data['cached_tokens'] += prompt_details.get('cached_tokens', 0)
                                usage_data['cache_creation_tokens'] += prompt_details.get('cache_creation_tokens', 0)
                            
                            completion_details = usage.get('completion_tokens_details', {})
                            if isinstance(completion_details, dict):
                                usage_data['reasoning_tokens'] += completion_details.get('reasoning_tokens', 0)
                
                logger.info(f"📊 [{thread_id[:8]}] Extracted {len(tools_called)} tools from DB: {tools_called}")
                
                # Now get user-facing messages for output extraction
                final_messages = await thread_manager.get_llm_messages(thread_id)
                messages = final_messages
                
                # ALWAYS try to extract clean output from complete/ask tool calls
                # The streaming output is often raw JSON chunks, but tool calls have the actual answer
                clean_output = ""
                for msg in reversed(final_messages):
                    if msg.get('role') == 'assistant':
                        metadata = msg.get('metadata', {})
                        if isinstance(metadata, dict):
                            tool_calls = metadata.get('tool_calls', [])
                            for tool_call in tool_calls:
                                if isinstance(tool_call, dict):
                                    func_name = tool_call.get('function', {}).get('name', '') or tool_call.get('function_name', '')
                                    if func_name in ('ask', 'complete'):
                                        args = tool_call.get('function', {}).get('arguments', {}) or tool_call.get('arguments', {})
                                        if isinstance(args, str):
                                            try:
                                                args = json.loads(args)
                                            except:
                                                pass
                                        if isinstance(args, dict):
                                            clean_output = args.get('text', args.get('message', ''))
                                            if clean_output:
                                                logger.warning(f"✅ [{thread_id[:8]}] Extracted CLEAN output from {func_name}: {len(clean_output)} chars")
                                                break
                            if clean_output:
                                break
                
                # Use clean output if we got it, otherwise fall back to streaming output
                if clean_output:
                    output = clean_output
                
                # Extract output from final assistant message if we still don't have it
                if not output and final_messages:
                    for msg in reversed(final_messages):
                        if msg.get('role') == 'assistant':
                            # First try direct content
                            content = msg.get('content', '')
                            if isinstance(content, str) and content.strip():
                                output = content
                                logger.warning(f"✅ [{thread_id[:8]}] Extracted output from assistant content: {len(output)} chars")
                                break
                            elif isinstance(content, list):
                                # Handle content array format
                                text_parts = [
                                    item.get('text', '') if isinstance(item, dict) else str(item)
                                    for item in content if item
                                ]
                                if text_parts:
                                    output = ' '.join(text_parts)
                                    logger.warning(f"✅ [{thread_id[:8]}] Extracted output from assistant content array: {len(output)} chars")
                                    break
                    
                    # If no content, look for tool calls in assistant messages
                    if not output:
                        logger.warning(f"🔍 [{thread_id[:8]}] No output from content, checking tool results...")
                        for msg in reversed(final_messages):
                            if msg.get('role') == 'tool':
                                # Get content from tool result (this has the final displayed text)
                                content = msg.get('content', '')
                                if isinstance(content, str):
                                    try:
                                        import json
                                        content_dict = json.loads(content)
                                        if isinstance(content_dict, dict):
                                            # Look for text in the tool result
                                            output = content_dict.get('text', content_dict.get('message', ''))
                                    except:
                                        # If not JSON, use as-is
                                        if content.strip():
                                            output = content
                                if output:
                                    break
                        
                        # Still no output? Check tool calls in assistant messages
                        if not output:
                            for msg in reversed(final_messages):
                                if msg.get('role') == 'assistant':
                                    # Check metadata for tool_calls
                                    metadata = msg.get('metadata', {})
                                    tool_calls = metadata.get('tool_calls', [])
                                    
                                    for tool_call in tool_calls:
                                        if isinstance(tool_call, dict):
                                            func_name = tool_call.get('function', {}).get('name', '')
                                            if func_name in ('ask', 'complete'):
                                                # Extract text from ask/complete tool
                                                args = tool_call.get('function', {}).get('arguments', {})
                                                if isinstance(args, str):
                                                    try:
                                                        import json
                                                        args = json.loads(args)
                                                    except:
                                                        pass
                                                if isinstance(args, dict):
                                                    output = args.get('text', args.get('message', ''))
                                                if output:
                                                    logger.warning(f"✅ [{thread_id[:8]}] Extracted output from {func_name} tool call: {len(output)} chars")
                                                    break
                                    if output:
                                        break
                    
                    if not output:
                        logger.error(f"❌ [{thread_id[:8]}] FAILED to extract any output from {len(final_messages)} messages!")
                            
            except Exception as e:
                logger.warning(f"Failed to get final messages: {e}")
                
        except Exception as e:
            error = str(e)
            logger.error(f"Eval case failed: {e}")
        
        duration_ms = (datetime.now() - start_time).total_seconds() * 1000
        
        # Use usage data collected during streaming, or fall back to extracting from messages
        llm_calls = usage_data.get('llm_calls', 0)
        prompt_tokens = usage_data.get('prompt_tokens', 0)
        completion_tokens = usage_data.get('completion_tokens', 0)
        total_tokens = usage_data.get('total_tokens', 0)
        prompt_cached_tokens_val = usage_data.get('cached_tokens', 0)
        prompt_cache_creation_tokens_val = usage_data.get('cache_creation_tokens', 0)
        completion_reasoning_tokens_val = usage_data.get('reasoning_tokens', 0)
        
        # Count errors from messages
        tool_calls_count = len(tools_called)
        errors_count = 1 if error else 0
        llm_errors = 0
        tool_errors = 0
        
        for msg in messages:
            # Check for errors in assistant message
            if msg.get('role') == 'assistant':
                metadata = msg.get('metadata', {})
                if metadata.get('error') or 'error' in str(msg.get('content', ''))[:100].lower():
                    llm_errors += 1
            
            # Count tool errors
            elif msg.get('role') == 'tool':
                content = msg.get('content', '')
                if isinstance(content, str) and ('error' in content.lower() or 'failed' in content.lower()):
                    tool_errors += 1
        
        # Estimate cost (rough approximation: $0.3/M input, $1.2/M output for minimax)
        # Adjust based on your actual model pricing
        input_cost = (prompt_tokens / 1_000_000) * 0.3
        output_cost = (completion_tokens / 1_000_000) * 1.2
        cache_read_cost = (prompt_cached_tokens_val / 1_000_000) * 0.03  # 10% of input cost
        estimated_cost_val = input_cost + output_cost + cache_read_cost
        
        # Convert timing to milliseconds
        time_to_first_token_ms_val = (first_token_time * 1000) if first_token_time else None
        llm_duration_ms_val = (llm_total_time * 1000) if llm_total_time > 0 else None
        
        # Final summary log
        thread_label = thread_id[:8] if thread_id else "NO_THREAD"
        logger.error(f"📊 FINAL RESULT [{thread_label}]: output={len(output)} chars, tools={tool_calls_count}, error={error}, duration={duration_ms:.0f}ms")
        logger.error(f"📊 LLM METRICS: calls={llm_calls}, tokens={total_tokens} (prompt={prompt_tokens}, completion={completion_tokens}, reasoning={completion_reasoning_tokens_val})")
        logger.error(f"📊 CACHE: read={prompt_cached_tokens_val}, write={prompt_cache_creation_tokens_val} | cost=${estimated_cost_val:.4f}")
        if time_to_first_token_ms_val:
            logger.error(f"⚡ TIMING: first_token={time_to_first_token_ms_val:.0f}ms, llm_duration={llm_duration_ms_val:.0f}ms" if llm_duration_ms_val else f"⚡ TIMING: first_token={time_to_first_token_ms_val:.0f}ms")
        if output:
            logger.error(f"📝 Output preview: {output[:200]}...")
        elif error:
            logger.error(f"❌ Error details: {error}")
        
        return EvalResult(
            input=case.input,
            output=output.strip() if output else "",
            expected=case.expected,
            tools_called=list(set(tools_called)),  # Dedupe
            messages=messages,
            duration_ms=duration_ms,
            error=error,
            metadata={
                "expected_tools": case.expected_tools,
                "expected_behavior": case.expected_behavior,
                **case.metadata,
            },
            llm_calls=llm_calls,
            tool_calls=tool_calls_count,
            errors=errors_count,
            llm_errors=llm_errors,
            tool_errors=tool_errors,
            prompt_tokens=prompt_tokens,
            prompt_cached_tokens=prompt_cached_tokens_val,
            prompt_cache_creation_tokens=prompt_cache_creation_tokens_val,
            completion_tokens=completion_tokens,
            completion_reasoning_tokens=completion_reasoning_tokens_val,
            total_tokens=total_tokens,
            time_to_first_token_ms=time_to_first_token_ms_val,
            llm_duration_ms=llm_duration_ms_val,
            estimated_cost=estimated_cost_val,
        )
    
    async def run_dataset(
        self,
        cases: List[EvalCase],
        experiment_name: Optional[str] = None,
    ) -> List[EvalResult]:
        """
        Run multiple evaluation cases.
        
        Args:
            cases: List of eval cases to run
            experiment_name: Optional name for the Braintrust experiment
            
        Returns:
            List of evaluation results
        """
        results = []
        
        for i, case in enumerate(cases):
            logger.info(f"Running eval case {i+1}/{len(cases)}: {case.input[:50]}...")
            result = await self.run_case(case)
            results.append(result)
            
            if result.error:
                logger.warning(f"Case {i+1} had error: {result.error}")
        
        return results


def create_agent_task(
    model_name: Optional[str] = None,
    max_iterations: int = 50,
    timeout_seconds: float = 120.0,
    project_id: Optional[str] = None,
) -> Callable:
    """
    Create a task function for Braintrust Eval.
    
    This wraps the agent runner into a simple function that takes
    an input string and returns an output string.
    
    Args:
        model_name: LLM model to use
        max_iterations: Maximum agent loop iterations
        timeout_seconds: Timeout per test case
        project_id: Optional project ID with sandbox (enables web_search, file tools, etc.)
                   Create a project in the web UI first to get a project ID.
    
    Usage with Braintrust:
        from braintrust import Eval
        from evals.runner import create_agent_task
        
        Eval(
            "Kortix Agent",
            data=lambda: [...],
            task=create_agent_task(project_id="your-project-id"),  # Enable sandbox tools
            scores=[...],
        )
    """
    # Store config - create fresh runner per task to avoid shared async state
    _config = {
        "model_name": model_name,
        "max_iterations": max_iterations,
        "timeout_seconds": timeout_seconds,
        "project_id": project_id,
    }
    
    async def task(input_data: Union[str, Dict]) -> Dict[str, Any]:
        """Run agent and return structured result."""
        # Create FRESH runner for each task to avoid event loop contamination
        runner = AgentEvalRunner(
            model_name=_config["model_name"],
            max_iterations=_config["max_iterations"],
            timeout_seconds=_config["timeout_seconds"],
            project_id=_config["project_id"],
        )
        
        # Handle both string and dict inputs
        if isinstance(input_data, dict):
            user_input = input_data.get("input", input_data.get("message", str(input_data)))
            expected_tools = input_data.get("expected_tools")
            expected_behavior = input_data.get("expected_behavior")
        else:
            user_input = str(input_data)
            expected_tools = None
            expected_behavior = None
        
        case = EvalCase(
            input=user_input,
            expected_tools=expected_tools,
            expected_behavior=expected_behavior,
        )
        
        result = await runner.run_case(case)
        
        # Return dict with ALL metrics for Braintrust dashboard
        return_dict = {
            "output": result.output,
            "tools_called": result.tools_called,
            "duration_ms": result.duration_ms,
            "error": result.error,
            "message_count": len(result.messages),
            # LLM call counts
            "llm_calls": result.llm_calls,
            "tool_calls": result.tool_calls,
            "errors": result.errors,
            "llm_errors": result.llm_errors,
            "tool_errors": result.tool_errors,
            # Token counts
            "prompt_tokens": result.prompt_tokens,
            "prompt_cached_tokens": result.prompt_cached_tokens,
            "prompt_cache_creation_tokens": result.prompt_cache_creation_tokens,
            "completion_tokens": result.completion_tokens,
            "completion_reasoning_tokens": result.completion_reasoning_tokens,
            "total_tokens": result.total_tokens,
            # Cost estimate
            "estimated_cost": result.estimated_cost,
        }
        
        # Add timing metrics if available
        if result.time_to_first_token_ms is not None:
            return_dict["time_to_first_token_ms"] = result.time_to_first_token_ms
        if result.llm_duration_ms is not None:
            return_dict["llm_duration_ms"] = result.llm_duration_ms
        
        return return_dict
    
    # Return sync wrapper for Braintrust
    def sync_task(input_data):
        """
        Sync wrapper that runs the async task.
        
        Braintrust runs tasks in a thread pool, so we need to create
        a new event loop in each thread with proper isolation.
        """
        import gc
        import time
        
        # CRITICAL: Reset ALL singleton connections before each test
        # This prevents "Event loop is closed" errors when running multiple tests
        def reset_singletons():
            """Reset all singleton instances that hold async state."""
            try:
                from core.services.supabase import DBConnection
                DBConnection._instance = None
            except Exception:
                pass
            
            try:
                from core.services.redis import _redis_client
                import core.services.redis as redis_module
                redis_module._redis_client = None
            except Exception:
                pass
            
            try:
                from core.utils.db_helpers import _db_instance
                import core.utils.db_helpers as db_helpers_module
                db_helpers_module._db_instance = None
            except Exception:
                pass
        
        reset_singletons()
        
        try:
            # Create a completely fresh event loop for this task
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            try:
                result = loop.run_until_complete(task(input_data))
                return result
            finally:
                # Proper cleanup: cancel all pending tasks
                try:
                    pending = asyncio.all_tasks(loop)
                    for pending_task in pending:
                        pending_task.cancel()
                    
                    # Give tasks time to cancel
                    if pending:
                        loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                except Exception:
                    pass
                
                # Close the loop
                try:
                    loop.run_until_complete(loop.shutdown_asyncgens())
                except Exception:
                    pass
                
                loop.close()
                
                # Reset all singletons again after loop closes
                reset_singletons()
                
                # Force garbage collection to clean up async resources
                gc.collect()
                
                # Small delay to ensure cleanup before next test
                time.sleep(1.0)
                
        except Exception as e:
            logger.error(f"Task execution error: {e}", exc_info=True)
            return {
                "output": "",
                "tools_called": [],
                "duration_ms": 0,
                "error": str(e),
                "message_count": 0,
                "llm_calls": 0,
                "tool_calls": 0,
                "errors": 1,
                "llm_errors": 0,
                "tool_errors": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "estimated_cost": 0,
            }
    
    return sync_task

