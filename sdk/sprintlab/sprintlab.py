from .api import agents, threads
from .agent import SprintLabAgent
from .thread import SprintLabThread
from .tools import AgentPressTools, MCPTools


class SprintLab:
    def __init__(self, api_key: str, api_url="https://api.sprintlab.com/v1"):
        self._agents_client = agents.create_agents_client(api_url, api_key)
        self._threads_client = threads.create_threads_client(api_url, api_key)

        self.Agent = SprintLabAgent(self._agents_client)
        self.Thread = SprintLabThread(self._threads_client)
