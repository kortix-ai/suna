from typing import Optional, Dict, Any, List
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.tool_output_streaming_context import (
    get_tool_output_streaming_context,
    get_current_tool_call_id,
    stream_tool_output,
)
import json
import asyncio
from uuid import uuid4


SPREADSHEET_DIR = "/workspace/spreadsheets"
DEFAULT_SPREADSHEET_FILE = f"{SPREADSHEET_DIR}/spreadsheet.json"


def parse_cell_address(cell: str) -> tuple:
    col_str = ""
    row_str = ""
    for char in cell:
        if char.isalpha():
            col_str += char.upper()
        else:
            row_str += char
    
    col_num = 0
    for char in col_str:
        col_num = col_num * 26 + (ord(char) - ord('A') + 1)
    col_num -= 1
    
    row_num = int(row_str) - 1 if row_str else 0
    return row_num, col_num


def get_column_letter(col_index: int) -> str:
    result = ""
    col_index += 1
    while col_index > 0:
        col_index -= 1
        result = chr(ord('A') + col_index % 26) + result
        col_index //= 26
    return result


def create_empty_spreadsheet() -> Dict[str, Any]:
    return {
        "version": "1.0",
        "sheets": [
            {
                "name": "Sheet1",
                "cells": {},
                "columns": {str(i): {"width": 120} for i in range(26)},
                "rowCount": 100,
                "colCount": 26,
                "frozenRows": 0,
                "frozenColumns": 0
            }
        ],
        "activeSheet": 0
    }


