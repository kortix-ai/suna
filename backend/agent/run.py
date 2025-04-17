import os
import json
from uuid import uuid4
from typing import Optional

# from agent.tools.message_tool import MessageTool
from agent.tools.sb_deploy_tool import SandboxDeployTool
from agent.tools.web_search_tool import WebSearchTool
from dotenv import load_dotenv

from agentpress.thread_manager import ThreadManager
from agentpress.response_processor import ProcessorConfig
from agent.tools.sb_shell_tool import SandboxShellTool
from agent.tools.sb_files_tool import SandboxFilesTool
from agent.tools.sb_browser_tool import SandboxBrowserTool
from agent.tools.data_providers_tool import DataProvidersTool
from agent.prompt import get_system_prompt
from sandbox.sandbox import create_sandbox, get_or_start_sandbox
from utils.billing import check_billing_status, get_account_id_from_thread

load_dotenv()

async def run_agent(thread_id: str, project_id: str, stream: bool = True, thread_manager: Optional[ThreadManager] = None, native_max_auto_continues: int = 25, max_iterations: int = 150):
    """Run the development agent with specified configuration."""
    
    if not thread_manager:
        thread_manager = ThreadManager()
    client = await thread_manager.db.client

    # Get account ID from thread for billing checks
    account_id = await get_account_id_from_thread(client, thread_id)
    if not account_id:
        raise ValueError("Could not determine account ID for thread")

    # Initial billing check
    can_run, message, subscription = await check_billing_status(client, account_id)
    if not can_run:
        error_msg = f"Billing limit reached: {message}"
        # Yield a special message to indicate billing limit reached
        yield {
            "type": "status",
            "status": "stopped",
            "message": error_msg
        }
        raise Exception(message)

    ## probably want to move to api.py
    project = await client.table('projects').select('*').eq('project_id', project_id).execute()
    if project.data[0].get('sandbox', {}).get('id'):
        sandbox_id = project.data[0]['sandbox']['id']
        sandbox_pass = project.data[0]['sandbox']['pass']
        sandbox = await get_or_start_sandbox(sandbox_id)
    else:
        sandbox_pass = str(uuid4())
        sandbox = create_sandbox(sandbox_pass)
        print(f"\033[91m{sandbox.get_preview_link(6080)}/vnc_lite.html?password={sandbox_pass}\033[0m")
        sandbox_id = sandbox.id
        await client.table('projects').update({
            'sandbox': {
                'id': sandbox_id,
                'pass': sandbox_pass,
                'vnc_preview': str(sandbox.get_preview_link(6080)),  # Convert to string
                'sandbox_url': str(sandbox.get_preview_link(8080))   # Convert to string
            }
        }).eq('project_id', project_id).execute()
    
    thread_manager.add_tool(SandboxShellTool, sandbox=sandbox)
    thread_manager.add_tool(SandboxFilesTool, sandbox=sandbox)
    thread_manager.add_tool(SandboxBrowserTool, sandbox=sandbox, thread_id=thread_id, thread_manager=thread_manager)
    thread_manager.add_tool(SandboxDeployTool, sandbox=sandbox)
    # thread_manager.add_tool(MessageTool) -> we are just doing this via prompt as there is no need to call it as a tool
 
    if os.getenv("EXA_API_KEY"):
        thread_manager.add_tool(WebSearchTool)
    
    if os.getenv("RAPID_API_KEY"):
        thread_manager.add_tool(DataProvidersTool)

    xml_examples = ""
    for tag_name, example in thread_manager.tool_registry.get_xml_examples().items():
        xml_examples += f"{example}\n"

    iteration_count = 0
    continue_execution = True
    
    while continue_execution and iteration_count < max_iterations:
        iteration_count += 1
        print(f"Running iteration {iteration_count}...")

        # Billing check on each iteration
        can_run, message, subscription = await check_billing_status(client, account_id)
        if not can_run:
            error_msg = f"Billing limit reached: {message}"
            # Yield a special message to indicate billing limit reached
            yield {
                "type": "status",
                "status": "stopped",
                "message": error_msg
            }
            break
        
        # Check if last message is from assistant using direct Supabase query
        latest_message = await client.table('messages').select('*').eq('thread_id', thread_id).order('created_at', desc=True).limit(1).execute()  
        if latest_message.data and len(latest_message.data) > 0:
            message_type = latest_message.data[0].get('type')
            if message_type == 'assistant':
                print(f"Last message was from assistant, stopping execution")
                continue_execution = False
                break

        # Define Processor Config FIRST
        processor_config = ProcessorConfig(
            xml_tool_calling=True,
            native_tool_calling=False,
            execute_tools=True,
            execute_on_stream=True,
            tool_execution_strategy="parallel",
            xml_adding_strategy="user_message"
        )

        # Construct System Message Conditionally
        base_system_prompt_content = get_system_prompt()
        system_message_content = base_system_prompt_content

        # Conditionally add XML examples based on the config
        if processor_config.xml_tool_calling:
            # Use the already loaded xml_examples from outside the loop
            if xml_examples:
                system_message_content += "\n\n" + f"<tool_examples>\n{xml_examples}\n</tool_examples>"

        system_message = { "role": "system", "content": system_message_content }

        # Handle Temporary Message (Browser State)
        latest_browser_state = await client.table('messages').select('*').eq('thread_id', thread_id).eq('type', 'browser_state').order('created_at', desc=True).limit(1).execute()
        temporary_message = None
        if latest_browser_state.data and len(latest_browser_state.data) > 0:
            try:
                content = json.loads(latest_browser_state.data[0]["content"])
                screenshot_base64 = content.get("screenshot_base64") # Use .get() for safety
                # Create a copy of the browser state without screenshot
                browser_state = content.copy()
                browser_state.pop('screenshot_base64', None)
                browser_state.pop('screenshot_url', None)
                browser_state.pop('screenshot_url_base64', None)
                temporary_message = { "role": "user", "content": [] }
                if browser_state:
                    temporary_message["content"].append({
                        "type": "text",
                        "text": f"The following is the current state of the browser:\n{json.dumps(browser_state, indent=2)}" # Pretty print browser state
                    })
                if screenshot_base64:
                    temporary_message["content"].append({
                        "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{screenshot_base64}",
                            }
                    })
                else:
                    print("No screenshot found in the latest browser state message.")
            except Exception as e:
                print(f"Error parsing browser state: {e}")
                # print(latest_browser_state.data[0])

        # Determine model and max tokens
        model_to_use = os.getenv("MODEL_TO_USE", "anthropic/claude-3-7-sonnet-latest")
        max_tokens = None
        if model_to_use == "anthropic/claude-3-7-sonnet-latest":
            max_tokens = 64000

        # Run Thread
        response = await thread_manager.run_thread(
            thread_id=thread_id,
            system_prompt=system_message, # Pass the constructed message
            stream=stream,
            # stream=False,
            llm_model=model_to_use,
            # llm_temperature=0.1,
            llm_temperature=1,
            llm_max_tokens=max_tokens, # Use the determined value
            tool_choice="auto",
            max_xml_tool_calls=1,
            temporary_message=temporary_message,
            processor_config=processor_config, # Pass the config object
            native_max_auto_continues=native_max_auto_continues,
            # Explicitly set include_xml_examples to False here
            include_xml_examples=False,
        )
            
        if isinstance(response, dict) and "status" in response and response["status"] == "error":
            yield response 
            break
            
        # Track if we see ask or complete tool calls
        last_tool_call = None
        
        async for chunk in response:
            # Check if this is a tool call chunk for ask or complete
            if chunk.get('type') == 'tool_call':
                tool_call = chunk.get('tool_call', {})
                function_name = tool_call.get('function', {}).get('name', '')
                if function_name in ['ask', 'complete']:
                    last_tool_call = function_name
            # Check for XML versions like <ask> or <complete> in content chunks
            elif chunk.get('type') == 'content' and 'content' in chunk:
                content = chunk.get('content', '')
                if '</ask>' in content or '</complete>' in content:
                    xml_tool = 'ask' if '</ask>' in content else 'complete'
                    last_tool_call = xml_tool
                    print(f"Agent used XML tool: {xml_tool}")
                    
            yield chunk
        
        # Check if we should stop based on the last tool call
        if last_tool_call in ['ask', 'complete']:
            print(f"Agent decided to stop with tool: {last_tool_call}")
            continue_execution = False



