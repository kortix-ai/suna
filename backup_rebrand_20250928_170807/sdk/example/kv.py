import json
import os
from typing import Any, Optional
from dotenv import load_dotenv

load_dotenv("./.env")


# Local key-value store for storing agent and thread IDs
class LocalKVStore:
    def __init__(self, filename: str = ".kvstore.json"):
        self.filename = filename
        self._data = {}
        self._load()

    def _load(self):
        if os.path.exists(self.filename):
            try:
                with open(self.filename, "r", encoding="utf-8") as f:
                    self._data = json.load(f)
            except Exception:
                self._data = {}
        else:
            self._data = {}

    def _save(self):
        with open(self.filename, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2)

    def get(self, key: str, default: Optional[Any] = None) -> Any:
        return self._data.get(key, default)

    def set(self, key: str, value: Any):
        self._data[key] = value
        self._save()

    def delete(self, key: str):
        if key in self._data:
            del self._data[key]
            self._save()

    def clear(self):
        self._data = {}
        self._save()


kv = LocalKVStore()