@tool_metadata(
    display_name="Spreadsheet Tool",
    description="Create and manipulate spreadsheets saved as JSON files",
    icon="Table",
    color="bg-green-100 dark:bg-green-800/50",
    weight=220,
    visible=True,
    usage_guide="""
### SPREADSHEET TOOL - FILE-BASED SPREADSHEET OPERATIONS

This tool creates and manipulates spreadsheets stored as JSON files.
All data is persisted to `/workspace/spreadsheets/spreadsheet.json`.

## AVAILABLE FUNCTIONS:

### 1. spreadsheet_populate_data() - BULK DATA POPULATION
Primary tool for creating structured tables with headers and data rows.

### 2. spreadsheet_update_cells() - UPDATE SPECIFIC CELLS
Update individual cells without clearing existing data.

### 3. spreadsheet_format_range() - FORMAT CELL RANGES
Apply formatting to a range of cells.

### 4. spreadsheet_clear_range() - CLEAR CELL RANGES
Clear values from a range of cells.

### 5. spreadsheet_get_data() - READ SPREADSHEET DATA
Read current spreadsheet data from the file.
"""
)
class SandboxSpreadsheetTool(SandboxToolsBase):
    
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
    
    async def _ensure_spreadsheet_dir(self) -> bool:
        try:
            await self._ensure_sandbox()
            try:
                await self.sandbox.fs.get_file_info(SPREADSHEET_DIR)
            except Exception:
                await self.sandbox.fs.create_folder(SPREADSHEET_DIR, "755")
            return True
        except Exception as e:
            logger.warning(f"Failed to create spreadsheet directory: {e}")
            return False
    
    async def _file_exists(self, path: str) -> bool:
        try:
            await self.sandbox.fs.get_file_info(path)
            return True
        except Exception:
            return False
    
    async def _load_spreadsheet(self, file_path: str = DEFAULT_SPREADSHEET_FILE) -> Dict[str, Any]:
        try:
            await self._ensure_sandbox()
            if await self._file_exists(file_path):
                content = await self.sandbox.fs.download_file(file_path)
                return json.loads(content.decode())
            return create_empty_spreadsheet()
        except Exception as e:
            logger.warning(f"Failed to load spreadsheet: {e}")
            return create_empty_spreadsheet()
    
    async def _save_spreadsheet(self, data: Dict[str, Any], file_path: str = DEFAULT_SPREADSHEET_FILE) -> bool:
        try:
            await self._ensure_spreadsheet_dir()
            content = json.dumps(data, indent=2)
            await self.sandbox.fs.upload_file(content.encode(), file_path)
            return True
        except Exception as e:
            logger.error(f"Failed to save spreadsheet: {e}")
            return False
    
    async def _stream_file_update(self, tool_call_id: str, file_path: str, action: str, details: Dict[str, Any] = None):
        try:
            message = json.dumps({
                "type": "spreadsheet_file_update",
                "file_path": file_path,
                "action": action,
                "details": details or {},
                "timestamp": asyncio.get_event_loop().time()
            })
            await stream_tool_output(
                tool_call_id=tool_call_id,
                output_chunk=message,
                is_final=False,
                tool_name="spreadsheet"
            )
        except Exception as e:
            logger.warning(f"Failed to stream file update: {e}")
    
    def _update_cell_in_data(self, data: Dict, sheet_index: int, cell: str, 
                              value: str = None, formula: str = None, style: Dict = None) -> Dict:
        if sheet_index >= len(data["sheets"]):
            while len(data["sheets"]) <= sheet_index:
                data["sheets"].append({
                    "name": f"Sheet{len(data['sheets']) + 1}",
                    "cells": {},
                    "columns": {str(i): {"width": 120} for i in range(26)},
                    "rowCount": 100,
                    "colCount": 26
                })
        
        sheet = data["sheets"][sheet_index]
        if "cells" not in sheet:
            sheet["cells"] = {}
        
        if cell not in sheet["cells"]:
            sheet["cells"][cell] = {}
        
        if value is not None:
            sheet["cells"][cell]["value"] = value
        if formula is not None:
            sheet["cells"][cell]["formula"] = formula
        if style is not None:
            if "style" not in sheet["cells"][cell]:
                sheet["cells"][cell]["style"] = {}
            sheet["cells"][cell]["style"].update(style)
        
        return data

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "spreadsheet_populate_data",
            "description": "Populate spreadsheet with structured data (headers + rows). Creates or updates a spreadsheet JSON file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "headers": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Column headers"
                    },
                    "rows": {
                        "type": "array",
                        "items": {
                            "type": "array",
                            "items": {"type": "string"}
                        },
                        "description": "Data rows (2D array)"
                    },
                    "file_path": {
                        "type": "string",
                        "description": "Path to save the spreadsheet JSON. Default: /workspace/spreadsheets/spreadsheet.json"
                    },
                    "start_cell": {
                        "type": "string",
                        "description": "Starting cell for data. Default: 'A1'",
                        "default": "A1"
                    },
                    "header_style": {
                        "type": "object",
                        "description": "Style for header row",
                        "default": {
                            "fontWeight": "bold",
                            "backgroundColor": "#1F4E79",
                            "color": "#FFFFFF",
                            "textAlign": "center"
                        }
                    },
                    "include_totals": {
                        "type": "boolean",
                        "description": "Auto-add SUM formulas row. Default: false"
                    },
                    "sheet_index": {
                        "type": "integer",
                        "description": "Sheet index. Default: 0"
                    }
                },
                "required": ["headers", "rows"]
            }
        }
    })
    async def spreadsheet_populate_data(
        self,
        headers: List[str],
        rows: List[List[str]],
        file_path: str = DEFAULT_SPREADSHEET_FILE,
        start_cell: str = "A1",
        header_style: Optional[Dict[str, Any]] = None,
        data_style: Optional[Dict[str, Any]] = None,
        include_totals: bool = False,
        sheet_index: int = 0
    ) -> ToolResult:
        try:
            tool_call_id = get_current_tool_call_id() or f"ss_{str(uuid4())[:8]}"
            
            if header_style is None:
                header_style = {
                    "fontWeight": "bold",
                    "backgroundColor": "#1F4E79",
                    "color": "#FFFFFF",
                    "textAlign": "center"
                }
            
            data = await self._load_spreadsheet(file_path)
            start_row, start_col = parse_cell_address(start_cell)
            
            await self._stream_file_update(tool_call_id, file_path, "start", {
                "total_rows": len(rows) + 1,
                "total_cols": len(headers)
            })
            
            for col_idx, header in enumerate(headers):
                cell = f"{get_column_letter(start_col + col_idx)}{start_row + 1}"
                data = self._update_cell_in_data(data, sheet_index, cell, 
                                                  value=header, style=header_style)
            
            for row_idx, row in enumerate(rows):
                for col_idx, cell_value in enumerate(row):
                    cell = f"{get_column_letter(start_col + col_idx)}{start_row + row_idx + 2}"
                    cell_style = data_style.copy() if data_style else None
                    
                    if str(cell_value).startswith("="):
                        data = self._update_cell_in_data(data, sheet_index, cell, 
                                                          formula=cell_value, style=cell_style)
                    else:
                        data = self._update_cell_in_data(data, sheet_index, cell, 
                                                          value=str(cell_value), style=cell_style)
            
            if include_totals:
                totals_row = start_row + len(rows) + 2
                for col_idx in range(len(headers)):
                    if col_idx == 0:
                        cell = f"{get_column_letter(start_col)}{totals_row}"
                        data = self._update_cell_in_data(data, sheet_index, cell, 
                                                          value="Total", style={"fontWeight": "bold"})
                    else:
                        col_letter = get_column_letter(start_col + col_idx)
                        start_data_row = start_row + 2
                        end_data_row = start_row + len(rows) + 1
                        formula = f"=SUM({col_letter}{start_data_row}:{col_letter}{end_data_row})"
                        cell = f"{col_letter}{totals_row}"
                        data = self._update_cell_in_data(data, sheet_index, cell, 
                                                          formula=formula, style={"fontWeight": "bold"})
            
            await self._save_spreadsheet(data, file_path)
            
            await self._stream_file_update(tool_call_id, file_path, "complete", {
                "rows": len(rows) + 1 + (1 if include_totals else 0),
                "cols": len(headers)
            })
            
            await stream_tool_output(
                tool_call_id=tool_call_id,
                output_chunk="",
                is_final=True,
                tool_name="spreadsheet"
            )
            
            return self.success_response({
                "message": f"Successfully populated spreadsheet with {len(rows)} rows",
                "file_path": file_path,
                "rows_count": len(rows),
                "columns_count": len(headers),
                "sheet_index": sheet_index
            })
            
        except Exception as e:
            logger.error(f"Failed to populate spreadsheet: {e}")
            return self.fail_response(f"Failed to populate data: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "spreadsheet_update_cells",
            "description": "Update specific cells in the spreadsheet file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "operations": {
                        "type": "array",
                        "description": "Array of cell operations",
                        "items": {
                            "type": "object",
                            "properties": {
                                "cell": {"type": "string", "description": "Cell address (e.g., 'A1')"},
                                "value": {"type": "string", "description": "Cell value"},
                                "formula": {"type": "string", "description": "Excel formula"},
                                "style": {"type": "object", "description": "Cell style"}
                            },
                            "required": ["cell"]
                        }
                    },
                    "file_path": {
                        "type": "string",
                        "description": "Path to the spreadsheet JSON file"
                    },
                    "sheet_index": {
                        "type": "integer",
                        "description": "Sheet index. Default: 0"
                    }
                },
                "required": ["operations"]
            }
        }
    })
    async def spreadsheet_update_cells(
        self,
        operations: List[Dict[str, Any]],
        file_path: str = DEFAULT_SPREADSHEET_FILE,
        sheet_index: int = 0
    ) -> ToolResult:
        try:
            tool_call_id = get_current_tool_call_id() or f"ss_{str(uuid4())[:8]}"
            
            data = await self._load_spreadsheet(file_path)
            
            await self._stream_file_update(tool_call_id, file_path, "start", {
                "total_operations": len(operations)
            })
            
            updated_cells = []
            for idx, op in enumerate(operations):
                cell = op.get("cell")
                value = op.get("value")
                formula = op.get("formula")
                style = op.get("style")
                
                data = self._update_cell_in_data(data, sheet_index, cell, value, formula, style)
                updated_cells.append(cell)
            
            await self._save_spreadsheet(data, file_path)
            await self._stream_file_update(tool_call_id, file_path, "complete", {
                "cells_updated": len(updated_cells)
            })
            
            await stream_tool_output(
                tool_call_id=tool_call_id,
                output_chunk="",
                is_final=True,
                tool_name="spreadsheet"
            )
            
            return self.success_response({
                "message": f"Successfully updated {len(updated_cells)} cells",
                "file_path": file_path,
                "cells_updated": updated_cells,
                "sheet_index": sheet_index
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to update cells: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "spreadsheet_format_range",
            "description": "Apply formatting to a range of cells.",
            "parameters": {
                "type": "object",
                "properties": {
                    "start_cell": {"type": "string", "description": "Start cell (e.g., 'A1')"},
                    "end_cell": {"type": "string", "description": "End cell (e.g., 'F10')"},
                    "style": {
                        "type": "object",
                        "description": "Style to apply: fontWeight, fontSize, color, backgroundColor, textAlign, etc."
                    },
                    "file_path": {"type": "string", "description": "Path to spreadsheet file"},
                    "sheet_index": {"type": "integer", "description": "Sheet index. Default: 0"}
                },
                "required": ["start_cell", "end_cell", "style"]
            }
        }
    })
    async def spreadsheet_format_range(
        self,
        start_cell: str,
        end_cell: str,
        style: Dict[str, Any],
        file_path: str = DEFAULT_SPREADSHEET_FILE,
        sheet_index: int = 0
    ) -> ToolResult:
        try:
            tool_call_id = get_current_tool_call_id() or f"ss_{str(uuid4())[:8]}"
            
            data = await self._load_spreadsheet(file_path)
            
            start_row, start_col = parse_cell_address(start_cell)
            end_row, end_col = parse_cell_address(end_cell)
            
            cells_formatted = 0
            for row in range(start_row, end_row + 1):
                for col in range(start_col, end_col + 1):
                    cell = f"{get_column_letter(col)}{row + 1}"
                    data = self._update_cell_in_data(data, sheet_index, cell, style=style)
                    cells_formatted += 1
            
            await self._save_spreadsheet(data, file_path)
            await self._stream_file_update(tool_call_id, file_path, "complete", {
                "cells_formatted": cells_formatted
            })
            
            await stream_tool_output(
                tool_call_id=tool_call_id,
                output_chunk="",
                is_final=True,
                tool_name="spreadsheet"
            )
            
            return self.success_response({
                "message": f"Formatted range {start_cell}:{end_cell}",
                "file_path": file_path,
                "cells_formatted": cells_formatted
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to format range: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "spreadsheet_clear_range",
            "description": "Clear values from a range of cells.",
            "parameters": {
                "type": "object",
                "properties": {
                    "start_cell": {"type": "string", "description": "Start cell"},
                    "end_cell": {"type": "string", "description": "End cell"},
                    "file_path": {"type": "string", "description": "Path to spreadsheet file"},
                    "sheet_index": {"type": "integer", "description": "Sheet index. Default: 0"}
                },
                "required": ["start_cell", "end_cell"]
            }
        }
    })
    async def spreadsheet_clear_range(
        self,
        start_cell: str,
        end_cell: str,
        file_path: str = DEFAULT_SPREADSHEET_FILE,
        sheet_index: int = 0
    ) -> ToolResult:
        try:
            tool_call_id = get_current_tool_call_id() or f"ss_{str(uuid4())[:8]}"
            
            data = await self._load_spreadsheet(file_path)
            
            start_row, start_col = parse_cell_address(start_cell)
            end_row, end_col = parse_cell_address(end_cell)
            
            sheet = data["sheets"][sheet_index]
            cells_cleared = 0
            
            for row in range(start_row, end_row + 1):
                for col in range(start_col, end_col + 1):
                    cell = f"{get_column_letter(col)}{row + 1}"
                    if cell in sheet.get("cells", {}):
                        del sheet["cells"][cell]
                        cells_cleared += 1
            
            await self._save_spreadsheet(data, file_path)
            await self._stream_file_update(tool_call_id, file_path, "complete", {
                "cells_cleared": cells_cleared
            })
            
            await stream_tool_output(
                tool_call_id=tool_call_id,
                output_chunk="",
                is_final=True,
                tool_name="spreadsheet"
            )
            
            return self.success_response({
                "message": f"Cleared range {start_cell}:{end_cell}",
                "file_path": file_path,
                "cells_cleared": cells_cleared
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to clear range: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "spreadsheet_get_data",
            "description": "Read the current spreadsheet data from the JSON file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Path to spreadsheet file"}
                }
            }
        }
    })
    async def spreadsheet_get_data(
        self,
        file_path: str = DEFAULT_SPREADSHEET_FILE
    ) -> ToolResult:
        try:
            data = await self._load_spreadsheet(file_path)
            
            return self.success_response({
                "file_path": file_path,
                "data": data
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to read spreadsheet: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "spreadsheet_create_sheet",
            "description": "Create a new worksheet tab in the spreadsheet.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Name for the new sheet"},
                    "file_path": {"type": "string", "description": "Path to spreadsheet file"}
                },
                "required": ["name"]
            }
        }
    })
    async def spreadsheet_create_sheet(
        self,
        name: str,
        file_path: str = DEFAULT_SPREADSHEET_FILE
    ) -> ToolResult:
        try:
            tool_call_id = get_current_tool_call_id() or f"ss_{str(uuid4())[:8]}"
            
            data = await self._load_spreadsheet(file_path)
            
            new_sheet = {
                "name": name,
                "cells": {},
                "columns": {str(i): {"width": 120} for i in range(26)},
                "rowCount": 100,
                "colCount": 26
            }
            data["sheets"].append(new_sheet)
            
            await self._save_spreadsheet(data, file_path)
            await self._stream_file_update(tool_call_id, file_path, "complete", {
                "sheet_created": name,
                "sheet_index": len(data["sheets"]) - 1
            })
            
            await stream_tool_output(
                tool_call_id=tool_call_id,
                output_chunk="",
                is_final=True,
                tool_name="spreadsheet"
            )
            
            return self.success_response({
                "message": f"Created new sheet '{name}'",
                "file_path": file_path,
                "sheet_name": name,
                "sheet_index": len(data["sheets"]) - 1
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to create sheet: {str(e)}")
