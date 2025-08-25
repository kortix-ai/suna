"""
MCP Layer for AgentPress Agent Invocation

Allows Claude Code to discover and invoke your custom AgentPress agents and workflows
through MCP (Model Context Protocol) instead of using generic capabilities.

🚀 ADD TO CLAUDE CODE:
```bash
claude mcp add --transport http "AgentPress" "https://your-backend-domain.com/api/mcp?key=pk_your_key:sk_your_secret"
```
claude mcp add AgentPress https://api2.restoned.app/api/mcp --header
  "Authorization=Bearer pk_your_key:sk_your_secret"

📋 SETUP STEPS:
1. Deploy your AgentPress backend with this MCP layer
2. Get your API key from your-frontend-domain.com/settings/api-keys  
3. Replace your-backend-domain.com and API key in the command above
4. Run the command in Claude Code

🎯 BENEFITS:
✅ Claude Code uses YOUR specialized agents instead of generic ones
✅ Real execution of your custom prompts and workflows  
✅ Uses existing AgentPress authentication and infrastructure
✅ Transforms your agents into Claude Code tools

📡 TOOLS PROVIDED:
- get_agent_list: List your agents
- get_agent_workflows: List agent workflows
- run_agent: Execute agents with prompts or workflows
"""

from fastapi import APIRouter, Request, Response
from typing import Dict, Any, Union, Optional
from pydantic import BaseModel
import asyncio
from datetime import datetime

from utils.logger import logger
from services.supabase import DBConnection


# Create MCP router that wraps existing endpoints
mcp_router = APIRouter(prefix="/mcp", tags=["MCP Kortix Layer"])

# Initialize database connection
db = DBConnection()


class JSONRPCRequest(BaseModel):
    """JSON-RPC 2.0 request format"""
    jsonrpc: str = "2.0"
    method: str
    params: Optional[Dict[str, Any]] = None
    id: Union[str, int, None] = None


class JSONRPCSuccessResponse(BaseModel):
    """JSON-RPC 2.0 success response format"""
    jsonrpc: str = "2.0"
    result: Any
    id: Union[str, int, None]


class JSONRPCError(BaseModel):
    """JSON-RPC 2.0 error object"""
    code: int
    message: str
    data: Optional[Any] = None


class JSONRPCErrorResponse(BaseModel):
    """JSON-RPC 2.0 error response format"""
    jsonrpc: str = "2.0"
    error: JSONRPCError
    id: Union[str, int, None]


# JSON-RPC error codes
class JSONRPCErrorCodes:
    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603
    UNAUTHORIZED = -32001  # Custom error for auth failures


def extract_api_key_from_request(request: Request) -> tuple[str, str]:
    """Extract and parse API key from request URL parameters or Authorization header."""
    # Try Authorization header first (for Claude Code)
    auth_header = request.headers.get("authorization")
    if auth_header:
        if auth_header.startswith("Bearer "):
            key_param = auth_header[7:]  # Remove "Bearer " prefix
        else:
            key_param = auth_header
        
        if ":" in key_param:
            try:
                public_key, secret_key = key_param.split(":", 1)
                if public_key.startswith("pk_") and secret_key.startswith("sk_"):
                    return public_key, secret_key
            except:
                pass
    
    # Fallback to URL parameter (for curl testing)
    key_param = request.query_params.get("key")
    if key_param:
        if ":" not in key_param:
            raise ValueError("Invalid key format. Expected 'pk_xxx:sk_xxx'")
        
        try:
            public_key, secret_key = key_param.split(":", 1)
            
            if not public_key.startswith("pk_") or not secret_key.startswith("sk_"):
                raise ValueError("Invalid key format. Expected 'pk_xxx:sk_xxx'")
            
            return public_key, secret_key
        except Exception as e:
            raise ValueError(f"Failed to parse API key: {str(e)}")
    
    # No valid auth found
    raise ValueError("Missing API key. Provide via Authorization header: 'Bearer pk_xxx:sk_xxx' or URL parameter: '?key=pk_xxx:sk_xxx'")


