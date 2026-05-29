---
name: xlsx
description: "Use for spreadsheet creation, analysis, financial models, and polished workbook outputs."
---

# Requirements for Outputs

**Design guidance:** For styled spreadsheets (dashboard reports, branded workbooks), see `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` for the default accent color and chart colors. Reserve color for emphasis — most cells should use default black text on white. Use the accent color sparingly (header rows, key totals). Financial model color conventions below are industry-standard overrides and take priority.

## User-Facing Delivery

When reporting back to the user:

- describe what the spreadsheet does, not which library created it
- mention the structure, formulas, sheets, charts, and outputs in plain language
- say that calculations update automatically when inputs change when that is true
- do not narrate internal implementation details unless the user explicitly asks

## All Excel files

### Professional Font
- Use a consistent, professional font (e.g., Calibri, Arial) for all deliverables unless otherwise instructed by the user

### Zero Formula Errors
- Every Excel model MUST be delivered with ZERO formula errors (#REF!, #DIV/0!, #VALUE!, #N/A, #NAME?)

### Preserve Existing Templates (when updating templates)
- Study and EXACTLY match existing format, style, and conventions when modifying files
- Never impose standardized formatting on files with established patterns
- Existing template conventions ALWAYS override these guidelines

### Formulas Over Hardcoded Values

Every derived value must be an Excel formula, not a Python-computed constant. The spreadsheet must recalculate when inputs change.

```python
# WRONG — value dies when inputs change
margin = (revenue - cogs) / revenue
ws["D5"] = margin

# RIGHT — formula stays live
ws["D5"] = "=(B5-C5)/B5"
ws["D5"].number_format = "0.0%"
```

```python
# WRONG — snapshot of a sum
ws["F20"] = df["Amount"].sum()

# RIGHT — Excel does the aggregation
ws["F20"] = "=SUM(F2:F19)"
ws["F20"].number_format = "#,##0"
```

This applies to totals, ratios, growth rates, averages, ranks — anything Excel can compute. Hardcoded numbers are acceptable only for raw input data and sourced assumptions.

## Financial models

### Color Coding Standards
Unless otherwise stated by the user or existing template

#### Industry-Standard Color Conventions
- **Blue text (RGB: 0,0,255)**: Hardcoded inputs, and numbers users will change for scenarios
- **Black text (RGB: 0,0,0)**: ALL formulas and calculations
- **Green text (RGB: 0,128,0)**: Links pulling from other worksheets within same workbook
- **Red text (RGB: 255,0,0)**: External links to other files
- **Yellow background (RGB: 255,255,0)**: Key assumptions needing attention or cells that need to be updated

### Number Formatting Standards

#### Required Format Rules
- **Years**: Format as text strings (e.g., "2024" not "2,024")
- **Currency**: Use $#,##0 format; ALWAYS specify units in headers ("Revenue ($mm)")
- **Zeros**: Use number formatting to make all zeros "-", including percentages (e.g., "$#,##0;($#,##0);-")
- **Percentages**: Default to 0.0% format (one decimal)
- **Multiples**: Format as 0.0x for valuation multiples (EV/EBITDA, P/E)
- **Negative numbers**: Use parentheses (123) not minus -123

### Formula Construction Rules

#### Assumptions Placement
- Place ALL assumptions (growth rates, margins, multiples, etc.) in separate assumption cells
- Use cell references instead of hardcoded values in formulas
- Example: Use =B5*(1+$B$6) instead of =B5*1.05

#### Formula Error Prevention
- Verify all cell references are correct
- Check for off-by-one errors in ranges
- Ensure consistent formulas across all projection periods
- Test with edge cases (zero values, negative numbers)
- Verify no unintended circular references

#### Documentation Requirements for Hardcodes
- Comment or in cells beside (if end of table). Format: "Source: [System/Document], [Date], [Specific Reference], [URL if applicable]"
- Examples:
  - "Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]"
  - "Source: Company 10-Q, Q2 2025, Exhibit 99.1, [SEC EDGAR URL]"
  - "Source: Bloomberg Terminal, 8/15/2025, AAPL US Equity"
  - "Source: FactSet, 8/20/2025, Consensus Estimates Screen"

## Structure & Usability

### Sheet Organization

| Guideline | Recommendation |
|-----------|----------------|
| Sheet order | Summary/Overview first, then supporting detail (General → Specific) |
| Sheet count | 3-5 ideal, max 7 |
| Naming | Descriptive names (e.g., "Revenue Data", not "Sheet1") |

**Information architecture**:
- Overview sheet should stand alone — user understands the main message without opening other sheets
- Progressive disclosure: summary first, details available for those who want to dig deeper
- Consistent structure across sheets: same layout patterns, same starting positions

### Layout Rules

| Element | Position |
|---------|----------|
| Left margin | Column A empty (width 3) |
| Top margin | Row 1 empty |
| Content start | Cell B2 |
| Section spacing | 1 empty row between sections |
| Table spacing | 2 empty rows between tables |
| Charts | Below tables (2 rows gap), or right of related table |

Charts must never overlap each other or tables.

```python
ws.column_dimensions['A'].width = 3
```

### Standalone Text Rows

For rows with a single text cell (titles, descriptions, notes), text naturally extends into empty cells to the right. However, text is **clipped** if right cells contain any content (including spaces).

| Condition | Action |
|-----------|--------|
| Right cells guaranteed empty | No action needed—text extends naturally |
| Right cells may have content | Merge cells to content width, or wrap text |
| Text exceeds content area width | Wrap text + set row height manually |

Common cases requiring merge:
- Titles and subtitles (usually span full content width)
- Section headers (span width of related table)
- Long bullet points or insight text
- Notes and disclaimers

```python
from openpyxl.utils import get_column_letter

# Merge title across content width
last_col = 8  # Match table width
ws.merge_cells(f'B2:{get_column_letter(last_col)}2')
ws['B2'] = "Report Title"

# Wrapped text with manual row height
ws['B20'].alignment = Alignment(wrap_text=True)
ws.row_dimensions[20].height = 30  # Adjust based on content
```

### Navigation

For workbooks with 3+ sheets, add a sheet index with hyperlinks on the Overview.

**Internal links** (cross-sheet references) — use `Hyperlink` class for reliability:
```python
from openpyxl.worksheet.hyperlink import Hyperlink

cell = ws.cell(row=6, column=2, value="Revenue Data")
cell.hyperlink = Hyperlink(ref=cell.coordinate, location="'Revenue Data'!A1")
cell.font = Font(color='0000FF', underline='single')
```

**External links** (source documents):
```python
cell.hyperlink = "https://example.com/source"
cell.font = Font(color='0000FF', underline='single')
```

### Freeze Panes

For tables with >10 rows, freeze below the header row:

```python
ws.freeze_panes = f'A{header_row + 1}'
```

### Filters

For tables with >20 rows, enable auto-filter to allow users to explore data:

```python
from openpyxl.utils import get_column_letter

# Apply filter to entire data range
ws.auto_filter.ref = f"A{header_row}:{get_column_letter(last_col)}{last_row}"
```

### Excel Tables

For any contiguous data range with one header row + data rows, always create a formal Excel Table object instead of manual formatting. Tables provide automatic row banding, filters, structured references (e.g., `=SUM(Table1[Revenue])`), and auto-updating styles when rows are added or deleted. This makes manual alternating-row fills, manual auto-filter setup, and manual header styling unnecessary. Each sheet can have its own Table (use unique `displayName` values).

When the sheet is purely a data table, data should start at A1 — the B2 layout rule applies to dashboards/reports with titles, not raw data tables. Use `openpyxl.worksheet.table.Table` with `TableStyleInfo` to create the table.

When editing an existing file, **check for Table objects** (`ws.tables`) before writing formulas. If tables exist, **use structured table references in all formulas** instead of raw cell ranges. For example, use `=AVERAGE(PeopleData[Salary])` instead of `=AVERAGE('Sheet1'!N2:N500)`. For VLOOKUP, use `TableName[#All]` as the lookup array: `=VLOOKUP(A2,PeopleData[#All],3,FALSE)`. Structured references auto-adjust when rows are added or removed.

### Pre-sorting

Pre-sort by most meaningful dimension:
- Rankings → by value descending
- Time series → by date ascending
- Alphabetical → when no clear priority

```python
df = df.sort_values('revenue', ascending=False)
```

### Data Context

Every dataset needs context for the user to trust and understand it:

| Element | Location | Example |
|---------|----------|---------|
| Data source | Footer or notes | "Source: Company 10-K, FY2024" |
| Time range | Near title or subtitle | "Data from Jan 2022 - Dec 2024" |
| Generation date | Footer | "Generated: 2024-01-15" |
| Definitions | Notes section | "Revenue = Net sales excluding returns" |

```python
# Add data context in footer area
ws.cell(row=last_row + 3, column=1, value="Source: Company Annual Report 2024")
ws.cell(row=last_row + 4, column=1, value=f"Generated: {datetime.now().strftime('%Y-%m-%d')}")
```

### Content Completeness

| Check | Action |
|-------|--------|
| Missing values | Show as blank or "N/A", never 0 unless actually zero |
| Units | Include in header (e.g., "Revenue ($M)", "Growth (%)") |
| Abbreviations | Define on first use or in notes section |
| Calculated fields | Use formulas so users can audit; add note if formula is complex |

### Number Formatting

**Critical**: Formula cells need `number_format` too — they display raw precision unless explicitly formatted.

```python
# WRONG: Formula cell without number_format
ws['C10'] = '=C7-C9'  # Displays 14.123456789

# CORRECT: Always set number_format for formula cells
ws['C10'] = '=C7-C9'
ws['C10'].number_format = '#,##0.0'  # Displays 14.1
```

Apply consistent formatting to entire columns (both values and formulas):

| Data Type | Format Code | Example |
|-----------|-------------|---------|
| Integer | `#,##0` | 1,234,567 |
| Decimal (1) | `#,##0.0` | 1,234.6 |
| Percentage | `0.0%` | 12.3% |
| Currency | `$#,##0.00` | $1,234.56 |

### Alignment

| Content | Horizontal | Notes |
|---------|------------|-------|
| Headers | Center | |
| Numbers | Right | |
| Short text | Center | Single words, status values |
| Long text | Left | Sentences, descriptions; use `indent=1` for padding |
| Dates | Center | |

```python
# Numbers right-aligned
cell.alignment = Alignment(horizontal='right', vertical='center')

# Text with padding
cell.alignment = Alignment(horizontal='left', vertical='center', indent=1)
```

### Column Width

Calculate width based on content. Only consider data cells, not titles or notes:

```python
def set_column_width(ws, col, min_width=12, max_width=50, padding=2):
    max_len = 0
    for row in ws.iter_rows(min_col=col, max_col=col):
        for cell in row:
            if cell.value:
                max_len = max(max_len, len(str(cell.value)))

    width = min(max(max_len + padding, min_width), max_width)
    ws.column_dimensions[get_column_letter(col)].width = width
```

**Guidelines**:
| Column Type | Min Width | Notes |
|-------------|-----------|-------|
| Labels/Text | 15 | First column usually |
| Numbers | 12 | Allow room for formatting (commas, negatives) |
| Dates | 12 | Standard date format |
| Long text | 20-40 | Consider wrapping if exceeds 40 |

### Row Height

Set row heights explicitly for consistency (openpyxl doesn't auto-adjust):

```python
ws.row_dimensions[1].height = 30   # Title row
ws.row_dimensions[2].height = 20   # Subtitle row
ws.row_dimensions[3].height = 25   # Header row
# Data rows: default 15-18 is usually fine
```

### Data Visualization

**Data Bars** — compare magnitude within a column without leaving the cell:

```python
from openpyxl.formatting.rule import DataBarRule

# Blue data bars (default Excel blue)
rule = DataBarRule(
    start_type='min',
    end_type='max',
    color='4472C4'  # Excel default blue
)
ws.conditional_formatting.add('C5:C50', rule)
```

**Color Scale** — heatmap effect for matrices and ranges:

```python
from openpyxl.formatting.rule import ColorScaleRule

# White to blue gradient
rule = ColorScaleRule(
    start_type='min', start_color='FFFFFF',
    end_type='max', end_color='4472C4'
)
ws.conditional_formatting.add('D5:H20', rule)

# Three-color scale (low-mid-high)
rule = ColorScaleRule(
    start_type='min', start_color='F8696B',     # Red
    mid_type='percentile', mid_value=50, mid_color='FFEB84',  # Yellow
    end_type='max', end_color='63BE7B'          # Green
)
```

**When to use**:
| Feature | Use Case |
|---------|----------|
| Data Bars | Numeric columns needing quick magnitude comparison |
| Color Scale (2-color) | Single metric ranges, distributions |
| Color Scale (3-color) | Performance data with good/neutral/bad interpretation |

### Conditional Formatting Rules

When a user asks to "highlight", "color", or "conditionally format" cells based on value thresholds, **always use Excel conditional formatting rules** (`CellIsRule`, `FormulaRule` from `openpyxl.formatting.rule`) instead of looping through cells and setting `PatternFill` directly. Static fills look the same visually but are not real conditional formatting — they don't update when values change, don't appear in Excel's conditional formatting manager, and can't be edited by the user.

### Charts

Place charts below tables with a 2-row gap, left-aligned with content:

```python
from openpyxl.chart import BarChart, LineChart, Reference

# Create chart
chart = BarChart()
chart.title = "Revenue by Region"
chart.style = 10  # Built-in style

# Set data and categories
data = Reference(ws, min_col=2, min_row=header_row, max_row=last_row)
cats = Reference(ws, min_col=1, min_row=header_row + 1, max_row=last_row)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)

# Size and position
chart.width = 15  # inches
chart.height = 7.5
ws.add_chart(chart, f"A{last_row + 3}")  # 2 rows below data
```

**Chart type selection**:
| Chart Type | Use When |
|------------|----------|
| Bar/Column | Comparing values across categories |
| Line | Time series, trends over time |
| Pie | Part-to-whole (≤6 categories only) |

**Preventing overlap**: Chart `width` and `height` are in centimeters, not rows. To place content after a chart without overlap:

```python
from math import ceil

# ~2 rows per cm of chart height (at default ~15pt row height)
rows_for_chart = ceil(chart.height * 2)
next_content_row = chart_row + rows_for_chart + 2  # 2-row gap
```

### Comparison Columns

For analytical reports, add calculated columns that surface insights:

| Column Type | Formula Pattern | Use Case |
|-------------|-----------------|----------|
| Change (Δ) | `=B2-A2` | Absolute difference |
| % Change | `=(B2-A2)/A2` | Relative growth |
| YoY Growth | `=(CurrentYear-PriorYear)/PriorYear` | Year-over-year |
| Rank | `=RANK(B2,$B$2:$B$100,0)` | Position in list |

```python
# Add YoY growth column
for row in range(data_start, data_end + 1):
    current = ws.cell(row=row, column=current_year_col).coordinate
    prior = ws.cell(row=row, column=prior_year_col).coordinate
    growth_cell = ws.cell(row=row, column=growth_col)
    growth_cell.value = f"=({current}-{prior})/{prior}"
    growth_cell.number_format = '0.0%'
```

# Scripts

LibreOffice is pre-installed. Both scripts configure it automatically on first run.

Use **pandas** for data analysis and bulk operations. Use **openpyxl** for formulas, formatting, and Excel-specific features. After saving, always recalculate:

## Recalculating Formulas

openpyxl writes formulas as strings but does not evaluate them. The `skills/GENERAL-KNOWLEDGE-WORKER/xlsx/scripts/recalc.py` script drives LibreOffice headless to recalculate all formulas and then scans every cell for Excel errors.

```bash
python skills/GENERAL-KNOWLEDGE-WORKER/xlsx/scripts/recalc.py <excel_file> [timeout_seconds]
```

On success:
```json
{"status": "success", "total_errors": 0, "total_formulas": 42, "error_summary": {}}
```

When errors remain:
```json
{
  "status": "errors_found",
  "total_errors": 2,
  "total_formulas": 42,
  "error_summary": {
    "#REF!": {"count": 2, "locations": ["Sheet1!B5", "Sheet1!C10"]}
  }
}
```

If `errors_found`, fix the referenced cells and re-run. Common errors: `#REF!` (bad cell reference), `#DIV/0!` (division by zero), `#VALUE!` (wrong type), `#NAME?` (unknown function).

## Pivot Tables

openpyxl cannot create pivot tables. Use `skills/GENERAL-KNOWLEDGE-WORKER/xlsx/scripts/pivot_table.py`, which creates real, interactive Excel pivot tables via LibreOffice's DataPilot engine.

```bash
# Create a pivot table
python skills/GENERAL-KNOWLEDGE-WORKER/xlsx/scripts/pivot_table.py create output.xlsx '{
    "source_sheet": "Data",
    "target_sheet": "Revenue Pivot",
    "pivot_name": "RevPivot",
    "row_fields": ["Region", "Product"],
    "column_fields": ["Quarter"],
    "data_fields": [{"name": "Revenue", "function": "SUM"}]
}'

# Delete a pivot table
python skills/GENERAL-KNOWLEDGE-WORKER/xlsx/scripts/pivot_table.py delete output.xlsx "Data" "RevPivot"
```

Config fields:
- `source_sheet`: Sheet containing the source data (must have headers in row 1)
- `target_sheet`: Sheet where the pivot table will be created (created automatically if it doesn't exist)
- `pivot_name`: Unique name for the pivot table
- `source_range`: Optional, e.g. `"A1:E100"`. Defaults to the full used area of the source sheet
- `row_fields`: Fields to use as row labels
- `column_fields`: Fields to use as column labels
- `data_fields`: Fields to aggregate, each with `name` and `function` (SUM, COUNT, AVERAGE, MAX, MIN, PRODUCT, STDEV, STDEVP, VAR, VARP). Each field name can only appear once — for multiple aggregations on the same column, create separate pivot tables
- `page_fields`: Optional filter fields

The resulting pivot tables are fully interactive in Excel — users can drag fields, filter, and refresh.

To edit a pivot table, recreate it with the new configuration using a new `pivot_name`.

Workflow with pivot tables:
1. Create/modify the spreadsheet with openpyxl (data, formulas, formatting)
2. Save the file
3. Run `pivot_table.py create` to add each pivot table
4. Continue modifying with openpyxl if needed — existing pivots are preserved
5. Run `recalc.py` to recalculate formulas

Multiple pivot tables can be added by running the script multiple times with different configs.

## Formula Verification Checklist

Quick checks to ensure formulas work correctly:

### Essential Verification
- [ ] **Test 2-3 sample references**: Verify they pull correct values before building full model
- [ ] **Column mapping**: Confirm Excel columns match (e.g., column 64 = BL, not BK)
- [ ] **Row offset**: Remember Excel rows are 1-indexed (DataFrame row 5 = Excel row 6)

### Common Pitfalls
- [ ] **NaN handling**: Check for null values with `pd.notna()`
- [ ] **Far-right columns**: FY data often in columns 50+
- [ ] **Multiple matches**: Search all occurrences, not just first
- [ ] **Division by zero**: Check denominators before using `/` in formulas (#DIV/0!)
- [ ] **Wrong references**: Verify all cell references point to intended cells (#REF!)
- [ ] **Cross-sheet references**: Use correct format (Sheet1!A1) for linking sheets

### Formula Testing Strategy
- [ ] **Start small**: Test formulas on 2-3 cells before applying broadly
- [ ] **Verify dependencies**: Check all cells referenced in formulas exist
- [ ] **Test edge cases**: Include zero, negative, and very large values

# Pitfalls

## openpyxl
- **`data_only=True` destroys formulas on save** — opening with `data_only=True` replaces formula strings with cached values. Never save a workbook opened this way; use it only for reading computed results.
- **Cell indices are 1-based** — `row=1, column=1` is cell A1. DataFrame row 5 = Excel row 6.
- **Formulas are stored as strings, not evaluated** — openpyxl does not compute formula results. Always run `recalc.py` after writing formulas.
- **Large files** — use `read_only=True` for reading or `write_only=True` for writing to avoid loading the entire file into memory.

## pandas
- **Type inference** — specify dtypes to avoid silent coercion: `pd.read_excel('file.xlsx', dtype={'id': str})`
- **Large files** — read only needed columns: `pd.read_excel('file.xlsx', usecols=['A', 'C', 'E'])`
- **Dates** — parse explicitly: `pd.read_excel('file.xlsx', parse_dates=['date_column'])`
