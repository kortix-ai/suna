"""A JSON Schema subset validator for the kit's own schemas (stdlib only).

Supports: type, required, properties, additionalProperties (bool or schema),
items, enum, minLength, maxLength, minItems, maxItems, minimum, maximum,
pattern, $ref by $id. Lumen validates again with a full validator (ajv);
this one exists so an agent sees the error before it writes a file.
"""
import json
import os
import re

SCHEMA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "schemas")
_TYPES = {
    "object": dict, "array": list, "string": str, "boolean": bool, "null": type(None),
    "number": (int, float), "integer": int,
}
_schemas: dict[str, dict] = {}


def schema(name: str) -> dict:
    if not _schemas:
        for f in os.listdir(SCHEMA_DIR):
            if f.endswith(".schema.json"):
                with open(os.path.join(SCHEMA_DIR, f), encoding="utf-8") as fh:
                    s = json.load(fh)
                _schemas[s["$id"]] = s
    if name not in _schemas:
        raise KeyError(f"unknown schema {name!r}; known: {sorted(_schemas)}")
    return _schemas[name]


def _is(value, t: str) -> bool:
    if t in ("number", "integer") and isinstance(value, bool):
        return False
    return isinstance(value, _TYPES[t])


def errors(value, s: dict, path: str = "$") -> list[str]:
    if "$ref" in s:
        return errors(value, schema(s["$ref"]), path)
    out: list[str] = []
    if "enum" in s and value not in s["enum"]:
        return [f"{path}: must be one of {s['enum']}"]
    if "type" in s:
        types = s["type"] if isinstance(s["type"], list) else [s["type"]]
        if not any(_is(value, t) for t in types):
            return [f"{path}: must be {' or '.join(types)}"]
    if isinstance(value, str):
        if len(value) < s.get("minLength", 0):
            out.append(f"{path}: shorter than {s['minLength']}")
        if "maxLength" in s and len(value) > s["maxLength"]:
            out.append(f"{path}: longer than {s['maxLength']} characters")
        if "pattern" in s and not re.search(s["pattern"], value):
            out.append(f"{path}: does not match {s['pattern']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in s and value < s["minimum"]:
            out.append(f"{path}: below {s['minimum']}")
        if "maximum" in s and value > s["maximum"]:
            out.append(f"{path}: above {s['maximum']}")
    if isinstance(value, list):
        if len(value) < s.get("minItems", 0):
            out.append(f"{path}: needs at least {s['minItems']} items")
        if "maxItems" in s and len(value) > s["maxItems"]:
            out.append(f"{path}: at most {s['maxItems']} items")
        if "items" in s:
            for i, v in enumerate(value):
                out += errors(v, s["items"], f"{path}[{i}]")
    if isinstance(value, dict):
        props = s.get("properties", {})
        for k in s.get("required", []):
            if k not in value:
                out.append(f"{path}: missing {k}")
        extra = s.get("additionalProperties", True)
        for k, v in value.items():
            if k in props:
                out += errors(v, props[k], f"{path}.{k}")
            elif extra is False:
                out.append(f"{path}: unknown field {k}")
            elif isinstance(extra, dict):
                out += errors(v, extra, f"{path}.{k}")
    return out