# TESTING

async def test_agent():
    """Test function to run the agent with a sample query"""
    from agentpress.thread_manager import ThreadManager
    from services.supabase import DBConnection
    
    # Initialize ThreadManager
    thread_manager = ThreadManager()
    
    # Create a test thread directly with Postgres function
    client = await DBConnection().client
    
    try:
        # Get user's personal account
        account_result = await client.rpc('get_personal_account').execute()
        
        # if not account_result.data:
        #     print("Error: No personal account found")
        #     return
            
        account_id = "a5fe9cb6-4812-407e-a61c-fe95b7320c59"
        
        if not account_id:
            print("Error: Could not get account ID")
            return
        
        # Find or create a test project in the user's account
        project_result = await client.table('projects').select('*').eq('name', 'test11').eq('account_id', account_id).execute()
        
        if project_result.data and len(project_result.data) > 0:
            # Use existing test project
            project_id = project_result.data[0]['project_id']
            print(f"\n🔄 Using existing test project: {project_id}")
        else:
            # Create new test project if none exists
            project_result = await client.table('projects').insert({
                "name": "test11", 
                "account_id": account_id
            }).execute()
            project_id = project_result.data[0]['project_id']
            print(f"\n✨ Created new test project: {project_id}")
        
        # Create a thread for this project
        thread_result = await client.table('threads').insert({
            'project_id': project_id,
            'account_id': account_id
        }).execute()
        thread_data = thread_result.data[0] if thread_result.data else None
        
        if not thread_data:
            print("Error: No thread data returned")
            return
            
        thread_id = thread_data['thread_id']
    except Exception as e:
        print(f"Error setting up thread: {str(e)}")
        return
        
    print(f"\n🤖 Agent Thread Created: {thread_id}\n")
    
    # Interactive message input loop
    while True:
        # Get user input
        user_message = input("\n💬 Enter your message (or 'exit' to quit): ")
        if user_message.lower() == 'exit':
            break
        
        if not user_message.strip():
            print("\n🔄 Running agent...\n")
            await process_agent_response(thread_id, project_id, thread_manager)
            continue
            
        # Add the user message to the thread
        await thread_manager.add_message(
            thread_id=thread_id,
            type="user",
            content={
                "role": "user",
                "content": user_message
            },
            is_llm_message=True
        )
        
        print("\n🔄 Running agent...\n")
        await process_agent_response(thread_id, project_id, thread_manager)
    
    print("\n👋 Test completed. Goodbye!")

