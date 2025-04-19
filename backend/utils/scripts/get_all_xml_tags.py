import sys
import os
from uuid import uuid4
from dotenv import load_dotenv

# Add the backend directory to the Python path
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
backend_dir = os.path.join(project_root, 'backend')
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

# Load environment variables
load_dotenv()

# Import ThreadManager and tools
from agentpress.thread_manager import ThreadManager
from agent.tools.sb_shell_tool import SandboxShellTool
from agent.tools.sb_files_tool import SandboxFilesTool
from agent.tools.sb_browser_tool import SandboxBrowserTool
from agent.tools.sb_deploy_tool import SandboxDeployTool
from agent.tools.message_tool import MessageTool
from agent.tools.web_search_tool import WebSearchTool
from agent.tools.data_providers_tool import DataProvidersTool

# Simple mock sandbox with minimal required attributes
class MockSandbox:
    def __init__(self):
        self.id = "sandbox-6005d12f"

# Get and print all XML tags
if __name__ == "__main__":
    # Initialize ThreadManager
    thread_manager = ThreadManager()
    
    # Create a simple mock sandbox
    mock_sandbox = MockSandbox()
    
    # Register all tools
    thread_manager.add_tool(SandboxShellTool, sandbox=mock_sandbox)
    thread_manager.add_tool(SandboxFilesTool, sandbox=mock_sandbox)
    thread_manager.add_tool(SandboxBrowserTool, sandbox=mock_sandbox, thread_id="mock-thread-id", thread_manager=thread_manager)
    thread_manager.add_tool(SandboxDeployTool, sandbox=mock_sandbox)
    thread_manager.add_tool(MessageTool)
    
    # Conditionally register API-dependent tools
    if os.getenv("TAVILY_API_KEY"):
        thread_manager.add_tool(WebSearchTool)
        
    if os.getenv("RAPID_API_KEY"):
        thread_manager.add_tool(DataProvidersTool)
    
    # Get XML examples
    xml_examples = thread_manager.tool_registry.get_xml_examples()
    
    # Print all XML tags in requested format
    print("\nXML Tags:")
    for tag_name in xml_examples.keys():
        print(f"<{tag_name}></{tag_name}>")
