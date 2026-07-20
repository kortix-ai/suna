"""Native fillable PDF field operations.

Usage:
    python formfill.py detect <file.pdf>
    python formfill.py extract <input.pdf> <output.json>
    python formfill.py fill <input.pdf> <values.json> <output.pdf>
"""

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from pypdf import PdfReader, PdfWriter


@dataclass
class FormField:
    name: str
    kind: str
    page: int = 0
    rect: list[float] | None = None


@dataclass
class CheckboxField(FormField):
    on_value: str = ""
    off_value: str = "/Off"


@dataclass
class RadioGroup(FormField):
    options: list[dict[str, object]] = field(default_factory=list)


@dataclass
class ChoiceField(FormField):
    choices: list[dict[str, str]] = field(default_factory=list)


def _has_orphaned_widgets(reader: PdfReader) -> bool:
    for page in reader.pages:
        annots = page.get("/Annots")
        if not annots:
            continue
        for ann in annots:
            resolved = ann.get_object() if hasattr(ann, "get_object") else ann
            if resolved.get("/Subtype") == "/Widget" and resolved.get("/FT"):
                return True
    return False


def _full_field_name(annotation: dict) -> str | None:
    parts: list[str] = []
    node = annotation
    while node:
        t = node.get("/T")
        if t:
            parts.append(t)
        node = node.get("/Parent")
    return ".".join(reversed(parts)) if parts else None


def _build_field_from_dict(raw: dict, name: str) -> FormField:
    ft = raw.get("/FT")
    match ft:
        case "/Tx":
            return FormField(name=name, kind="text")
        case "/Btn":
            return _build_checkbox(raw, name)
        case "/Ch":
            return _build_choice(raw, name)
        case _:
            return FormField(name=name, kind=f"unknown ({ft})")


def _build_checkbox(raw: dict, name: str) -> CheckboxField:
    states = raw.get("/_States_", [])
    if len(states) == 2:
        if "/Off" in states:
            on_val = states[0] if states[0] != "/Off" else states[1]
            return CheckboxField(name=name, kind="checkbox", on_value=on_val, off_value="/Off")
        print(
            f"WARNING: Non-standard checkbox states for '{name}'. "
            "On/off values may be swapped — check the output visually."
        )
        return CheckboxField(name=name, kind="checkbox", on_value=states[0], off_value=states[1])
    return CheckboxField(name=name, kind="checkbox")


def _build_choice(raw: dict, name: str) -> ChoiceField:
    options = []
    for state in raw.get("/_States_", []):
        if isinstance(state, list) and len(state) >= 2:
            options.append({"value": state[0], "text": state[1]})
        else:
            options.append({"value": state, "text": state})
    return ChoiceField(name=name, kind="choice", choices=options)


def _extract_checkbox_on_value(resolved: dict, cb: CheckboxField) -> None:
    if cb.on_value:
        return
    try:
        ap_keys = list(resolved["/AP"]["/N"].keys())
        on_keys = [k for k in ap_keys if k != "/Off"]
        if on_keys:
            cb.on_value = on_keys[0]
            cb.off_value = "/Off"
    except (KeyError, TypeError, AttributeError):
        pass


def _flip_rect(rect: list, page_height: float) -> list[float]:
    left, bottom, right, top = [float(v) for v in rect]
    return [left, page_height - top, right, page_height - bottom]


def _extract_from_widgets(reader: PdfReader) -> list[FormField]:
    fields: list[FormField] = []
    for page_idx, page in enumerate(reader.pages):
        annots = page.get("/Annots")
        if not annots:
            continue
        ph = float(page.mediabox.height)
        for ann in annots:
            resolved = ann.get_object() if hasattr(ann, "get_object") else ann
            if resolved.get("/Subtype") != "/Widget" or not resolved.get("/FT"):
                continue
            name = resolved.get("/T")
            if not name:
                continue
            f = _build_field_from_dict(resolved, name)
            f.page = page_idx + 1
            raw_rect = resolved.get("/Rect")
            f.rect = _flip_rect(raw_rect, ph) if raw_rect else None
            if isinstance(f, CheckboxField):
                _extract_checkbox_on_value(resolved, f)
            fields.append(f)
    return fields


def _extract_from_acroform(reader: PdfReader) -> list[FormField]:
    raw_fields = reader.get_fields()
    if not raw_fields:
        return _extract_from_widgets(reader)

    by_name: dict[str, FormField] = {}
    radio_candidates: set[str] = set()

    for name, raw in raw_fields.items():
        if raw.get("/Kids"):
            if raw.get("/FT") == "/Btn":
                radio_candidates.add(name)
            continue
        by_name[name] = _build_field_from_dict(raw, name)

    radio_groups: dict[str, RadioGroup] = {}

    for page_idx, page in enumerate(reader.pages):
        ph = float(page.mediabox.height)
        for ann in page.get("/Annots", []):
            name = _full_field_name(ann)
            if name in by_name:
                by_name[name].page = page_idx + 1
                raw_rect = ann.get("/Rect")
                by_name[name].rect = _flip_rect(raw_rect, ph) if raw_rect else None
            elif name in radio_candidates:
                _collect_radio_option(ann, name, page_idx, ph, radio_groups)

    located = [f for f in by_name.values() if f.page > 0]
    for f in by_name.values():
        if f.page == 0:
            print(f"WARNING: Field '{f.name}' not found on any page, skipping")

    combined = located + list(radio_groups.values())
    combined.sort(key=_field_sort_key)
    return combined


