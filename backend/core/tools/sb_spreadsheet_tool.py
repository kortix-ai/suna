from typing import Dict, Any, List, Optional, Union
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
import json

SPREADSHEET_DIR = "/workspace/spreadsheets"

def safe_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)


def parse_cell_address(cell: str) -> tuple[int, int]:
    col, row = "", ""
    for ch in cell:
        if ch.isalpha():
            col += ch.upper()
        else:
            row += ch
    col_idx = 0
    for c in col:
        col_idx = col_idx * 26 + (ord(c) - 64)
    return int(row) - 1, col_idx - 1


def update_used_range(sheet: Dict[str, Any], row: int, col: int):
    used = sheet.get("usedRange", {"rowIndex": 0, "colIndex": 0})
    used["rowIndex"] = max(used.get("rowIndex", 0), row)
    used["colIndex"] = max(used.get("colIndex", 0), col)
    sheet["usedRange"] = used


def create_empty_spreadsheet(name="Sheet1") -> Dict[str, Any]:
    return {
        "version": "1.0",
        "sheets": [{
            "name": name,
            "rows": [],
            "columns": [{"width": 100} for _ in range(26)],
            "usedRange": {"rowIndex": 0, "colIndex": 0}
        }],
        "activeSheet": 0
    }


@tool_metadata(
    display_name="Spreadsheet Tool",
    description="Agent-controlled spreadsheet with formulas and formatting",
    icon="Table",
    color="bg-green-100 dark:bg-green-800/50",
    weight=75,
    visible=True,
    usage_guide="""
### SPREADSHEET TOOL

**FUNCTIONS:**
- `spreadsheet_create(file_path, headers, rows)` - Create spreadsheet
- `spreadsheet_batch_update(file_path, requests)` - Batch update/format

**BATCH UPDATE EXAMPLES:**
```
spreadsheet_batch_update(
    file_path="budget.json",
    requests=[
        {
            "type": "update_cell",
            "cell": "A1",
            "value": "Updated Value"
        },
        {
            "type": "format_cells",
            "range": "A1:B2",
            "style": {
                "background_color": "#4CAF50",
                "bold": true
            }
        }
    ]
)
```
**COLORS:** #4CAF50 (green), #F44336 (red), #2196F3 (blue), #FFC107 (yellow)

**RULES:**
- Files auto-save to /workspace/spreadsheets/
- Formulas start with = (e.g., =SUM(A1:A10))
- Headers get dark blue styling automatically
"""
)
class SandboxSpreadsheetTool(SandboxToolsBase):

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)

    async def _ensure_dir(self):
        await self._ensure_sandbox()
        try:
            await self.sandbox.fs.get_file_info(SPREADSHEET_DIR)
        except Exception:
            await self.sandbox.fs.create_folder(SPREADSHEET_DIR, "755")

    async def _load(self, file_path: str) -> Dict[str, Any]:
        try:
            await self._ensure_sandbox()
            content = await self.sandbox.fs.download_file(file_path)
            data = json.loads(content.decode())
            if "sheets" not in data:
                return create_empty_spreadsheet()
            return data
        except Exception:
            return create_empty_spreadsheet()

    async def _save(self, data: Dict[str, Any], file_path: str) -> bool:
        try:
            await self._ensure_dir()
            await self.sandbox.fs.upload_file(
                json.dumps(data, indent=2).encode(),
                file_path
            )
            return True
        except Exception as e:
            logger.error(f"Spreadsheet save failed: {e}")
            return False

    def _apply_add_rows(self, sheet: Dict[str, Any], rows: List[List[Any]]):
        sheet_rows = sheet.setdefault("rows", [])
        start_row = len(sheet_rows)

        for r in rows:
            sheet_rows.append({
                "cells": [{"value": safe_str(c)} for c in r]
            })

        if rows:
            update_used_range(sheet, start_row + len(rows) - 1, len(rows[0]) - 1)

    def _apply_update_cell(self, sheet: Dict[str, Any], cell: str, value: str):
        rows = sheet.setdefault("rows", [])
        r, c = parse_cell_address(cell)
        while len(rows) <= r:
            rows.append({"cells": []})

        cells = rows[r].setdefault("cells", [])
        while len(cells) <= c:
            cells.append({})

        if value.startswith("="):
            cells[c]["formula"] = value
        else:
            cells[c]["value"] = safe_str(value)
            if "formula" in cells[c]:
                del cells[c]["formula"]

        update_used_range(sheet, r, c)

    def _apply_format_cells(self, sheet: Dict[str, Any], cell_range: str, style_params: Dict[str, Any]):
        rows = sheet.setdefault("rows", [])
        style = {}
        bg = style_params.get("background_color")
        if bg: style["backgroundColor"] = bg
        
        fg = style_params.get("text_color")
        if fg: style["color"] = fg
        
        if style_params.get("bold"): style["fontWeight"] = "bold"
        if style_params.get("italic"): style["fontStyle"] = "italic"
        
        sz = style_params.get("font_size")
        if sz: style["fontSize"] = f"{sz}pt"
        
        align = style_params.get("text_align")
        if align: style["textAlign"] = align

        start, end = cell_range.split(":") if ":" in cell_range else (cell_range, cell_range)
        sr, sc = parse_cell_address(start)
        er, ec = parse_cell_address(end)

        for r in range(sr, er + 1):
            while len(rows) <= r:
                rows.append({"cells": []})
            cells = rows[r].setdefault("cells", [])
            for c in range(sc, ec + 1):
                while len(cells) <= c:
                    cells.append({})
                cells[c].setdefault("style", {}).update(style)

        update_used_range(sheet, er, ec)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "spreadsheet_batch_update",
            "required": ["file_path", "requests"],
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string"},
                    "requests": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {
                                    "type": "string",
                                    "enum": ["update_cell", "format_cells", "add_rows"]
                                },
                                "cell": {"type": "string"},
                                "value": {"type": "string"},
                                "range": {"type": "string"},
                                "style": {
                                    "type": "object",
                                    "properties": {
                                        "background_color": {"type": "string"},
                                        "text_color": {"type": "string"},
                                        "bold": {"type": "boolean"},
                                        "italic": {"type": "boolean"},
                                        "font_size": {"type": "integer"},
                                        "text_align": {"type": "string"}
                                    }
                                },
                                "rows": {
                                    "type": "array",
                                    "items": {"type": "array"}
                                }
                            },
                            "required": ["type"]
                        }
                    }
                }
            }
        }
    })
    async def spreadsheet_batch_update(
        self,
        file_path: str,
        requests: List[Dict[str, Any]]
    ) -> ToolResult:
        
        data = await self._load(file_path)
        sheet = data["sheets"][0]

        for req in requests:
            req_type = req.get("type")
            
            if req_type == "update_cell":
                if "cell" in req and "value" in req:
                    self._apply_update_cell(sheet, req["cell"], req["value"])
            
            elif req_type == "format_cells":
                rng = req.get("range") or req.get("cell_range")
                style = req.get("style", {})
                if rng:
                    self._apply_format_cells(sheet, rng, style)

            elif req_type == "add_rows":
                if "rows" in req:
                    self._apply_add_rows(sheet, req["rows"])

        if not await self._save(data, file_path):
            return self.fail_response("Batch save failed")

        return self.success_response({"processed": len(requests)})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "spreadsheet_create",
            "required": ["file_path", "headers", "rows"],
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string"},
                    "sheet_name": {"type": "string"},
                    "headers": {"type": "array", "items": {"type": "string"}},
                    "rows": {"type": "array", "items": {"type": "array"}}
                }
            }
        }
    })
    async def spreadsheet_create(
        self,
        file_path: str,
        headers: List[str],
        rows: List[List[Any]],
        sheet_name: str = "Sheet1"
    ) -> ToolResult:

        file_path = f"/workspace/spreadsheets/{file_path.split('/')[-1].replace('.json','')}.json"

        header_cells = [{
            "value": safe_str(h),
            "style": {
                "fontWeight": "bold",
                "backgroundColor": "#1F4E79",
                "color": "#FFFFFF"
            }
        } for h in headers]

        sheet_rows = [{"cells": header_cells}]
        for r in rows:
            sheet_rows.append({
                "cells": [{"value": safe_str(c)} for c in r]
            })

        sheet = {
            "name": sheet_name,
            "rows": sheet_rows,
            "columns": [{"width": 100} for _ in range(max(len(headers), 26))],
            "usedRange": {
                "rowIndex": len(sheet_rows) - 1,
                "colIndex": len(headers) - 1
            }
        }

        data = {
            "version": "1.0",
            "sheets": [sheet],
            "activeSheet": 0
        }

        if not await self._save(data, file_path):
            return self.fail_response("Failed to save spreadsheet")

        return self.success_response({"file_path": file_path})