async def authenticate_api_key(public_key: str, secret_key: str) -> str:
    """Authenticate API key and return account_id."""
    try:
        # Use the existing API key service for validation
        from services.api_keys import APIKeyService
        api_key_service = APIKeyService(db)
        
        # Validate the API key
        validation_result = await api_key_service.validate_api_key(public_key, secret_key)
        
        if not validation_result.is_valid:
            raise ValueError(validation_result.error_message or "Invalid API key")
        
        account_id = str(validation_result.account_id)
        logger.info(f"API key authenticated for account_id: {account_id}")
        return account_id
        
    except Exception as e:
        logger.error(f"API key authentication failed: {str(e)}")
        raise ValueError(f"Authentication failed: {str(e)}")


def extract_last_message(full_output: str) -> str:
    """Extract the last meaningful message from agent output."""
    if not full_output.strip():
        return "No output received"
    
    lines = full_output.strip().split('\n')
    
    # Look for the last substantial message
    for line in reversed(lines):
        if line.strip() and not line.startswith('#') and not line.startswith('```'):
            try:
                line_index = lines.index(line)
                start_index = max(0, line_index - 3)
                return '\n'.join(lines[start_index:]).strip()
            except ValueError:
                return line.strip()
    
    # Fallback: return last 20% of the output
    return full_output[-len(full_output)//5:].strip() if len(full_output) > 100 else full_output


def truncate_from_end(text: str, max_tokens: int) -> str:
    """Truncate text from the beginning, keeping the end."""
    if max_tokens <= 0:
        return ""
    
    max_chars = max_tokens * 4  # Rough token estimation
    
    if len(text) <= max_chars:
        return text
    
    truncated = text[-max_chars:]
    return f"...[truncated {len(text) - max_chars} characters]...\n{truncated}"


@mcp_router.post("/")
@mcp_router.post("")  # Handle requests without trailing slash
async def mcp_handler(
    request: JSONRPCRequest,
    http_request: Request
):
    """Main MCP endpoint handling JSON-RPC 2.0 requests."""
    try:
        # Authenticate API key from URL parameters
        try:
            public_key, secret_key = extract_api_key_from_request(http_request)
            account_id = await authenticate_api_key(public_key, secret_key)
        except ValueError as auth_error:
            logger.warning(f"Authentication failed: {str(auth_error)}")
            return JSONRPCErrorResponse(
                error=JSONRPCError(
                    code=JSONRPCErrorCodes.UNAUTHORIZED,
                    message=f"Authentication failed: {str(auth_error)}"
                ),
                id=request.id
            )
        
        # Validate JSON-RPC format
        if request.jsonrpc != "2.0":
            return JSONRPCErrorResponse(
                error=JSONRPCError(
                    code=JSONRPCErrorCodes.INVALID_REQUEST,
                    message="Invalid JSON-RPC version"
                ),
                id=request.id
            )
        
        method = request.method
        params = request.params or {}
        
        logger.info(f"MCP JSON-RPC call: {method} for account: {account_id}")
        
        # Handle different MCP methods
        if method == "initialize":
            result = {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "agentpress",
                    "version": "1.0.0"
                }
            }
        elif method == "tools/list":
            result = await handle_tools_list()
        elif method == "tools/call":
            tool_name = params.get("name")
            arguments = params.get("arguments", {})
            
            if not tool_name:
                return JSONRPCErrorResponse(
                    error=JSONRPCError(
                        code=JSONRPCErrorCodes.INVALID_PARAMS,
                        message="Missing 'name' parameter for tools/call"
                    ),
                    id=request.id
                )
            
            result = await handle_tool_call(tool_name, arguments, account_id)
        else:
            return JSONRPCErrorResponse(
                error=JSONRPCError(
                    code=JSONRPCErrorCodes.METHOD_NOT_FOUND,
                    message=f"Method '{method}' not found"
                ),
                id=request.id
            )
        
        return JSONRPCSuccessResponse(
            result=result,
            id=request.id
        )
        
    except Exception as e:
        logger.error(f"Error in MCP JSON-RPC handler: {str(e)}")
        return JSONRPCErrorResponse(
            error=JSONRPCError(
                code=JSONRPCErrorCodes.INTERNAL_ERROR,
                message=f"Internal error: {str(e)}"
            ),
            id=getattr(request, 'id', None)
        )


