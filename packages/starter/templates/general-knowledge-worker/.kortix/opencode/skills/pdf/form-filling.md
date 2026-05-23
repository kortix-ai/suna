# PDF Form Filling

**Complete these steps in order. Do not skip ahead to writing code.**

First, check whether the PDF has native fillable fields:
`python skills/GENERAL-KNOWLEDGE-WORKER/pdf/formfill.py detect <file.pdf>`

Based on the result, follow the **Fillable Fields** or **Non-Fillable Fields** path below.

## Multiple Forms

**Use subagents when filling more than one PDF form** (e.g. a tax return with 10+ schedules):

1. Do shared prep in the main context: download forms, compile data into files
2. Spawn one subagent per form — each follows this workflow independently
3. Each subagent reads data from files and fills its assigned form end-to-end

If you need to fill multiple forms, delegate to subagents immediately. Do NOT attempt to fill them all sequentially — it is slow and error-prone.

---

## Fillable Fields

When the PDF has native form fields:

### 1. Extract field metadata

```
python skills/GENERAL-KNOWLEDGE-WORKER/pdf/formfill.py extract <input.pdf> <fields.json>
```

Output is a JSON array. All coordinates use **top-origin** (y=0 at top of page, y increases downward) — the same convention as pdfplumber, HTML, and image coordinates:

```json
[
  {
    "name": "last_name",
    "page": 1,
    "rect": [100, 92, 300, 112],
    "kind": "text"
  },
  {
    "name": "is_citizen",
    "page": 1,
    "kind": "checkbox",
    "on_value": "/Yes",
    "off_value": "/Off"
  },
  {
    "name": "filing_status",
    "page": 1,
    "kind": "radio_group",
    "options": [
      {"value": "/Single", "rect": [100, 600, 112, 612]},
      {"value": "/Married", "rect": [100, 580, 112, 592]}
    ]
  },
  {
    "name": "state",
    "page": 1,
    "kind": "choice",
    "choices": [
      {"value": "CA", "text": "California"},
      {"value": "NY", "text": "New York"}
    ]
  }
]
```

### 2. Render pages for visual analysis

```
python skills/GENERAL-KNOWLEDGE-WORKER/pdf/render.py <file.pdf> <output_dir/>
```

Examine the images to understand the purpose of each field. Map bounding box PDF coordinates to image coordinates as needed.

### 3. Create values file

Create `values.json` with the data to fill:

```json
[
  {
    "name": "last_name",
    "description": "Taxpayer last name",
    "page": 1,
    "value": "Chen"
  },
  {
    "name": "is_citizen",
    "description": "US citizen checkbox",
    "page": 1,
    "value": "/Yes"
  }
]
```

- `name` must match the field name from the extract step
- For checkboxes, use `on_value` to check, `off_value` to uncheck
- For radio groups, use one of the `value` entries from `options`

### 4. Fill the form

```
python skills/GENERAL-KNOWLEDGE-WORKER/pdf/formfill.py fill <input.pdf> <values.json> <output.pdf>
```

The script validates field names and values before writing. Fix any errors it reports and retry.

---

## Non-Fillable Fields

When the PDF has no native form fields, you place text as annotations. The process has three phases: **gather coordinates**, **build a fields file**, and **fill + verify**.

### Phase 1: Gather Coordinates

Start by extracting the page layout:

```
python skills/GENERAL-KNOWLEDGE-WORKER/pdf/layout.py extract <input.pdf> <layout.json>
```

This produces a **page-grouped** JSON array. Each page contains its own text elements, horizontal rules, tick boxes, and row ranges:

```json
[
  {
    "page_number": 1,
    "width": 612.0,
    "height": 792.0,
    "text_elements": [
      {"text": "Last", "x0": 43.0, "top": 63.0, "x1": 65.0, "bottom": 73.0},
      {"text": "Name", "x0": 67.0, "top": 63.0, "x1": 95.0, "bottom": 73.0}
    ],
    "h_rules": [
      {"y": 80.0, "x0": 36.0, "x1": 576.0}
    ],
    "tick_boxes": [
      {"x0": 285.0, "top": 197.0, "x1": 292.0, "bottom": 205.0, "mid_x": 288.5, "mid_y": 201.0}
    ],
    "row_ranges": [
      {"top": 60.0, "bottom": 80.0, "height": 20.0}
    ]
  }
]
```

- **text_elements**: every word with coordinates (PDF points, y=0 at top of page, y increases downward)
- **h_rules**: horizontal lines spanning >50% of page width (useful as row separators)
- **tick_boxes**: small square rectangles detected as checkboxes
- **row_ranges**: vertical bands computed from consecutive horizontal rules

Also render the pages for visual reference:

```
python skills/GENERAL-KNOWLEDGE-WORKER/pdf/render.py <input.pdf> <images_dir/>
```

Now use whichever source gives better coordinates for each field:

**From the layout data** (preferred when text elements are present):
1. Group adjacent text elements into labels (e.g. "Last" + "Name")
2. Elements with similar `top` values share a row
3. Entry areas start after the label: `content_area x0 = label x1 + gap`
4. Tick boxes — use their coordinates directly

**From the page images** (for scanned PDFs or fields missing from layout data):
1. Estimate approximate pixel coordinates from the page image
2. Crop around each estimate with ImageMagick to refine:
   ```bash
   magick <page_image> -crop <width>x<height>+<x>+<y> +repage <crop.png>
   ```
   (If `magick` is unavailable, try `convert` with the same arguments.)
3. Examine the crop to find exact boundaries, then convert back: `full_x = crop_x + offset_x`, `full_y = crop_y + offset_y`

You can mix both sources freely. If some fields come from layout data and others from image estimation, convert image coordinates to PDF coordinates before combining:
- `pdf_x = image_x * (pdf_width / image_width)`
- `pdf_y = image_y * (pdf_height / image_height)`

Coordinate system: PDF points, y=0 at top of page, y increases downward.

### Phase 2: Build fields.json

Combine all field coordinates into a single file. Use `coord_system: "pdf"` if all coordinates are in PDF points, or `"image"` if all are in pixel coordinates from the rendered images.

```json
{
  "coord_system": "pdf",
  "pages": [
    {"page_number": 1, "width": 612, "height": 792}
  ],
  "form_fields": [
    {
      "page_number": 1,
      "description": "Last name field",
      "label_box": [43, 63, 87, 73],
      "content_area": [92, 63, 260, 79],
      "content": {"text": "Smith", "font_size": 10}
    },
    {
      "page_number": 1,
      "description": "US Citizen checkbox",
      "label_box": [260, 200, 280, 210],
      "content_area": [285, 197, 292, 205],
      "content": {"text": "X"}
    }
  ]
}
```

### Phase 3: Fill and Verify

The fill command validates layout and places annotations in one step. It checks for overlapping boxes and font-vs-box sizing before writing:

```
python skills/GENERAL-KNOWLEDGE-WORKER/pdf/layout.py fill <input.pdf> <fields.json> <output.pdf>
```

If validation errors are found, they're printed and no output is written. Fix the errors in `fields.json` and retry.

Render the filled PDF and check text placement:

```
python skills/GENERAL-KNOWLEDGE-WORKER/pdf/render.py <output.pdf> <verify_images/>
```

If text is mispositioned, check that coordinates and `coord_system` are consistent.

### Debug Visualization

Overlay bounding boxes on a page image to visually inspect field placement:

```
python skills/GENERAL-KNOWLEDGE-WORKER/pdf/layout.py preview <page_number> <fields.json> <page_image> <output_image>
```
