from typing import Dict, Any, List
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger

SPREADSHEET_DIR = "/workspace/spreadsheets"

@tool_metadata(
    display_name="Spreadsheet Tool",
    description="Create and edit Excel spreadsheets (.xlsx) with formulas and formatting",
    icon="Table",
    color="bg-green-100 dark:bg-green-800/50",
    weight=75,
    visible=True,
    usage_guide="""
### SPREADSHEET TOOL - Excel File Creation & Editing

**PURPOSE:**
Create interactive Excel (.xlsx) files that users can view, edit, and download. Uses native Excel format with full formula support, formatting, and multi-sheet capabilities.

**WHEN TO USE:**
- User asks to create/organize data in spreadsheet format
- Data needs calculations, formulas, or structured presentation
- User wants downloadable Excel files
- Data visualization with formatting and colors

**FUNCTIONS:**

1. **spreadsheet_create** - Create new Excel spreadsheet
   ```
   spreadsheet_create(
       file_path="sales_report.xlsx",
       sheet_name="Q1 Sales",
       headers=["Product", "Revenue", "Profit", "Margin %"],
       rows=[
           ["Product A", 50000, 15000, 30],
           ["Product B", 75000, 22500, 30],
           ["Total", "=SUM(B2:B3)", "=SUM(C2:C3)", "=C4/B4*100"]
       ]
   )
   ```

2. **spreadsheet_batch_update** - Update existing spreadsheet
   ```
   spreadsheet_batch_update(
       file_path="/workspace/spreadsheets/sales_report.xlsx",
       requests=[
           {
               "type": "update_cell",
               "cell": "A1",
               "value": "Product Name"
           },
           {
               "type": "format_cells",
               "range": "A1:D1",
               "style": {
                   "background_color": "#1F4E79",
                   "bold": true
               }
           },
           {
               "type": "add_rows",
               "rows": [["Product C", 60000, 18000, 30]]
           }
       ]
   )
   ```

**FEATURES:**
- ✅ Native Excel (.xlsx) format - fully compatible
- ✅ Formulas (=SUM, =AVERAGE, =IF, etc.)
- ✅ Cell formatting (colors, fonts, alignment)
- ✅ Auto-styled headers (dark blue with white text)
- ✅ Interactive viewing in chat interface
- ✅ Downloadable Excel files

**FORMATTING OPTIONS:**
- Colors: #4CAF50 (green), #F44336 (red), #2196F3 (blue), #FFC107 (yellow), #1F4E79 (dark blue)
- Styles: bold, italic, font_size, text_align
- Ranges: "A1:B5" or single cells "A1"

**FILE PATHS:**
- Creation: Just filename → Auto-saved to /workspace/spreadsheets/
- Updates: Use full path → /workspace/spreadsheets/filename.xlsx

**BEST PRACTICES:**
- Use formulas for calculations (=SUM(A1:A10), not hardcoded values)
- Format headers automatically (built-in dark blue styling)
- Keep data organized in rows/columns
- Use descriptive sheet names
- Add totals/summaries with formulas
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

    async def _execute_python_script(self, python_code: str) -> tuple[bool, str]:
        try:
            await self._ensure_sandbox()
            
            from daytona_sdk import SessionExecuteRequest
            from uuid import uuid4
            
            script_path = f"/tmp/spreadsheet_{str(uuid4())[:8]}.py"
            
            logger.info(f"Writing Python script to {script_path}")
            await self.sandbox.fs.upload_file(
                python_code.encode('utf-8'),
                script_path
            )
            
            session_id = f"spreadsheet_{str(uuid4())[:8]}"
            logger.info(f"Creating session {session_id}")
            await self.sandbox.process.create_session(session_id)
            
            command = f"python3 {script_path}"
            logger.info(f"Executing: {command}")
            
            req = SessionExecuteRequest(
                command=command,
                var_async=False,
                cwd="/workspace"
            )
            
            response = await self.sandbox.process.execute_session_command(
                session_id=session_id,
                req=req,
                timeout=60
            )
            
            logger.info(f"Command executed with exit_code: {response.exit_code}")
            
            logs = await self.sandbox.process.get_session_command_logs(
                session_id=session_id,
                command_id=response.cmd_id
            )
            
            await self.sandbox.process.delete_session(session_id)
            
            output = logs.output if logs and logs.output else ""
            logger.info(f"Python output: {output[:200]}")
            
            success = "SUCCESS" in output or response.exit_code == 0
            
            if not success:
                logger.error(f"Python execution failed. Exit code: {response.exit_code}, Output: {output}")
            
            return success, output
            
        except Exception as e:
            logger.error(f"Python execution exception: {e}")
            return False, str(e)

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
        await self._ensure_dir()
        
        base_name = file_path.split('/')[-1].replace('.xlsx', '').replace('.json', '')
        output_path = f"{SPREADSHEET_DIR}/{base_name}.xlsx"
        
        python_code = f"""import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

wb = openpyxl.Workbook()
ws = wb.active
ws.title = {repr(sheet_name)}

headers = {repr(headers)}
rows = {repr(rows)}

header_fill = PatternFill(start_color='1F4E79', end_color='1F4E79', fill_type='solid')
header_font = Font(bold=True, color='FFFFFF')

for col_idx, header in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col_idx, value=header)
    cell.fill = header_fill
    cell.font = header_font
    cell.alignment = Alignment(horizontal='left', vertical='center')

