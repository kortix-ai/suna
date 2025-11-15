# Critical Bug Fix: Tool Call Arguments Format

## The Problem

When saving assistant messages with tool calls, we were parsing `arguments` to a dict:

```python
args = safe_json_parse(tc_buf['function']['arguments'])  # Converts to dict
tool_call_obj = {
    "function": {"arguments": args}  # ← dict!
}
```

But LiteLLM's Bedrock converter expects `arguments` to be a **JSON string**:

```python
# LiteLLM code (litellm_core_utils/prompt_templates/factory.py:2675)
if not arguments or not arguments.strip():  # ← expects string!
    ...
```

## The Error

```
AttributeError: 'dict' object has no attribute 'strip'
```

This happens when the saved assistant message (with tool_calls) is sent back to the LLM in a subsequent turn. LiteLLM tries to convert it to Bedrock format and fails because it expects a string.

## The Fix

Keep `arguments` as a JSON string when saving to the message:

```python
args_string = tc_buf['function']['arguments']  # Keep as string

# Validate it's valid JSON (but don't convert)
parsed_args = safe_json_parse(args_string)  # Just for validation

tool_call_obj = {
    "function": {"arguments": args_string}  # ← JSON string!
}
```

## Why This Matters

1. **For Execution:** We parse to dict when executing tools (line 484, 1509)
2. **For Saving:** We keep as JSON string when saving to DB
3. **For LLM:** When message is sent back to LLM, LiteLLM needs JSON string

## Consistency

The non-streaming path already does this correctly (line 1155):
```python
"arguments": tool_call.function.arguments if isinstance(tool_call.function.arguments, str) else to_json_string(tool_call.function.arguments)
```

Now the streaming path matches this behavior.

