from .api import agents, threads
from .agent import KortixAgent
from .thread import KortixThread
from .tools import AgentPressTools, MCPTools


class Kortix:
    def __init__(self, api_key: str, api_url="https://suna.so/api"):
        self._agents_client = agents.create_agents_client(api_url, api_key)
        self._threads_client = threads.create_threads_client(api_url, api_key)

        self.Agent = KortixAgent(self._agents_client)
        self.Thread = KortixThread(self._threads_client)
