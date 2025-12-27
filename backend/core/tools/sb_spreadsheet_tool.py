from typing import Dict, Any, List
import re
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger

SPREADSHEET_DIR = "/workspace/spreadsheets"

def validate_formula_references(rows: List[List[Any]], headers: List[str], start_row: int = 2) -> tuple[bool, str]:
    def cell_to_coords(cell_ref: str) -> tuple[int, int]:
        match = re.match(r'^([A-Z]+)(\d+)$', cell_ref.upper())
        if not match:
            return None, None
        col_str, row_str = match.groups()
        col = 0
        for char in col_str:
            col = col * 26 + (ord(char) - ord('A') + 1)
        return int(row_str), col
    
    def extract_cell_refs(formula: str) -> List[str]:
        pattern = r'[A-Z]+\d+'
        return re.findall(pattern, formula.upper())
    
    def expand_range(range_ref: str) -> List[str]:
        if ':' not in range_ref:
            return [range_ref]
        start, end = range_ref.split(':')
        start_row, start_col = cell_to_coords(start)
        end_row, end_col = cell_to_coords(end)
        if None in (start_row, start_col, end_row, end_col):
            return []
        cells = []
        for r in range(min(start_row, end_row), max(start_row, end_row) + 1):
            for c in range(min(start_col, end_col), max(start_col, end_col) + 1):
                col_letter = ''
                temp_c = c
                while temp_c > 0:
                    temp_c, remainder = divmod(temp_c - 1, 26)
                    col_letter = chr(65 + remainder) + col_letter
                cells.append(f"{col_letter}{r}")
        return cells
    
    for row_idx, row_data in enumerate(rows):
        actual_row = start_row + row_idx
        for col_idx, value in enumerate(row_data):
            if isinstance(value, str) and value.startswith('='):
                col_letter = ''
                temp_c = col_idx + 1
                while temp_c > 0:
                    temp_c, remainder = divmod(temp_c - 1, 26)
                    col_letter = chr(65 + remainder) + col_letter
                current_cell = f"{col_letter}{actual_row}"
                
                refs = extract_cell_refs(value)
                all_refs = []
                for ref in refs:
                    if ':' in value and ref in value:
                        range_match = re.search(rf'{ref}:[A-Z]+\d+', value.upper())
                        if range_match:
                            all_refs.extend(expand_range(range_match.group()))
                        else:
                            all_refs.append(ref)
                    else:
                        all_refs.append(ref)
                
                if current_cell in all_refs:
                    return False, f"Circular reference detected: Cell {current_cell} contains formula '{value}' that references itself"
    
    return True, ""

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

1. **spreadsheet_create** - Create NEW Excel spreadsheet (overwrites if exists)
   ```
   spreadsheet_create(
       file_path="sales_report.xlsx",
       sheet_name="Q1 Sales",
       headers=["Product", "Revenue", "Profit", "Margin %"],
       rows=[
           ["Product A", 50000, 15000, "=IFERROR(C2/B2*100,0)"],
           ["Product B", 75000, 22500, "=IFERROR(C3/B3*100,0)"],
           ["Total", "=SUM(B2:B3)", "=SUM(C2:C3)", "=IFERROR(C4/B4*100,0)"]
       ]
   )
   ```

2. **spreadsheet_add_sheet** - Add a NEW SHEET to EXISTING file (preserves other sheets)
   ```
   spreadsheet_add_sheet(
       file_path="/workspace/spreadsheets/sales_report.xlsx",
       sheet_name="Q2 Sales",
       headers=["Product", "Revenue", "Profit"],
       rows=[
           ["Product A", 60000, 18000],
           ["Product B", 80000, 24000]
       ]
   )
   ```

3. **spreadsheet_batch_update** - Update existing spreadsheet
   ```
   spreadsheet_batch_update(
       file_path="/workspace/spreadsheets/sales_report.xlsx",
       sheet_name="Q1 Sales",  # Optional: target specific sheet
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
           },
           {
               "type": "add_sheet",
               "sheet_name": "Summary",
               "headers": ["Metric", "Value"],
               "rows": [["Total Revenue", "=SUM('Q1 Sales'!B2:B10)"]]
           }
       ]
   )
   ```

**⚠️ IMPORTANT - ADDING SHEETS TO EXISTING FILES:**
- Use `spreadsheet_add_sheet` or `batch_update` with `type: "add_sheet"` 
- NEVER use `spreadsheet_create` on an existing file - it will OVERWRITE everything!
- `spreadsheet_add_sheet` preserves all existing sheets and data

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

