from typing import Union
from enum import Enum
from fastmcp import Client as FastMCPClient


class MCPTools:
    def __init__(
        self, endpoint: str, name: str, allowed_tools: list[str] | None = None
    ):
        self._mcp_client = FastMCPClient(endpoint)
        self.url = endpoint
        self.name = name
        self.type = "http"
        self._initialized = False
        self._allowed_tools = allowed_tools
        self.enabled_tools: list[str] = []

    async def initialize(self):
        async with self._mcp_client:
            tools = await self._mcp_client.list_tools()

        if self._allowed_tools:
            for tool in tools:
                if tool.name in self._allowed_tools:
                    self.enabled_tools.append(tool.name)
        else:
            self.enabled_tools = [tool.name for tool in tools]
        self._initialized = True
        return self


_AgentPressTools_descriptions = {
    "sb_files_tool": "Read, write, and edit files",
    "sb_shell_tool": "Execute shell commands",
    # "sb_web_dev_tool": "Create and manage modern web applications with Next.js and shadcn/ui",  # DEACTIVATED
    "sb_deploy_tool": "Deploy web applications",
    "sb_expose_tool": "Expose local services to the internet",
    "sb_vision_tool": "Analyze and understand images",
    "browser_tool": "Browse websites and interact with web pages",
    "web_search_tool": "Search the web for information",
    "sb_image_edit_tool": "Edit and manipulate images",
    "data_providers_tool": "Access structured data from various providers",
}


class AgentPressTools(str, Enum):
    SB_FILES_TOOL = "sb_files_tool"
    SB_SHELL_TOOL = "sb_shell_tool"
    # SB_WEB_DEV_TOOL = "sb_web_dev_tool"  # DEACTIVATED
    SB_DEPLOY_TOOL = "sb_deploy_tool"
    SB_EXPOSE_TOOL = "sb_expose_tool"
    SB_VISION_TOOL = "sb_vision_tool"
    BROWSER_TOOL = "browser_tool"
    WEB_SEARCH_TOOL = "web_search_tool"
    DATA_PROVIDERS_TOOL = "data_providers_tool"

    def get_description(self) -> str:
        global _AgentPressTools_descriptions
        desc = _AgentPressTools_descriptions.get(self.value)
        if not desc:
            raise ValueError(f"No description found for {self.value}")
        return desc


KortixTools = Union[AgentPressTools, MCPTools]
