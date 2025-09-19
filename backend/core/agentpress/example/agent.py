import asyncio
from core.agentpress.thread_manager import ThreadManager
from core.agentpress.tool import Tool, ToolResult, openapi_schema, usage_example
from core.agentpress.response_processor import ProcessorConfig

class CalculatorTool(Tool):
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "Perform basic mathematical calculations (addition, subtraction, multiplication, division)",
            "parameters": {
                "type": "object",
                "properties": {
                    "operation": {
                        "type": "string",
                        "enum": ["add", "subtract", "multiply", "divide"],
                        "description": "The mathematical operation to perform"
                    },
                    "a": {
                        "type": "number",
                        "description": "First number for the calculation"
                    },
                    "b": {
                        "type": "number",
                        "description": "Second number for the calculation"
                    }
                },
                "required": ["operation", "a", "b"]
            }
        }
    })
    @usage_example("""
<function_calls>
<invoke name="calculate">
<parameter name="operation">add</parameter>
<parameter name="a">15</parameter>
<parameter name="b">27</parameter>
</invoke>
</function_calls>

This will add 15 and 27 to get 42.""")
    async def calculate(self, operation: str, a: float, b: float) -> ToolResult:
        if operation == "add":
            result = a + b
        elif operation == "subtract":
            result = a - b
        elif operation == "multiply":
            result = a * b
        elif operation == "divide":
            if b == 0:
                return self.fail_response("Cannot divide by zero")
            result = a / b
        else:
            return self.fail_response(f"Unknown operation: {operation}")
        
        return self.success_response({"result": result})

def render_conversation(messages):
    print("\n" + "="*60)
    print("📜 CONVERSATION HISTORY")
    print("="*60)
    
    for i, message in enumerate(messages, 1):
        role = message.get('role', 'unknown')
        content = message.get('content', '')
        
        if role == 'user':
            role_display = "👤 USER"
            color = '\033[94m'
        elif role == 'assistant':
            role_display = "🤖 ASSISTANT"
            color = '\033[92m'
        elif role == 'system':
            role_display = "⚙️  SYSTEM"
            color = '\033[93m'
        else:
            role_display = f"📝 {role.upper()}"
            color = '\033[96m'
        
        reset = '\033[0m'
        print(f"\n{color}{role_display} (Message {i}){reset}")
        print("-" * 40)
        
        if isinstance(content, str):
            print(content)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, dict):
                    if item.get('type') == 'text':
                        print(item.get('text', ''))
                    elif item.get('type') == 'tool_use':
                        tool_name = item.get('name', 'unknown_tool')
                        tool_input = item.get('input', {})
                        print(f"🔧 Tool Call: {tool_name}")
                        print(f"   Input: {tool_input}")
                    else:
                        print(f"   {item}")
                else:
                    print(f"   {item}")
        elif isinstance(content, dict):
            if 'tool_calls' in content:
                for tool_call in content['tool_calls']:
                    function = tool_call.get('function', {})
                    print(f"🔧 Tool Call: {function.get('name', 'unknown')}")
                    print(f"   Arguments: {function.get('arguments', {})}")
            else:
                print(content)
        else:
            print(f"[{type(content).__name__}]: {content}")
    
    print("\n" + "="*60)

async def main():
    # Initialize thread manager and add tools
    thread_manager = ThreadManager()
    thread_manager.add_tool(CalculatorTool)
    
    # Define system prompt
    system_prompt = {
        "role": "system",
        "content": """You are a helpful mathematical assistant agent. You can:

1. Perform basic mathematical calculations (addition, subtraction, multiplication, division)
2. Provide help information about available operations
3. Explain mathematical concepts in simple terms

When a user asks for calculations, use the calculator tool to ensure accuracy. 
Always be friendly and explain your reasoning when solving problems.

Available tools:
- calculate: Perform mathematical operations

"""
    }
    
    # Create thread
    thread_id = await thread_manager.create_thread()
    
    messages = [
        "What's 15 + 27?",
        "Can you multiply 8.5 by 4?",
        "What's 100 divided by 7?"
    ]
    
    for message in messages:
        await thread_manager.add_message(
            thread_id=thread_id,
            type="user",
            content={"role": "user", "content": message},
            is_llm_message=True
        )
        
        response_stream = await thread_manager.run_thread(
            thread_id=thread_id,
            system_prompt=system_prompt,
            stream=True,
            llm_model="gpt-5",
            processor_config=ProcessorConfig(
                xml_tool_calling=True,
                execute_tools=True,
                tool_execution_strategy="sequential"
            ),
            include_xml_examples=True
        )        

        async for chunk in response_stream:
            if isinstance(chunk, dict) and chunk.get('type') == 'content':
                print(chunk.get('content', ''), end='', flush=True)
        print()
    
    try:
        conversation_history = await thread_manager.get_llm_messages(thread_id)
        render_conversation(conversation_history)
    except Exception as e:
        print(f"Failed to fetch conversation history: {e}")

if __name__ == "__main__":
    asyncio.run(main())