async def handle_tools_list():
    """Handle tools/list method."""
    tools = [
        {
            "name": "get_agent_list",
            "description": "Get a list of all available agents in your account. Always call this tool first.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        },
        {
            "name": "get_agent_workflows",
            "description": "Get a list of available workflows for a specific agent.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent to get workflows for"
                    }
                },
                "required": ["agent_id"]
            }
        },
        {
            "name": "run_agent",
            "description": "Run a specific agent with a message and get formatted output.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent to run"
                    },
                    "message": {
                        "type": "string", 
                        "description": "The message/prompt to send to the agent"
                    },
                    "execution_mode": {
                        "type": "string",
                        "enum": ["prompt", "workflow"],
                        "description": "Either 'prompt' for custom prompt execution or 'workflow' for workflow execution"
                    },
                    "workflow_id": {
                        "type": "string",
                        "description": "Required when execution_mode is 'workflow' - the ID of the workflow to run"
                    },
                    "output_mode": {
                        "type": "string",
                        "enum": ["last_message", "full"],
                        "description": "How to format output: 'last_message' (default) or 'full'"
                    },
                    "max_tokens": {
                        "type": "integer",
                        "description": "Maximum tokens in response"
                    },
                    "model_name": {
                        "type": "string",
                        "description": "Model to use for the agent execution. If not specified, uses the agent's configured model or fallback."
                    }
                },
                "required": ["agent_id", "message"]
            }
        }
    ]
    
    return {"tools": tools}


async def handle_tool_call(tool_name: str, arguments: Dict[str, Any], account_id: str):
    """Handle tools/call method."""
    try:
        if tool_name == "get_agent_list":
            result = await call_get_agents_endpoint(account_id)
        elif tool_name == "get_agent_workflows":
            agent_id = arguments.get("agent_id")
            if not agent_id:
                raise ValueError("agent_id is required")
            result = await call_get_agent_workflows_endpoint(account_id, agent_id)
        elif tool_name == "run_agent":
            agent_id = arguments.get("agent_id")
            message = arguments.get("message")
            execution_mode = arguments.get("execution_mode", "prompt")
            workflow_id = arguments.get("workflow_id")
            output_mode = arguments.get("output_mode", "last_message")
            max_tokens = arguments.get("max_tokens", 1000)
            model_name = arguments.get("model_name")
            
            if not agent_id or not message:
                raise ValueError("agent_id and message are required")
            
            if execution_mode == "workflow" and not workflow_id:
                raise ValueError("workflow_id is required when execution_mode is 'workflow'")
            
            result = await call_run_agent_endpoint(
                account_id, agent_id, message, execution_mode, workflow_id, output_mode, max_tokens, model_name
            )
        else:
            raise ValueError(f"Unknown tool: {tool_name}")
        
        # Return MCP-compatible tool call result
        return {
            "content": [{
                "type": "text",
                "text": result
            }]
        }
        
    except Exception as e:
        logger.error(f"Error in tool call {tool_name}: {str(e)}")
        raise e


