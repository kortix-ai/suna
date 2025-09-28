import json
import re
import xml.dom.minidom
from typing import AsyncGenerator, Optional, Any


# --- ANSI Colors ---
class Colors:
    HEADER = "\033[95m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    ENDC = "\033[0m"
    BOLD = "\033[1m"
    UNDERLINE = "\033[4m"


def try_parse_json(json_str: str) -> Optional[Any]:
    """Utility function to safely parse JSON strings."""
    try:
        return json.loads(json_str)
    except (json.JSONDecodeError, TypeError):
        return None


def format_xml_if_valid(content: str) -> str:
    """
    Check if content is XML and format it prettily if so.
    Returns the original content if it's not valid XML.
    """
    if not content or not content.strip():
        return content

    # Quick check if it looks like XML
    stripped_content = content.strip()
    if not (stripped_content.startswith("<") and stripped_content.endswith(">")):
        return content

    try:
        # Parse and pretty-print the XML
        dom = xml.dom.minidom.parseString(stripped_content)
        pretty_xml = dom.toprettyxml(indent="  ")

        # Remove empty lines and the XML declaration for cleaner output
        lines = [line for line in pretty_xml.split("\n") if line.strip()]
        if lines and lines[0].startswith("<?xml"):
            lines = lines[1:]  # Remove XML declaration

        # Apply syntax highlighting
        highlighted_lines = []
        for line in lines:
            highlighted_line = _highlight_xml_line(line)
            highlighted_lines.append(highlighted_line)

        return "\n" + "\n".join(highlighted_lines)
    except Exception:
        # If XML parsing fails, return original content
        return content


def _highlight_xml_line(line: str) -> str:
    """
    Apply simple syntax highlighting to an XML line.
    """
    if not line.strip():
        return line

    # Process the line character by character to avoid regex conflicts
    result = []
    i = 0
    while i < len(line):
        char = line[i]

        if char == "<":
            # Find the end of the tag
            tag_end = line.find(">", i)
            if tag_end == -1:
                result.append(char)
                i += 1
                continue

            # Extract the full tag
            tag_content = line[i : tag_end + 1]
            highlighted_tag = _highlight_xml_tag(tag_content)
            result.append(highlighted_tag)
            i = tag_end + 1
        else:
            result.append(char)
            i += 1

    return "".join(result)


def _highlight_xml_tag(tag: str) -> str:
    """
    Highlight a complete XML tag (from < to >).
    """
    if not tag.startswith("<") or not tag.endswith(">"):
        return tag

    # Check if it's a closing tag
    is_closing = tag.startswith("</")

    # Extract tag name and attributes
    if is_closing:
        # For closing tags like </function_calls>
        tag_name = tag[2:-1].strip()
        return f"{Colors.YELLOW}</{Colors.BLUE}{Colors.BOLD}{tag_name}{Colors.ENDC}{Colors.YELLOW}>{Colors.ENDC}"
    else:
        # For opening tags with possible attributes
        inner = tag[1:-1]  # Remove < and >

        # Split on first space to separate tag name from attributes
        parts = inner.split(" ", 1)
        tag_name = parts[0]

        result = f"{Colors.YELLOW}<{Colors.BLUE}{Colors.BOLD}{tag_name}{Colors.ENDC}"

        if len(parts) > 1:
            # Process attributes
            attrs = parts[1]
            highlighted_attrs = _highlight_attributes(attrs)
            result += " " + highlighted_attrs

        result += f"{Colors.YELLOW}>{Colors.ENDC}"
        return result


def _highlight_attributes(attrs: str) -> str:
    """
    Highlight XML attributes.
    """
    # Use regex to find attribute="value" patterns
    pattern = r'([a-zA-Z_][a-zA-Z0-9_-]*)(=)(["\'])([^"\']*)\3'

    def replace_attr(match):
        attr_name = match.group(1)
        equals = match.group(2)
        quote = match.group(3)
        value = match.group(4)
        return f"{Colors.CYAN}{attr_name}{Colors.ENDC}{equals}{quote}{Colors.GREEN}{value}{Colors.ENDC}{quote}"

    return re.sub(pattern, replace_attr, attrs)


async def print_stream(stream: AsyncGenerator[str, None]):
    """
    Simple stream printer that processes async string generator.
    Follows the same output format as stream_test.py.
    """
    stream_started = False
    chunks = []  # Store chunks to sort by sequence
    parsing_state = "text"  # "text", "in_function_call", "function_call_ended"
    current_function_name = None
    invoke_name_regex = re.compile(r'<invoke\s+name="([^"]+)"')

    def rebuild_full_text():
        """Rebuild full text from sorted chunks like the original processor"""
        # Sort chunks by sequence
        sorted_chunks = sorted(chunks, key=lambda c: c.get("sequence", 0))

        full_text_parts = []
        for chunk in sorted_chunks:
            content = chunk.get("content", "")
            if content:
                parsed_content = try_parse_json(content)
                if parsed_content and "content" in parsed_content:
                    full_text_parts.append(parsed_content["content"])

        return "".join(full_text_parts)

    async for line in stream:
        line = line.strip()

        # Skip empty lines
        if not line:
            continue

        # Parse stream data lines
        if line.startswith("data: "):
            json_str = line[6:]  # Remove "data: " prefix

            data = try_parse_json(json_str)
            if not data:
                continue

            event_type = data.get("type", "unknown")

            # Print stream start on first event
            if not stream_started:
                print(f"{Colors.BLUE}{Colors.BOLD}🚀 [STREAM START]{Colors.ENDC}")
                stream_started = True

            if event_type == "status":
                # Parse status like the original - merge content with event data
                status_details = try_parse_json(data.get("content", "{}")) or {}
                if data.get("status"):
                    status_details["status_type"] = data["status"]
                if data.get("message"):
                    status_details["message"] = data["message"]

                full_status = {**data, **status_details}
                finish_reason = full_status.get("finish_reason", "received")
                status_type = full_status.get(
                    "status_type", full_status.get("status", "unknown")
                )
                print(
                    f"{Colors.CYAN}ℹ️  [STATUS] {Colors.BOLD}{status_type}{Colors.ENDC}{Colors.CYAN} {finish_reason}{Colors.ENDC}"
                )

            elif event_type == "assistant":
                message_id = data.get("message_id")
                sequence = data.get("sequence")
                content = data.get("content", "")

                # Assistant chunks (message_id is null, has sequence) - accumulate text
                if message_id is None and sequence is not None:
                    # Add chunk to collection
                    chunks.append(data)

                    # Rebuild full text from all chunks
                    full_text = rebuild_full_text()

                    # Check for function call detection
                    if parsing_state == "text":
                        if "<function_calls>" in full_text:
                            parsing_state = "in_function_call"
                            print(
                                f"\n{Colors.YELLOW}🔧 [TOOL USE DETECTED]{Colors.ENDC}"
                            )

                    elif parsing_state == "in_function_call":
                        if current_function_name is None:
                            match = invoke_name_regex.search(full_text)
                            if match:
                                current_function_name = match.group(1)
                                print(
                                    f'{Colors.BLUE}⚡ [TOOL UPDATE] Calling function: {Colors.BOLD}"{current_function_name}"{Colors.ENDC}'
                                )

                        if "</function_calls>" in full_text:
                            parsing_state = "function_call_ended"
                            print(f"{Colors.YELLOW}⏳ [TOOL USE WAITING]{Colors.ENDC}")
                            current_function_name = None

                # Complete assistant messages (message_id is not null) - print final message
                elif message_id is not None:
                    if content:
                        parsed_content = try_parse_json(content)
                        if parsed_content:
                            role = parsed_content.get("role", "unknown")
                            message_content = parsed_content.get("content", "")
                            # Format XML content prettily if it's XML
                            formatted_content = format_xml_if_valid(message_content)
                            print()  # New line
                            print(
                                f"{Colors.GREEN}💬 [MESSAGE] {Colors.ENDC}{formatted_content}"
                            )
                        else:
                            print()  # New line
                            print(
                                f"{Colors.RED}❌ [MESSAGE] Failed to parse message content{Colors.ENDC}"
                            )

                    # Reset state for next message
                    chunks = []
                    parsing_state = "text"
                    current_function_name = None

            elif event_type == "tool":
                # Handle tool results
                message_id = data.get("message_id")
                content = data.get("content", "")

                if not content:
                    print(
                        f"{Colors.RED}❌ [TOOL RESULT] No content in message{Colors.ENDC}"
                    )
                    continue

                parsed_content = try_parse_json(content)
                if not parsed_content:
                    print(
                        f"{Colors.RED}❌ [TOOL RESULT] Failed to parse message content{Colors.ENDC}"
                    )
                    continue

                execution_result = parsed_content
                if not execution_result:
                    print(
                        f"{Colors.RED}❌ [TOOL RESULT] Failed to parse execution result{Colors.ENDC}"
                    )
                    continue

                tool_execution = execution_result.get("tool_execution", {})
                tool_name = tool_execution.get("function_name")
                result = tool_execution.get("result", {})
                was_success = result.get("success", False)
                output = json.dumps(result.get("output", {}))
                error = json.dumps(result.get("error", {}))

                if was_success:
                    # Check if output is long enough to truncate or format as XML
                    if len(output) > 80:
                        # Check if it's XML first, if so format it nicely
                        formatted_output = format_xml_if_valid(output)
                        if formatted_output != output:
                            # It was XML, show it formatted
                            output_preview = formatted_output
                        else:
                            # Not XML, truncate normally
                            output_preview = output[:80] + "..."
                    else:
                        # Short output, check if it's XML and format if so
                        output_preview = format_xml_if_valid(output)
                        if output_preview == "{}":
                            output_preview = "No answer found."

                    print(
                        f'{Colors.GREEN}✅ [TOOL RESULT] {Colors.BOLD}"{tool_name}"{Colors.ENDC}{Colors.GREEN} | Success! Output: {Colors.ENDC}{output_preview}'
                    )
                else:
                    # Format error output as XML if it's XML
                    formatted_error = format_xml_if_valid(error)
                    print(
                        f'{Colors.RED}❌ [TOOL RESULT] {Colors.BOLD}"{tool_name}"{Colors.ENDC}{Colors.RED} | Failure! Error: {Colors.ENDC}{formatted_error}'
                    )
