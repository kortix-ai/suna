from .api import agents, threads
from .agent import AdenticAgent
from .thread import AdenticThread
from .tools import AgentPressTools, MCPTools


class Adentic:
    def __init__(self, api_key: str, api_url="https://adentic.so/api"):
        self._agents_client = agents.create_agents_client(api_url, api_key)
        self._threads_client = threads.create_threads_client(api_url, api_key)

        self.Agent = AdenticAgent(self._agents_client)
        self.Thread = AdenticThread(self._threads_client)