async def call_get_agents_endpoint(account_id: str) -> str:
    """Call the existing /agents endpoint and format for MCP."""
    try:
        # Import the get_agents function from agent.api
        from agent.api import get_agents
        
        # Call the existing endpoint
        response = await get_agents(
            user_id=account_id,
            page=1,
            limit=100,  # Get all agents
            search=None,
            sort_by="created_at",
            sort_order="desc",
            has_default=None,
            has_mcp_tools=None,
            has_agentpress_tools=None,
            tools=None
        )
        
        # Handle both dict and object response formats
        if hasattr(response, 'agents'):
            agents = response.agents
        elif isinstance(response, dict) and 'agents' in response:
            agents = response['agents']
        else:
            logger.error(f"Unexpected response format from get_agents: {type(response)}")
            return f"Error: Unexpected response format from get_agents: {response}"
        
        if not agents:
            return "No agents found in your account. Create some agents first in your frontend."
        
        agent_list = "🤖 Available Agents in Your Account:\n\n"
        for i, agent in enumerate(agents, 1):
            # Handle both dict and object formats for individual agents
            agent_id = agent.agent_id if hasattr(agent, 'agent_id') else agent.get('agent_id')
            name = agent.name if hasattr(agent, 'name') else agent.get('name')
            description = agent.description if hasattr(agent, 'description') else agent.get('description')
            
            agent_list += f"{i}. Agent ID: {agent_id}\n"
            agent_list += f"   Name: {name}\n"
            if description:
                agent_list += f"   Description: {description}\n"
            agent_list += "\n"
        
        agent_list += "📝 Use the 'run_agent' tool with the Agent ID to invoke any of these agents."
        
        logger.info(f"Listed {len(agents)} agents via MCP")
        return agent_list
        
    except Exception as e:
        logger.error(f"Error in get_agent_list: {str(e)}")
        return f"Error listing agents: {str(e)}"


async def verify_agent_access(agent_id: str, account_id: str):
    """Verify account has access to the agent."""
    try:
        client = await db.client
        result = await client.table('agents').select('agent_id').eq('agent_id', agent_id).eq('account_id', account_id).execute()
        
        if not result.data:
            raise ValueError("Agent not found or access denied")
    except Exception as e:
        logger.error(f"Database error in verify_agent_access: {str(e)}")
        raise ValueError("Database connection error")


async def call_get_agent_workflows_endpoint(account_id: str, agent_id: str) -> str:
    """Get workflows for a specific agent."""
    try:
        # Verify agent access
        await verify_agent_access(agent_id, account_id)
        
        # Get workflows from database
        client = await db.client
        result = await client.table('agent_workflows').select('*').eq('agent_id', agent_id).order('created_at', desc=True).execute()
        
        if not result.data:
            return f"No workflows found for agent {agent_id}. This agent can only be run with custom prompts."
        
        workflow_list = f"🔄 Available Workflows for Agent {agent_id}:\n\n"
        for i, workflow in enumerate(result.data, 1):
            workflow_list += f"{i}. Workflow ID: {workflow['id']}\n"
            workflow_list += f"   Name: {workflow['name']}\n"
            if workflow.get('description'):
                workflow_list += f"   Description: {workflow['description']}\n"
            workflow_list += f"   Status: {workflow.get('status', 'unknown')}\n"
            workflow_list += "\n"
        
        workflow_list += "📝 Use the 'run_agent' tool with execution_mode='workflow' and the Workflow ID to run a workflow."
        
        logger.info(f"Listed {len(result.data)} workflows for agent {agent_id} via MCP")
        return workflow_list
        
    except Exception as e:
        logger.error(f"Error in get_agent_workflows: {str(e)}")
        return f"Error listing workflows: {str(e)}"