**⚠️ CRITICAL - AVOIDING CIRCULAR REFERENCES:**
Headers are in ROW 1. Data rows start at ROW 2.
- Row 0 in your rows array = Excel Row 2
- Row 1 in your rows array = Excel Row 3
- etc.

**CORRECT Formula Examples (headers in row 1, data starts row 2):**
- If you have 5 data rows (rows 2-6), a SUM formula in row 7 should be: "=SUM(B2:B6)"
- NEVER reference the cell you're placing the formula in
- Total row formulas should reference ONLY the data rows ABOVE them

**Example with 3 products + 1 total row:**
```
headers=["Product", "Revenue", "Profit"],
rows=[
    ["Product A", 50000, 15000],      # Row 2
    ["Product B", 75000, 22500],      # Row 3  
    ["Product C", 60000, 18000],      # Row 4
    ["Total", "=SUM(B2:B4)", "=SUM(C2:C4)"]  # Row 5 - formulas sum rows 2-4
]
```

**WRONG (causes circular reference):**
```
rows=[
    ["Total", "=SUM(B2:B5)", ...]  # BAD: B5 is THIS cell!
]
```

**⚠️ CRITICAL - PREVENTING #DIV/0! ERRORS:**
- ALWAYS wrap division formulas with IFERROR to handle divide-by-zero
- Use: =IFERROR(A1/B1, 0) instead of =A1/B1
- For percentage: =IFERROR(C4/B4*100, 0) instead of =C4/B4*100

**Example with safe division:**
```
headers=["Product", "Revenue", "Cost", "Margin %"],
rows=[
    ["Product A", 50000, 35000, "=IFERROR(C2/B2*100,0)"],
    ["Product B", 75000, 45000, "=IFERROR(C3/B3*100,0)"],
    ["Total", "=SUM(B2:B3)", "=SUM(C2:C3)", "=IFERROR(C4/B4*100,0)"]
]
```

