import asyncio
from typing import Dict, Any, AsyncGenerator

from core.utils.config import config
from core.agents.pipeline.context import PipelineContext
from core.agentpress.response_processor import ProcessorConfig
from core.agentpress.thread_manager.services.execution.llm_executor import LLMExecutor
from core.agentpress.prompt_caching import add_cache_control
import litellm


class ExecutionEngine:
    def __init__(self, state, response_processor):
        self._state = state
        self._response_processor = response_processor

    async def execute_step(self) -> AsyncGenerator[Dict[str, Any], None]:
        messages = self._state.get_messages()
        system = self._state.system_prompt or {"role": "system", "content": "You are a helpful assistant."}

        cached_system = add_cache_control(system)
        prepared = [cached_system] + messages

        tokens = await asyncio.to_thread(
            litellm.token_counter, 
            model=self._state.model_name, 
            messages=prepared
        )
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
