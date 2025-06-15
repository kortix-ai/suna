# Initialize the triggers subsystem

from services.supabase import DBConnection
from utils.logger import logger
from typing import Optional


db: Optional[DBConnection] = None


def initialize(_db: DBConnection):
    """Store a shared DBConnection instance so the triggers subsystem can reuse it."""
    global db
    db = _db
    logger.info("Initialized triggers subsystem DB connection") 