async def call_run_agent_endpoint(
    account_id: str, 
    agent_id: str, 
    message: str, 
    execution_mode: str = "prompt",
    workflow_id: Optional[str] = None,
    output_mode: str = "last_message", 
    max_tokens: int = 1000,
    model_name: Optional[str] = None
) -> str:
    """Call the existing agent run endpoints and format for MCP."""
    try:
        # Validate execution mode and workflow parameters
        if execution_mode not in ["prompt", "workflow"]:
            return "Error: execution_mode must be either 'prompt' or 'workflow'"
        
        if execution_mode == "workflow" and not workflow_id:
            return "Error: workflow_id is required when execution_mode is 'workflow'"
        
        # Verify agent access
        await verify_agent_access(agent_id, account_id)
        
        # Apply model fallback if no model specified
        if not model_name:
            # Use a reliable free-tier model as fallback
            model_name = "openrouter/google/gemini-2.5-flash"
            logger.info(f"No model specified for agent {agent_id}, using fallback: {model_name}")
        
        if execution_mode == "workflow":
            # Execute workflow using the existing workflow execution endpoint
            result = await execute_agent_workflow_internal(agent_id, workflow_id, message, account_id, model_name)
        else:
            # Execute agent with prompt using existing agent endpoints
            result = await execute_agent_prompt_internal(agent_id, message, account_id, model_name)
        
        # Process the output based on the requested mode
        if output_mode == "last_message":
            processed_output = extract_last_message(result)
        else:
            processed_output = result
        
        # Apply token limiting
        final_output = truncate_from_end(processed_output, max_tokens)
        
        logger.info(f"MCP agent run completed for agent {agent_id} in {execution_mode} mode")
        return final_output
        
    except Exception as e:
        logger.error(f"Error running agent {agent_id}: {str(e)}")
        return f"Error running agent: {str(e)}"


async def execute_agent_workflow_internal(agent_id: str, workflow_id: str, message: str, account_id: str, model_name: Optional[str] = None) -> str:
    """Execute an agent workflow."""
    try:
        client = await db.client
        
        # Verify workflow exists and is active
        workflow_result = await client.table('agent_workflows').select('*').eq('id', workflow_id).eq('agent_id', agent_id).execute()
        if not workflow_result.data:
            return f"Error: Workflow {workflow_id} not found for agent {agent_id}"
        
        workflow = workflow_result.data[0]
        if workflow.get('status') != 'active':
            return f"Error: Workflow {workflow['name']} is not active (status: {workflow.get('status')})"
        
        # Execute workflow through the execution service
        try:
            from triggers.execution_service import execute_workflow
            
            # Execute the workflow with the provided message
            execution_result = await execute_workflow(
                workflow_id=workflow_id,
                agent_id=agent_id,
                input_data={"message": message},
                user_id=account_id
            )
            
            if execution_result.get('success'):
                return execution_result.get('output', f"Workflow '{workflow['name']}' executed successfully")
            else:
                return f"Workflow execution failed: {execution_result.get('error', 'Unknown error')}"
                
        except ImportError:
            logger.warning("Execution service not available, using fallback workflow execution")
            # Fallback: Create a thread and run the agent with workflow context
            from agent.api import create_thread, add_message_to_thread, start_agent, AgentStartRequest
            
            # Create thread with workflow context
            thread_response = await create_thread(
                name=f"Workflow: {workflow['name']}", 
                user_id=account_id
            )
            thread_id = thread_response.get('thread_id') if isinstance(thread_response, dict) else thread_response.thread_id
            
            # Add workflow context message
            workflow_context = f"Executing workflow '{workflow['name']}'"
            if workflow.get('description'):
                workflow_context += f": {workflow['description']}"
            workflow_context += f"\n\nUser message: {message}"
            
            await add_message_to_thread(
                thread_id=thread_id,
                message=workflow_context,
                user_id=account_id
            )
            
            # Start agent with workflow execution
            agent_request = AgentStartRequest(
                agent_id=agent_id,
                enable_thinking=False,
                stream=False,
                model_name=model_name
            )
            
            await start_agent(
                thread_id=thread_id,
                body=agent_request,
                user_id=account_id
            )
            
            # Wait for completion (similar to prompt execution)
            client = await db.client
            max_wait = 90  # Longer timeout for workflows
            poll_interval = 3
            elapsed = 0
            
            while elapsed < max_wait:
                messages_result = await client.table('messages').select('*').eq('thread_id', thread_id).order('created_at', desc=True).limit(5).execute()
                
                if messages_result.data:
                    for msg in messages_result.data:
                        # Parse JSON content to check role
                        content = msg.get('content')
                        if content:
                            try:
                                import json
                                if isinstance(content, str):
                                    parsed_content = json.loads(content)
                                else:
                                    parsed_content = content
                                
                                if parsed_content.get('role') == 'assistant':
                                    return parsed_content.get('content', '')
                            except:
                                # If parsing fails, check if it's a direct assistant message
                                if msg.get('type') == 'assistant':
                                    return content
                
                runs_result = await client.table('agent_runs').select('status, error').eq('thread_id', thread_id).order('created_at', desc=True).limit(1).execute()
                
                if runs_result.data:
                    run = runs_result.data[0]
                    if run['status'] in ['completed', 'failed', 'cancelled']:
                        if run['status'] == 'failed':
                            return f"Workflow execution failed: {run.get('error', 'Unknown error')}"
                        elif run['status'] == 'cancelled':
                            return "Workflow execution was cancelled"
                        break
                
                await asyncio.sleep(poll_interval)
                elapsed += poll_interval
            
            return f"Workflow '{workflow['name']}' execution timed out after {max_wait}s. Thread ID: {thread_id}"
        
    except Exception as e:
        logger.error(f"Error executing workflow {workflow_id}: {str(e)}")
        return f"Error executing workflow: {str(e)}"