for row_idx, row_data in enumerate(rows, 2):
    for col_idx, value in enumerate(row_data, 1):
        ws.cell(row=row_idx, column=col_idx, value=value)

for col_idx in range(1, len(headers) + 1):
    ws.column_dimensions[get_column_letter(col_idx)].width = 15

wb.save({repr(output_path)})
print('SUCCESS')
"""
        
        success, output = await self._execute_python_script(python_code)
        
        if not success:
            return self.fail_response(f"Failed to create spreadsheet: {output}")
        
        try:
            file_info = await self.sandbox.fs.get_file_info(output_path)
            logger.info(f"✅ File created successfully: {output_path} (size: {file_info.size} bytes)")
        except Exception as e:
            logger.error(f"❌ File not found after creation: {output_path} - {e}")
            return self.fail_response(f"File was not created at {output_path}. Python output: {output}")
        
        return self.success_response({"file_path": output_path})

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
        
        python_code = f"""
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

file_path = {repr(file_path)}
requests = {repr(requests)}

try:
    wb = openpyxl.load_workbook(file_path)
    ws = wb.active
    
    for req in requests:
        req_type = req.get('type')
        
        if req_type == 'update_cell':
            cell = req.get('cell')
            value = req.get('value')
            if cell and value is not None:
                ws[cell] = value
        
        elif req_type == 'format_cells':
            cell_range = req.get('range') or req.get('cell_range')
            style = req.get('style', {{}})
            if cell_range:
                for row in ws[cell_range]:
                    for cell in row:
                        if style.get('bold'):
                            cell.font = Font(bold=True)
                        if style.get('background_color'):
                            bg = style['background_color'].lstrip('#')
                            cell.fill = PatternFill(start_color=bg, end_color=bg, fill_type='solid')
                        if style.get('text_color'):
                            fg = style['text_color'].lstrip('#')
                            cell.font = Font(color=fg)
        
        elif req_type == 'add_rows':
            rows = req.get('rows', [])
            for row_data in rows:
                ws.append(row_data)
    
    wb.save(file_path)
    print('SUCCESS')
except Exception as e:
    print(f'ERROR: {{e}}')
"""
        
        success, output = await self._execute_python_script(python_code)
        
        if not success:
            return self.fail_response(f"Batch update failed: {output}")
        
        return self.success_response({"file_path": file_path, "processed": len(requests)})
