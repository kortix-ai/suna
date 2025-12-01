"""
Explorer Page Generator - Grid-based knowledge page generation

Query → Grid outline → Parallel cell content generation

Each cell can span multiple grid units (1x1, 2x1, 1x2, 2x2, etc.)
Content is constrained to fit within the cell.
"""

import asyncio
import json
import time
from typing import Optional, List, Dict, Any

from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata, method_metadata
from core.services.llm import make_llm_api_call
from core.utils.logger import logger


@tool_metadata(
    display_name="Explorer Page Generator",
    description="Generate grid-based knowledge pages with parallel content generation",
    icon="BookOpen",
    color="bg-indigo-100 dark:bg-indigo-800/50",
    weight=25,
    visible=True
)
class ExplorerPageGeneratorTool(Tool):

    def __init__(self, thread_manager=None):
        super().__init__()
        self.thread_manager = thread_manager
        self.content_model = "anthropic/claude-3-5-haiku-latest"
        self.outline_model = "anthropic/claude-3-5-sonnet-latest"

    @method_metadata(
        display_name="Create Page Outline",
        description="Generate grid layout with cell definitions",
        visible=True
    )
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_page_outline",
            "description": "Generate a grid-based page outline for a knowledge query. Returns cell definitions that can span multiple grid units. Call fill_page_blocks after to generate content in parallel.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The knowledge query or topic"
                    }
                },
                "required": ["query"]
            }
        }
    })
    async def create_page_outline(self, query: str) -> ToolResult:
        """Generate grid-based page outline."""
        start_time = time.time()
        
        try:
            system_prompt = """Generate a grid-based knowledge page outline.

Output JSON:
{
  "title": "Page title",
  "summary": "One line summary",
  "cells": [
    {
      "id": "cell-slug",
      "title": "Cell Title",
      "description": "What to cover",
      "size": "1x1" | "2x1" | "1x2" | "2x2",
      "position": 0
    }
  ]
}

Grid sizes:
- "1x1": Small card (1-2 paragraphs)
- "2x1": Wide card (2-3 paragraphs)  
- "1x2": Tall card (3-4 paragraphs with list)
- "2x2": Large card (4-5 paragraphs, detailed)

Guidelines:
- 4-8 cells total
- Mix of sizes for visual interest
- Logical content flow
- Each cell is self-contained"""

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Create grid outline for: {query}"}
            ]
            
            response = await make_llm_api_call(
                messages=messages,
                model_name=self.outline_model,
                temperature=0.7,
                max_tokens=2000,
                response_format={"type": "json_object"}
            )
            
            outline = json.loads(response.choices[0].message.content)
            generation_time_ms = (time.time() - start_time) * 1000
            
            outline["_meta"] = {"time_ms": round(generation_time_ms, 2)}
            
            print(f"\n[OUTLINE] {query[:30]}... → {len(outline.get('cells', []))} cells in {generation_time_ms:.0f}ms")
            
            return self.success_response(outline)
            
        except Exception as e:
            logger.error(f"Outline error: {e}")
            return self.fail_response(str(e))

    @method_metadata(
        display_name="Fill Page Blocks",
        description="Generate content for all grid cells in parallel",
        visible=True
    )
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "fill_page_blocks",
            "description": "Generate content for all grid cells in parallel. Call after create_page_outline.",
            "parameters": {
                "type": "object",
                "properties": {
                    "cells": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "title": {"type": "string"},
                                "description": {"type": "string"},
                                "size": {"type": "string"},
                                "position": {"type": "integer"}
                            },
                            "required": ["id", "title", "description", "size", "position"]
                        }
                    },
                    "context": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "summary": {"type": "string"}
                        }
                    }
                },
                "required": ["cells"]
            }
        }
    })
    async def fill_page_blocks(
        self,
        cells: List[Dict[str, Any]],
        context: Optional[Dict[str, Any]] = None
    ) -> ToolResult:
        """Generate content for all cells in parallel."""
        start_time = time.time()
        
        if not cells:
            return self.fail_response("No cells")
        
        ctx = context or {}
        
        print(f"\n[FILL] {len(cells)} cells parallel...")
        
        tasks = [self._generate_cell(cell, ctx) for cell in cells]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        total_ms = (time.time() - start_time) * 1000
        
        generated = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                generated.append({
                    "id": cells[i].get("id"),
                    "title": cells[i].get("title"),
                    "size": cells[i].get("size"),
                    "position": cells[i].get("position", i),
                    "success": False,
                    "content": ""
                })
            else:
                generated.append(result)
        
        generated.sort(key=lambda x: x.get("position", 0))
        ok = sum(1 for c in generated if c.get("success"))
        
        print(f"[DONE] {ok}/{len(cells)} in {total_ms:.0f}ms\n")
        
        return self.success_response({
            "success": ok == len(cells),
            "cells": generated,
            "time_ms": round(total_ms, 2)
        })

    async def _generate_cell(self, cell: Dict[str, Any], ctx: Dict[str, Any]) -> Dict[str, Any]:
        """Generate content for one cell."""
        start = time.time()
        
        size_guide = {
            "1x1": "1-2 short paragraphs, ~50-80 words",
            "2x1": "2-3 paragraphs, ~100-150 words",
            "1x2": "3-4 paragraphs or a paragraph + list, ~120-180 words",
            "2x2": "4-5 paragraphs with detail, ~200-300 words"
        }
        
        size = cell.get("size", "1x1")
        
        try:
            system_prompt = f"""Generate concise knowledge content for a grid cell.

Output JSON:
{{"content": "HTML content (p, ul, li, strong, em only)"}}

Constraints:
- Size: {size} → {size_guide.get(size, size_guide['1x1'])}
- NO title (already shown)
- NO h1/h2/h3 tags
- Informative, encyclopedic tone
- Fit content to size constraint"""

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Topic: {ctx.get('title', '')}\nCell: {cell.get('title')}\nCover: {cell.get('description')}"}
            ]
            
            response = await make_llm_api_call(
                messages=messages,
                model_name=self.content_model,
                temperature=0.7,
                max_tokens=800,
                response_format={"type": "json_object"}
            )
            
            data = json.loads(response.choices[0].message.content)
            ms = (time.time() - start) * 1000
            
            print(f"  ✓ {cell.get('title')[:25]} [{size}] {ms:.0f}ms")
            
            return {
                "id": cell.get("id"),
                "title": cell.get("title"),
                "size": size,
                "position": cell.get("position", 0),
                "success": True,
                "content": data.get("content", ""),
                "time_ms": round(ms, 2)
            }
            
        except Exception as e:
            ms = (time.time() - start) * 1000
            print(f"  ✗ {cell.get('title')[:25]} [{size}] FAIL")
            
            return {
                "id": cell.get("id"),
                "title": cell.get("title"),
                "size": size,
                "position": cell.get("position", 0),
                "success": False,
                "content": "",
                "time_ms": round(ms, 2)
            }
