from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional
from core.services.supabase import DBConnection

class BaseRepository(ABC):
    def __init__(self):
        self._db = None
    
    async def _get_client(self):
        if not self._db:
            self._db = DBConnection()
        return await self._db.client
