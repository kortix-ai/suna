"""
Mock LLM Provider for Stress Testing

Provides deterministic, fast responses for stress testing without
making actual LLM API calls. Simulates tool calls and streaming
responses based on prompt patterns.
"""

import asyncio
import json
from typing import AsyncGenerator, Dict, List, Any, Optional
from datetime import datetime
import re


class MockLLMProvider:
    """
    Mock LLM provider that generates deterministic streaming responses
    for stress testing without real API calls
    """
    
    def __init__(self, delay_ms: int = 20):
        """
        Initialize mock provider
        
        Args:
            delay_ms: Delay between stream chunks in milliseconds
        """
        self.delay_ms = delay_ms
    
    async def acompletion(
        self,
        messages: List[Dict[str, Any]],
        model: str = "mock-ai",
        stream: bool = True,
        tools: Optional[List[Dict[str, Any]]] = None,
        temperature: float = 0,
        max_tokens: Optional[int] = None,
        **kwargs
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        LiteLLM-compatible async completion interface
        
        Args:
            messages: List of conversation messages
            model: Model name (ignored in mock)
            stream: Whether to stream (always True for mock)
            tools: Available tools for the agent
            temperature: Temperature (ignored in mock)
            max_tokens: Max tokens (ignored in mock)
            **kwargs: Additional parameters (ignored)
        
        Yields:
            Stream chunks simulating real LLM response
        """
        async for chunk in self.get_mock_response(messages, tools or [], model):
            yield chunk
    
    async def get_mock_response(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        model: str = "kortix/basic"
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Generate mock streaming response in LiteLLM format
        
        Args:
            messages: List of conversation messages
            tools: Available tools for the agent
            model: Model name (ignored in mock)
        
        Yields:
            Stream chunks in LiteLLM-compatible dict format
        """
        # Extract user prompt from messages
        user_message = None
        for msg in reversed(messages):
            if msg.get('role') == 'user':
                user_message = msg.get('content', '')
                break
        
        if not user_message:
            user_message = "test"
        
        # Determine which tools to "call" based on prompt patterns
        tool_calls = self._determine_tool_calls(user_message, tools)
        
        # Generate text response
        text_response = self._generate_text_response(user_message, tool_calls)
        
        # Create a simple object that mimics LiteLLM's streaming response
        class MockStreamChunk:
            def __init__(self, choices, id=None, model=None, usage=None):
                self.choices = choices
                self.id = id or f"chatcmpl-mock-{datetime.now().timestamp()}"
                self.model = model or "mock-ai"
                self.object = "chat.completion.chunk"
                self.created = int(datetime.now().timestamp())
                if usage:
                    self.usage = usage
        
        class MockChoice:
            def __init__(self, delta, finish_reason=None, index=0):
                self.delta = delta
                self.finish_reason = finish_reason
                self.index = index
        
        class MockDelta:
            def __init__(self, content=None, role=None, tool_calls=None):
                if content is not None:
                    self.content = content
                if role:
                    self.role = role
                if tool_calls:
                    self.tool_calls = tool_calls
        
        # Yield TTFT metadata first (simulates time to first token)
        # The delay_ms represents the mock "thinking" time
        ttft_seconds = self.delay_ms / 1000.0
        yield {"__llm_ttft_seconds__": ttft_seconds, "model": model}
        
        # Stream tool calls first
        for i, tool_call in enumerate(tool_calls):
            await asyncio.sleep(self.delay_ms / 1000)
            
            delta = MockDelta(
                role="assistant",
                tool_calls=[{
                    'id': f'call_mock_{i}_{int(datetime.now().timestamp() * 1000)}',
                    'type': 'function',
                    'function': {
                        'name': tool_call['name'],
                        'arguments': json.dumps(tool_call['input'])
                    }
                }]
            )
            
            yield MockStreamChunk(
                choices=[MockChoice(delta=delta, finish_reason=None)],
                model=model
            )
        
        # Stream text content in chunks
        chunk_size = 20
        for i in range(0, len(text_response), chunk_size):
            chunk = text_response[i:i + chunk_size]
            await asyncio.sleep(self.delay_ms / 1000)
            
            delta = MockDelta(content=chunk, role="assistant")
            
            yield MockStreamChunk(
                choices=[MockChoice(delta=delta, finish_reason=None)],
                model=model
            )
        
        # Final chunk with finish_reason and usage
        await asyncio.sleep(self.delay_ms / 1000)
        delta = MockDelta()
        
        yield MockStreamChunk(
            choices=[MockChoice(delta=delta, finish_reason="stop")],
            model=model,
            usage={
                'prompt_tokens': 100,
                'completion_tokens': len(text_response.split()),
                'total_tokens': 100 + len(text_response.split())
            }
        )
    
    def _determine_tool_calls(
        self,
        prompt: str,
        tools: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Determine which tools to call based on prompt patterns
        
        Args:
            prompt: User's prompt text
            tools: Available tools
        
        Returns:
            List of mock tool calls
        """
        tool_calls = []
        prompt_lower = prompt.lower()
        
        # File operations
        if any(kw in prompt_lower for kw in ['file', 'list', 'create', 'read', 'write', 'directory']):
            if self._has_tool(tools, 'sb_files_tool'):
                action = 'list'
                if 'create' in prompt_lower or 'write' in prompt_lower:
                    action = 'write'
                elif 'read' in prompt_lower:
                    action = 'read'
                
                tool_calls.append({
                    'name': 'sb_files_tool',
                    'input': {
                        'action': action,
                        'path': '/home/user',
                        'content': 'Hello from E2E test harness' if action == 'write' else None
                    }
                })
        
        # Shell commands
        if any(kw in prompt_lower for kw in ['run', 'execute', 'command', 'pwd', 'echo', 'date', 'shell']):
            if self._has_tool(tools, 'sb_shell_tool'):
                command = 'echo "Mock command output"'
                if 'pwd' in prompt_lower:
                    command = 'pwd'
                elif 'date' in prompt_lower:
                    command = 'date'
                
                tool_calls.append({
                    'name': 'sb_shell_tool',
                    'input': {
                        'command': command
                    }
                })
        
        # Web search
        if any(kw in prompt_lower for kw in ['search', 'find', 'lookup', 'web', 'internet']):
            if self._has_tool(tools, 'web_search_tool'):
                tool_calls.append({
                    'name': 'web_search_tool',
                    'input': {
                        'query': 'mock search query',
                        'max_results': 5
                    }
                })
        
        # If no tools detected, might be pure chat
        return tool_calls
    
    def _has_tool(self, tools: List[Dict[str, Any]], tool_name: str) -> bool:
        """Check if a tool is available"""
        return any(t.get('name') == tool_name for t in tools)
    
    def _generate_text_response(
        self,
        prompt: str,
        tool_calls: List[Dict[str, Any]]
    ) -> str:
        """
        Generate appropriate text response based on prompt and tools used
        
        Args:
            prompt: User's prompt
            tool_calls: Tools that were called
        
        Returns:
            Text response
        """
        if not tool_calls:
            # Pure chat response
            if len(prompt) < 10:
                return "Hello! I'm here to help you. What would you like to do?"
            elif 'yourself' in prompt.lower() or 'who are you' in prompt.lower():
                return "I'm Kortix, an AI assistant that can help you with various tasks including file operations, running commands, and searching the web."
            else:
                return "I understand your question. Let me provide you with a helpful response based on the information available."
        
        # Response based on tools used
        tool_names = [tc['name'] for tc in tool_calls]
        
        if 'sb_files_tool' in tool_names and 'sb_shell_tool' in tool_names:
            return "I've created the file and executed it successfully. The operation completed as expected."
        elif 'web_search_tool' in tool_names and 'sb_files_tool' in tool_names:
            return "I've searched the web and created a notes file with the summary as requested."
        elif 'sb_files_tool' in tool_names:
            return "I've completed the file operation. The files have been processed successfully."
        elif 'sb_shell_tool' in tool_names:
            return "I've executed the command. Here's the output from the shell."
        elif 'web_search_tool' in tool_names:
            return "I've searched the web and found relevant information. Here's a summary of what I found."
        else:
            return "I've completed the requested operations successfully."
    
    def get_mock_tool_result(self, tool_name: str, tool_input: Dict[str, Any]) -> str:
        """
        Generate mock tool execution result
        
        Args:
            tool_name: Name of the tool
            tool_input: Tool input parameters
        
        Returns:
            Mock tool result as string
        """
        if tool_name == 'sb_files_tool':
            action = tool_input.get('action', 'list')
            if action == 'list':
                return json.dumps({
                    'files': ['file1.py', 'file2.py', 'test.txt'],
                    'count': 3
                })
            elif action == 'write':
                return json.dumps({'success': True, 'message': 'File created successfully'})
            elif action == 'read':
                return 'Mock file content'
        
        elif tool_name == 'sb_shell_tool':
            command = tool_input.get('command', '')
            if 'pwd' in command:
                return '/home/user/workspace'
            elif 'date' in command:
                return datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            else:
                return 'Mock command output\nSuccess'
        
        elif tool_name == 'web_search_tool':
            return json.dumps({
                'results': [
                    {'title': 'Mock Result 1', 'snippet': 'This is a mock search result for testing purposes.'},
                    {'title': 'Mock Result 2', 'snippet': 'Another mock result with relevant information.'}
                ],
                'total': 2
            })
        
        return 'Mock tool result'


# Global instance for easy access
_mock_provider = None


def get_mock_provider(delay_ms: int = 20) -> MockLLMProvider:
    """Get or create global mock provider instance"""
    global _mock_provider
    if _mock_provider is None:
        _mock_provider = MockLLMProvider(delay_ms=delay_ms)
    return _mock_provider


def enable_mock_mode():
    """Enable mock LLM mode globally (for stress testing)"""
    global _mock_provider
    _mock_provider = MockLLMProvider()
    return _mock_provider


def disable_mock_mode():
    """Disable mock LLM mode"""
    global _mock_provider
    _mock_provider = None