async def execute_agent_prompt_internal(agent_id: str, message: str, account_id: str, model_name: Optional[str] = None) -> str:
    """Execute an agent with a custom prompt."""
    try:
        # Import existing agent execution functions
        from agent.api import create_thread, add_message_to_thread, start_agent, AgentStartRequest
        
        # Create a new thread
        thread_response = await create_thread(name="MCP Agent Run", user_id=account_id)
        thread_id = thread_response.get('thread_id') if isinstance(thread_response, dict) else thread_response.thread_id
        
        # Add the message to the thread
        await add_message_to_thread(
            thread_id=thread_id,
            message=message,
            user_id=account_id
        )
        
        # Start the agent
        agent_request = AgentStartRequest(
            agent_id=agent_id,
            enable_thinking=False,
            stream=False,
            model_name=model_name
        )
        
        # Start the agent
        await start_agent(
            thread_id=thread_id,
            body=agent_request,
            user_id=account_id
        )
        
        # Wait for agent completion and get response
        client = await db.client
        
        # Poll for completion (max 60 seconds)
        max_wait = 60
        poll_interval = 2
        elapsed = 0
        
        while elapsed < max_wait:
            # Check thread messages for agent response
            messages_result = await client.table('messages').select('*').eq('thread_id', thread_id).order('created_at', desc=True).limit(5).execute()
            
            if messages_result.data:
                # Look for the most recent agent message (not user message)
                for msg in messages_result.data:
                    # Parse JSON content to check role
                    content = msg.get('content')
                    if content:
                        try:
                            import json
                            if isinstance(content, str):
                                parsed_content = json.loads(content)
                            else:
                                parsed_content = content
                            
                            if parsed_content.get('role') == 'assistant':
                                return parsed_content.get('content', '')
                        except:
                            # If parsing fails, check if it's a direct assistant message
                            if msg.get('type') == 'assistant':
                                return content
            
            # Check if agent run is complete by checking agent_runs table
            runs_result = await client.table('agent_runs').select('status, error').eq('thread_id', thread_id).order('created_at', desc=True).limit(1).execute()
            
            if runs_result.data:
                run = runs_result.data[0]
                if run['status'] in ['completed', 'failed', 'cancelled']:
                    if run['status'] == 'failed':
                        return f"Agent execution failed: {run.get('error', 'Unknown error')}"
                    elif run['status'] == 'cancelled':
                        return "Agent execution was cancelled"
                    # If completed, continue to check for messages
                    break
            
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval
        
        # Timeout fallback - get latest messages
        messages_result = await client.table('messages').select('*').eq('thread_id', thread_id).order('created_at', desc=True).limit(10).execute()
        
        if messages_result.data:
            # Return the most recent assistant message or fallback message
            for msg in messages_result.data:
                # Parse JSON content to check role
                content = msg.get('content')
                if content:
                    try:
                        import json
                        if isinstance(content, str):
                            parsed_content = json.loads(content)
                        else:
                            parsed_content = content
                        
                        if parsed_content.get('role') == 'assistant':
                            return parsed_content.get('content', '')
                    except:
                        # If parsing fails, check if it's a direct assistant message
                        if msg.get('type') == 'assistant':
                            return content
            
            return f"Agent execution timed out after {max_wait}s. Thread ID: {thread_id}"
        
        return f"No response received from agent {agent_id}. Thread ID: {thread_id}"
        
    except Exception as e:
        logger.error(f"Error executing agent prompt: {str(e)}")
        return f"Error executing agent: {str(e)}"