def _collect_radio_option(
    ann: dict, name: str, page_idx: int, page_height: float, radio_groups: dict[str, RadioGroup]
) -> None:
    try:
        on_keys = [k for k in ann["/AP"]["/N"] if k != "/Off"]
    except KeyError:
        return
    if len(on_keys) != 1:
        return
    if name not in radio_groups:
        radio_groups[name] = RadioGroup(name=name, kind="radio_group", page=page_idx + 1, options=[])
    raw_rect = ann.get("/Rect")
    flipped = _flip_rect(raw_rect, page_height) if raw_rect else None
    radio_groups[name].options.append({"value": on_keys[0], "rect": flipped})


ROW_QUANTIZE = 10.0


def _field_sort_key(f: FormField) -> tuple:
    match f:
        case RadioGroup(options=opts) if opts:
            rect = opts[0].get("rect") or [0, 0, 0, 0]
        case _:
            rect = f.rect or [0, 0, 0, 0]
    row = int(rect[1] / ROW_QUANTIZE)
    return (f.page, row, rect[0])


def _field_to_dict(f: FormField) -> dict:
    result: dict = {"name": f.name, "kind": f.kind}
    if f.page:
        result["page"] = f.page
    if f.rect:
        result["rect"] = f.rect
    match f:
        case CheckboxField(on_value=on, off_value=off):
            if on:
                result["on_value"] = on
            if off:
                result["off_value"] = off
        case RadioGroup(options=opts):
            result["options"] = opts
        case ChoiceField(choices=opts):
            result["choices"] = opts
    return result


def _validate_fill_value(f: FormField, value: str) -> str | None:
    match f:
        case CheckboxField(on_value=on, off_value=off):
            if value not in (on, off):
                return f'ERROR: Invalid value "{value}" for checkbox "{f.name}". Use "{on}" (on) or "{off}" (off).'
        case RadioGroup(options=opts):
            valid = [opt["value"] for opt in opts]
            if value not in valid:
                return f'ERROR: Invalid value "{value}" for radio group "{f.name}". Valid: {valid}'
        case ChoiceField(choices=opts):
            valid = [opt["value"] for opt in opts]
            if value not in valid:
                return f'ERROR: Invalid value "{value}" for choice "{f.name}". Valid: {valid}'
    return None


def cmd_detect(args: list[str]) -> None:
    if len(args) != 1:
        print("Usage: formfill.py detect <file.pdf>")
        sys.exit(1)
    reader = PdfReader(str(Path(args[0])))
    if reader.get_fields() or _has_orphaned_widgets(reader):
        print("Fillable form fields detected")
    else:
        print("No fillable fields found — use layout.py to place text annotations manually")


def cmd_extract(args: list[str]) -> None:
    if len(args) != 2:
        print("Usage: formfill.py extract <input.pdf> <output.json>")
        sys.exit(1)
    pdf_path, json_path = args
    reader = PdfReader(pdf_path)
    fields = _extract_from_acroform(reader)
    output = [_field_to_dict(f) for f in fields]
    Path(json_path).parent.mkdir(parents=True, exist_ok=True)
    Path(json_path).write_text(json.dumps(output, indent=2))
    print(f"Wrote {len(output)} fields to {json_path}")


def cmd_fill(args: list[str]) -> None:
    if len(args) != 3:
        print("Usage: formfill.py fill <input.pdf> <values.json> <output.pdf>")
        sys.exit(1)
    input_path, values_path, output_path = args

    values = json.loads(Path(values_path).read_text())
    reader = PdfReader(input_path)
    fields = _extract_from_acroform(reader)
    meta_by_name = {f.name: f for f in fields}

    has_error = _validate_fill_entries(values, meta_by_name)
    if has_error:
        sys.exit(1)

    pages: dict[int, dict[str, str]] = {}
    for entry in values:
        if "value" in entry:
            pages.setdefault(entry["page"], {})[entry["name"]] = entry["value"]

    writer = PdfWriter(clone_from=reader)
    for pg, vals in pages.items():
        writer.update_page_form_field_values(writer.pages[pg - 1], vals, auto_regenerate=True)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as f:
        writer.write(f)

    print(f"Filled {sum(len(v) for v in pages.values())} fields → {output_path}")


def _validate_fill_entries(values: list[dict], meta_by_name: dict[str, FormField]) -> bool:
    has_error = False
    for entry in values:
        name = entry["name"]
        existing = meta_by_name.get(name)
        if not existing:
            print(f"ERROR: '{name}' is not a valid field name")
            has_error = True
        elif entry.get("page") and entry["page"] != existing.page:
            print(f"ERROR: Wrong page for '{name}' (got {entry['page']}, expected {existing.page})")
            has_error = True
        elif "value" in entry:
            err = _validate_fill_value(existing, entry["value"])
            if err:
                print(err)
                has_error = True
    return has_error


SUBCOMMANDS = {
    "detect": cmd_detect,
    "extract": cmd_extract,
    "fill": cmd_fill,
}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in SUBCOMMANDS:
        print(f"Usage: formfill.py <{'|'.join(SUBCOMMANDS)}> [args...]")
        sys.exit(1)
    SUBCOMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