**BEST PRACTICES:**
- Count your data rows carefully before writing formulas
- Total/summary formulas should be in the LAST row
- Formula ranges should end at the row BEFORE the formula row
- Use explicit values instead of formulas when unsure
- Test mentally: "Does this formula reference its own cell?" → If yes, FIX IT
- ALWAYS use IFERROR() around any division to prevent #DIV/0! errors
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

    def _wrap_division_with_iferror(self, rows: List[List[Any]]) -> List[List[Any]]:
        fixed_rows = []
        for row_data in rows:
            fixed_row = []
            for value in row_data:
                if isinstance(value, str) and value.startswith('='):
                    formula = value
                    if '/' in formula and 'IFERROR' not in formula.upper():
                        inner = formula[1:]
                        formula = f'=IFERROR({inner},0)'
                        logger.info(f"Wrapped division formula with IFERROR: {value} -> {formula}")
                    fixed_row.append(formula)
                else:
                    fixed_row.append(value)
            fixed_rows.append(fixed_row)
        return fixed_rows

    def _fix_circular_references(self, rows: List[List[Any]], headers: List[str]) -> List[List[Any]]:
        fixed_rows = []
        num_data_rows = len(rows)
        
        for row_idx, row_data in enumerate(rows):
            actual_excel_row = row_idx + 2
            fixed_row = []
            
            for col_idx, value in enumerate(row_data):
                if isinstance(value, str) and value.startswith('='):
                    col_letter = ''
                    temp_c = col_idx + 1
                    while temp_c > 0:
                        temp_c, remainder = divmod(temp_c - 1, 26)
                        col_letter = chr(65 + remainder) + col_letter
                    current_cell = f"{col_letter}{actual_excel_row}"
                    
                    fixed_formula = value
                    range_pattern = r'([A-Z]+)(\d+):([A-Z]+)(\d+)'
                    matches = re.findall(range_pattern, value.upper())
                    
                    for match in matches:
                        start_col, start_row, end_col, end_row = match
                        start_row_num = int(start_row)
                        end_row_num = int(end_row)
                        
                        if end_row_num >= actual_excel_row:
                            new_end_row = actual_excel_row - 1
                            if new_end_row >= start_row_num:
                                old_range = f"{start_col}{start_row}:{end_col}{end_row}"
                                new_range = f"{start_col}{start_row}:{end_col}{new_end_row}"
                                fixed_formula = re.sub(
                                    re.escape(old_range), 
                                    new_range, 
                                    fixed_formula, 
                                    flags=re.IGNORECASE
                                )
                                logger.info(f"Fixed formula in {current_cell}: {value} -> {fixed_formula}")
                            else:
                                fixed_formula = "0"
                                logger.warning(f"Replaced invalid formula in {current_cell} with 0")
                    
                    single_ref_pattern = r'(?<![A-Z:])([A-Z]+)(\d+)(?![:\d])'
                    single_matches = re.findall(single_ref_pattern, fixed_formula.upper())
                    for match in single_matches:
                        ref_col, ref_row = match
                        ref_row_num = int(ref_row)
                        if f"{ref_col}{ref_row_num}" == current_cell:
                            fixed_formula = "0"
                            logger.warning(f"Replaced self-referencing formula in {current_cell} with 0")
                            break
                    
                    fixed_row.append(fixed_formula)
                else:
                    fixed_row.append(value)
            
            fixed_rows.append(fixed_row)
        
        return fixed_rows

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
            "description": "Create a new Excel spreadsheet file with headers and rows. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `file_path` (REQUIRED), `headers` (REQUIRED), `rows` (REQUIRED), `sheet_name` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "**REQUIRED** - Path to the Excel file to create, relative to /workspace. Example: 'data/report.xlsx'"},
                    "sheet_name": {"type": "string", "description": "**OPTIONAL** - Name for the sheet. Default: 'Sheet1'."},
                    "headers": {"type": "array", "items": {"type": "string"}, "description": "**REQUIRED** - Array of header strings for the first row. Example: ['Name', 'Age', 'City']"},
                    "rows": {"type": "array", "items": {"type": "array"}, "description": "**REQUIRED** - Array of rows, where each row is an array of cell values. Example: [['John', 25, 'NYC'], ['Jane', 30, 'LA']]"}
                },
                "required": ["file_path", "headers", "rows"],
                "additionalProperties": False
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
        
        rows = self._wrap_division_with_iferror(rows)
        
        is_valid, error_msg = validate_formula_references(rows, headers, start_row=2)
        if not is_valid:
            logger.error(f"Formula validation failed: {error_msg}")
            corrected_rows = self._fix_circular_references(rows, headers)
            if corrected_rows != rows:
                logger.info("Auto-corrected circular references in formulas")
                rows = corrected_rows
        
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
            "name": "spreadsheet_add_sheet",
            "description": "Add a new sheet to an existing Excel file. Use this instead of spreadsheet_create when adding sheets to existing files. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `file_path` (REQUIRED), `sheet_name` (REQUIRED), `headers` (REQUIRED), `rows` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "**REQUIRED** - Full path to existing Excel file. Example: 'data/report.xlsx'"},
                    "sheet_name": {"type": "string", "description": "**REQUIRED** - Name for the new sheet. Example: 'Q2 Data'"},
                    "headers": {"type": "array", "items": {"type": "string"}, "description": "**REQUIRED** - Array of header strings for the first row. Example: ['Product', 'Sales', 'Revenue']"},
                    "rows": {"type": "array", "items": {"type": "array"}, "description": "**REQUIRED** - Array of rows, where each row is an array of cell values. Example: [['Widget A', 100, 5000], ['Widget B', 200, 10000]]"}
                },
                "required": ["file_path", "sheet_name", "headers", "rows"],
                "additionalProperties": False
            }
        }
    })
    async def spreadsheet_add_sheet(
        self,
        file_path: str,
        sheet_name: str,
        headers: List[str],
        rows: List[List[Any]]
    ) -> ToolResult:
        rows = self._wrap_division_with_iferror(rows)
        
        is_valid, error_msg = validate_formula_references(rows, headers, start_row=2)
        if not is_valid:
            logger.error(f"Formula validation failed: {error_msg}")
            corrected_rows = self._fix_circular_references(rows, headers)
            if corrected_rows != rows:
                logger.info("Auto-corrected circular references in formulas")
                rows = corrected_rows
        
        python_code = f"""import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

file_path = {repr(file_path)}
sheet_name = {repr(sheet_name)}
headers = {repr(headers)}
rows = {repr(rows)}

try:
    wb = openpyxl.load_workbook(file_path)
    
    if sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        wb.remove(ws)
    
    ws = wb.create_sheet(title=sheet_name)
    
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
    
    wb.save(file_path)
    print('SUCCESS')
except Exception as e:
    print(f'ERROR: {{e}}')
"""
        
        success, output = await self._execute_python_script(python_code)
        
        if not success:
            return self.fail_response(f"Failed to add sheet: {output}")
        
        return self.success_response({"file_path": file_path, "sheet_name": sheet_name})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "spreadsheet_batch_update",
            "description": "Batch update multiple cells, formats, or add rows/sheets to an Excel file in a single operation. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `file_path` (REQUIRED), `requests` (REQUIRED), `sheet_name` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "**REQUIRED** - Path to the Excel file to update. Example: 'data/report.xlsx'"},
                    "sheet_name": {"type": "string", "description": "**OPTIONAL** - Specify which sheet to update. Defaults to active sheet."},
                    "requests": {
                        "type": "array",
                        "description": "**REQUIRED** - Array of update requests. Each request must have a 'type' field: 'update_cell', 'format_cells', 'add_rows', or 'add_sheet'.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {
                                    "type": "string",
                                    "enum": ["update_cell", "format_cells", "add_rows", "add_sheet"],
                                    "description": "Type of update operation."
                                },
                                "cell": {"type": "string", "description": "Cell reference (e.g., 'A1') for update_cell operations."},
                                "value": {"type": "string", "description": "Value to set in the cell."},
                                "range": {"type": "string", "description": "Cell range (e.g., 'A1:B10') for format_cells operations."},
                                "sheet_name": {"type": "string", "description": "Sheet name for add_sheet operations."},
                                "headers": {"type": "array", "items": {"type": "string"}, "description": "Headers array for add_rows or add_sheet operations."},
                                "style": {
                                    "type": "object",
                                    "description": "Style object for format_cells operations.",
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
                                    "items": {"type": "array"},
                                    "description": "Rows array for add_rows operations."
                                }
                            },
                            "required": ["type"]
                        }
                    }
                },
                "required": ["file_path", "requests"],
                "additionalProperties": False
            }
        }
    })
    async def spreadsheet_batch_update(
        self,
        file_path: str,
        requests: List[Dict[str, Any]],
        sheet_name: str = None
    ) -> ToolResult:
        for req in requests:
            if req.get('type') == 'add_rows' and 'rows' in req:
                req['rows'] = self._wrap_division_with_iferror(req['rows'])
            elif req.get('type') == 'add_sheet' and 'rows' in req:
                req['rows'] = self._wrap_division_with_iferror(req['rows'])
            elif req.get('type') == 'update_cell' and 'value' in req:
                value = req['value']
                if isinstance(value, str) and value.startswith('=') and '/' in value and 'IFERROR' not in value.upper():
                    inner = value[1:]
                    req['value'] = f'=IFERROR({inner},0)'
        
        python_code = f"""
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

file_path = {repr(file_path)}
requests = {repr(requests)}
target_sheet = {repr(sheet_name)}

try:
    wb = openpyxl.load_workbook(file_path)
    
    if target_sheet and target_sheet in wb.sheetnames:
        ws = wb[target_sheet]
    else:
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
        
        elif req_type == 'add_sheet':
            new_sheet_name = req.get('sheet_name', 'New Sheet')
            headers = req.get('headers', [])
            rows = req.get('rows', [])
            
            if new_sheet_name in wb.sheetnames:
                old_ws = wb[new_sheet_name]
                wb.remove(old_ws)
            
            new_ws = wb.create_sheet(title=new_sheet_name)
            
            header_fill = PatternFill(start_color='1F4E79', end_color='1F4E79', fill_type='solid')
            header_font = Font(bold=True, color='FFFFFF')
            
            for col_idx, header in enumerate(headers, 1):
                cell = new_ws.cell(row=1, column=col_idx, value=header)
                cell.fill = header_fill
                cell.font = header_font
                cell.alignment = Alignment(horizontal='left', vertical='center')
            
            for row_idx, row_data in enumerate(rows, 2):
                for col_idx, value in enumerate(row_data, 1):
                    new_ws.cell(row=row_idx, column=col_idx, value=value)
            
            for col_idx in range(1, max(len(headers), 1) + 1):
                new_ws.column_dimensions[get_column_letter(col_idx)].width = 15
    
    wb.save(file_path)
    print('SUCCESS')
except Exception as e:
    import traceback
    print(f'ERROR: {{e}}')
    traceback.print_exc()
"""
        
        success, output = await self._execute_python_script(python_code)
        
        if not success:
            return self.fail_response(f"Batch update failed: {output}")
        
        return self.success_response({"file_path": file_path, "processed": len(requests)})
