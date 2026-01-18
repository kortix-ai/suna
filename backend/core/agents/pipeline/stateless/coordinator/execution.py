import asyncio
from typing import Dict, Any, AsyncGenerator

from core.utils.config import config
from core.utils.logger import logger
from core.agents.pipeline.context import PipelineContext
from core.agentpress.response_processor import ProcessorConfig
from core.agentpress.thread_manager.services.execution.llm_executor import LLMExecutor
from core.agentpress.prompt_caching import add_cache_control
from core.agents.pipeline.stateless.compression import ContextCompressor


class ExecutionEngine:
    def __init__(self, state, response_processor):
        self._state = state
        self._response_processor = response_processor

    async def execute_step(self) -> AsyncGenerator[Dict[str, Any], None]:
        messages = self._state.get_messages()
        system = self._state.system_prompt or {"role": "system", "content": "You are a helpful assistant."}

        compression_result = await ContextCompressor.check_and_compress(
            messages=messages,
            system_prompt=system,
            model_name=self._state.model_name,
            registry_model_id=self._state.model_name,
            thread_id=self._state.thread_id
        )
        
        messages = compression_result.messages
        
        if compression_result.compressed:
            logger.info(f"[ExecutionEngine] Context compressed: {len(self._state.get_messages())} -> {len(messages)} messages")
        
        cached_system = add_cache_control(system)
        prepared = [cached_system] + messages
        
        tokens = compression_result.actual_tokens
        cost = self._state.estimate_cost(tokens, 1000)

        if not self._state.deduct_credits(cost):
            yield {"type": "error", "error": "Insufficient credits", "error_code": "INSUFFICIENT_CREDITS"}
            return

        processor_config = ProcessorConfig(
            xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
            native_tool_calling=config.AGENT_NATIVE_TOOL_CALLING,
            execute_tools=True,
            execute_on_stream=config.AGENT_EXECUTE_ON_STREAM,
            tool_execution_strategy=config.AGENT_TOOL_EXECUTION_STRATEGY
        )

        prepared, tokens = await ContextCompressor.apply_late_compression_if_needed(
            prepared_messages=prepared,
            messages=messages,
            system_prompt=system,
            model_name=self._state.model_name,
            registry_model_id=self._state.model_name,
            thread_id=self._state.thread_id
        )
        
        logger.debug(f"📤 [ExecutionEngine] Sending {len(prepared)} messages, {tokens} tokens")

        executor = LLMExecutor()
        response = await executor.execute(
            prepared_messages=prepared,
            llm_model=self._state.model_name,
            llm_temperature=0,
            llm_max_tokens=None,
            openapi_tool_schemas=self._state.tool_schemas,
            tool_choice="auto",
            native_tool_calling=processor_config.native_tool_calling,
            xml_tool_calling=processor_config.xml_tool_calling,
            stream=True
        )

        if isinstance(response, dict) and response.get("status") == "error":
            yield response
            return

        if hasattr(response, '__aiter__'):
            async for chunk in self._response_processor.process_response(response):
                yield chunk
        elif isinstance(response, dict):
            yield response