async def process_agent_response(thread_id: str, project_id: str, thread_manager: ThreadManager):
    """Process the streaming response from the agent."""
    chunk_counter = 0
    current_response = ""
    tool_call_counter = 0  # Track number of tool calls
    
    async for chunk in run_agent(thread_id=thread_id, project_id=project_id, stream=True, thread_manager=thread_manager, native_max_auto_continues=25):
        chunk_counter += 1
        
        if chunk.get('type') == 'content' and 'content' in chunk:
            current_response += chunk.get('content', '')
            # Print the response as it comes in
            print(chunk.get('content', ''), end='', flush=True)
        elif chunk.get('type') == 'tool_result':
            # Add timestamp and format tool result nicely
            tool_name = chunk.get('function_name', 'Tool')
            result = chunk.get('result', '')
            print(f"\n\n🛠️  TOOL RESULT [{tool_name}] → {result}")
        elif chunk.get('type') == 'tool_call':
            # Display native tool call chunks as they arrive
            tool_call = chunk.get('tool_call', {})
            
            # Check if it's a meaningful part of the tool call to display
            args = tool_call.get('function', {}).get('arguments', '')
            
            # Only show when we have substantial arguments or a function name
            should_display = (
                len(args) > 3 or  # More than just '{}'
                tool_call.get('function', {}).get('name')  # Or we have a name
            )
            
            if should_display:
                tool_call_counter += 1
                tool_name = tool_call.get('function', {}).get('name', 'Building...')
                
                # Print tool call header with counter and tool name
                print(f"\n🔧 TOOL CALL #{tool_call_counter} [{tool_name}]")
                
                # Try to parse and pretty print the arguments if they're JSON
                try:
                    # Check if it's complete JSON or just a fragment
                    if args.strip().startswith('{') and args.strip().endswith('}'):
                        args_obj = json.loads(args)
                        # Only print non-empty args to reduce clutter
                        if args_obj and args_obj != {}:
                            # Format JSON with nice indentation and color indicators for readability
                            print(f"  ARGS: {json.dumps(args_obj, indent=2)}")
                    else:
                        # Only print if there's actual content to show
                        if args.strip():
                            print(f"  ARGS: {args}")
                except json.JSONDecodeError:
                    if args.strip():
                        print(f"  ARGS: {args}")
                
                # Add a separator for visual clarity
                print("  " + "-" * 40)
                
                # Return to the current content display
                if current_response:
                    print("\nContinuing response:", flush=True)
                    print(current_response, end='', flush=True)
        elif chunk.get('type') == 'tool_status':
            # Log tool status changes
            status = chunk.get('status', '')
            function_name = chunk.get('function_name', '')
            if status and function_name:
                status_emoji = "✅" if status == "completed" else "⏳" if status == "started" else "❌"
                print(f"\n{status_emoji} TOOL {status.upper()}: {function_name}")
        elif chunk.get('type') == 'finish':
            # Just log finish reason to console but don't show to user
            finish_reason = chunk.get('finish_reason', '')
            if finish_reason:
                print(f"\n📌 Finished: {finish_reason}")
    
    print(f"\n\n✅ Agent run completed with {tool_call_counter} tool calls")

if __name__ == "__main__":
    import asyncio
    
    # Configure any environment variables or setup needed for testing
    load_dotenv()  # Ensure environment variables are loaded
    
    # Run the test function
    asyncio.run(test_agent())