@mcp_router.get("/health")
async def mcp_health_check():
    """Health check for MCP layer"""
    return {"status": "healthy", "service": "mcp-kortix-layer"}


# OAuth 2.0 endpoints for Claude Code compatibility
@mcp_router.get("/oauth/authorize")
async def oauth_authorize(
    response_type: str = None,
    client_id: str = None, 
    redirect_uri: str = None,
    scope: str = None,
    state: str = None,
    code_challenge: str = None,
    code_challenge_method: str = None
):
    """OAuth authorization endpoint - redirect with authorization code"""
    from fastapi.responses import RedirectResponse
    import secrets
    
    # Generate a dummy authorization code (since we use API keys)
    auth_code = f"ac_{secrets.token_urlsafe(32)}"
    
    # Build redirect URL with authorization code and state
    redirect_url = f"{redirect_uri}?code={auth_code}"
    if state:
        redirect_url += f"&state={state}"
    
    logger.info(f"OAuth authorize redirecting to: {redirect_url}")
    return RedirectResponse(url=redirect_url)


@mcp_router.post("/oauth/token")
async def oauth_token(
    grant_type: str = None,
    code: str = None,
    redirect_uri: str = None,
    client_id: str = None,
    client_secret: str = None,
    code_verifier: str = None
):
    """OAuth token endpoint - simplified for API key flow with PKCE support"""
    return {
        "access_token": "use_api_key_instead",
        "token_type": "bearer", 
        "message": "AgentPress MCP Server uses API key authentication",
        "instructions": "Use your API key as Bearer token: Authorization: Bearer pk_xxx:sk_xxx",
        "pkce_supported": True
    }


@mcp_router.options("/")
@mcp_router.options("")  # Handle OPTIONS without trailing slash
async def mcp_options():
    """Handle CORS preflight for MCP endpoint"""
    return Response(
        status_code=200,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id"
        }
    )


@mcp_router.get("/.well-known/mcp")
async def mcp_discovery():
    """MCP discovery endpoint for Claude Code"""
    return {
        "mcpVersion": "2024-11-05",
        "capabilities": {
            "tools": {}
        },
        "implementation": {
            "name": "AgentPress MCP Server",
            "version": "1.0.0"
        },
        "oauth": {
            "authorization_endpoint": "/api/mcp/oauth/authorize",
            "token_endpoint": "/api/mcp/oauth/token",
            "supported_flows": ["authorization_code"]
        },
        "instructions": "Use API key authentication via Authorization header: Bearer pk_xxx:sk_xxx"
    }


@mcp_router.get("/")
@mcp_router.get("")
async def mcp_health():
    """Health check endpoint for MCP server"""
    return {
        "status": "healthy",
        "service": "agentpress-mcp-server", 
        "version": "1.0.0",
        "timestamp": datetime.now().isoformat()
    }