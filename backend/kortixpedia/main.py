from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from core.services import llm
from core.utils.logger import logger
import json

router = APIRouter(tags=["Kortixpedia"])

# System prompt for the PLANNER - outputs layout XML structure with grid/layout info
PLANNER_SYSTEM_PROMPT = """You are a knowledge page layout planner. Create a structured XML layout for an educational page.

OUTPUT ONLY VALID XML. No explanations, no markdown, just pure XML starting with <page>.

The XML structure:
<page>
  <title>Page Title</title>
  <hero>
    <headline>Catchy headline</headline>
    <subheadline>Brief description</subheadline>
  </hero>
  <rows>
    <row layout="full">
      <section id="1">
        <title>Section Title</title>
        <description>What this section covers</description>
        <type>text</type>
      </section>
    </row>
    <row layout="2-col">
      <section id="2">
        <title>Left Section</title>
        <description>Description</description>
        <type>diagram</type>
      </section>
      <section id="3">
        <title>Right Section</title>
        <description>Description</description>
        <type>list</type>
      </section>
    </row>
    <row layout="full">
      <section id="4">
        <title>Another Full Section</title>
        <description>Description</description>
        <type>timeline</type>
      </section>
    </row>
  </rows>
</page>

Layout options for rows:
- full: Single section spanning full width
- 2-col: Two sections side by side (50/50)
- 3-col: Three sections in a row
- sidebar-left: Main content with left sidebar (30/70)
- sidebar-right: Main content with right sidebar (70/30)

Section types: text, diagram, timeline, comparison, list, code, stats, quote, gallery

Rules:
- Create 5-8 sections organized into 3-5 rows
- Mix different layouts for visual variety
- Use 2-col and 3-col for related content
- Each section needs unique id starting from 1
- Output ONLY the XML"""

# System prompt for CONTENT generator - outputs clean inline HTML+CSS
CONTENT_SYSTEM_PROMPT = """You generate self-contained HTML content blocks with inline CSS.

OUTPUT RULES - VERY IMPORTANT:
1. Start DIRECTLY with <div class="kp-block"> - no markdown, no backticks, no ```html
2. End with </div>
3. Include a <style> tag INSIDE the div with all CSS
4. Use class names starting with "kp-" to avoid conflicts

CSS Variables available:
--kp-bg: #0a0a0a;
--kp-card: #141414;
--kp-border: #262626;
--kp-text: #fafafa;
--kp-muted: #a1a1aa;
--kp-primary: #8b5cf6;
--kp-accent: #06b6d4;

Example:
<div class="kp-block">
<style>
.kp-intro {
  padding: 2rem;
  background: var(--kp-card);
  border-radius: 1rem;
  border: 1px solid var(--kp-border);
}
.kp-intro h3 { color: var(--kp-text); font-size: 1.5rem; margin-bottom: 1rem; }
.kp-intro p { color: var(--kp-muted); line-height: 1.7; }
.kp-highlight { color: var(--kp-primary); font-weight: 600; }
</style>
<div class="kp-intro">
  <h3>Introduction</h3>
  <p>Content with <span class="kp-highlight">highlighted text</span>.</p>
</div>
</div>

Create visually engaging content:
- For diagrams: Use SVG or creative CSS shapes
- For timelines: Visual timeline with dots and lines
- For comparisons: Side-by-side cards with vs styling
- For lists: Styled lists with icons/numbers
- For stats: Big numbers with labels
- For code: Syntax-highlighted code blocks
- For quotes: Stylized blockquotes
- For gallery: Grid of visual elements"""


@router.get("/explore/{topic}", summary="Stream knowledge page layout", operation_id="explore_topic")
async def explore_topic(topic: str):
    """
    Planner endpoint - streams the layout XML structure for a knowledge page.
    """
    logger.info(f"📋 Planning layout for topic: {topic}")

    messages = [
        {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
        {"role": "user", "content": f"Create a knowledge page layout for: {topic}"}
    ]

    try:
        llm_response = await llm.make_llm_api_call(
            messages=messages,
            model_name="groq/moonshotai/kimi-k2-instruct",
            temperature=0.7,
            max_tokens=2000,
            stream=True,
        )

        async def stream_generator():
            try:
                async for chunk in llm_response:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        yield f"data: {json.dumps({'type': 'content', 'content': content})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
            except Exception as e:
                logger.error(f"Stream error: {e}")
                yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            }
        )

    except Exception as e:
        logger.error(f"Error in explore_topic: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/explore/content/{section_id}", summary="Stream section content", operation_id="generate_section_content")
async def generate_section_content(
    section_id: str,
    title: str,
    description: str,
    type: str = "text",
    topic: str = ""
):
    """
    Content endpoint - streams HTML+CSS for a specific section.
    """
    logger.info(f"🎨 Generating content for section {section_id}: {title}")

    user_prompt = f"""Create HTML content for a "{type}" section:

Topic: {topic}
Section Title: {title}
Description: {description}

Generate informative, educational content with beautiful styling. Remember:
- Start with <div class="kp-block">
- Include all CSS in a <style> tag
- End with </div>
- NO markdown, NO code fences, just raw HTML"""

    messages = [
        {"role": "system", "content": CONTENT_SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt}
    ]

    try:
        llm_response = await llm.make_llm_api_call(
            messages=messages,
            model_name="groq/moonshotai/kimi-k2-instruct",
            temperature=0.7,
            max_tokens=4000,
            stream=True,
        )

        async def stream_generator():
            try:
                async for chunk in llm_response:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        yield f"data: {json.dumps({'type': 'content', 'content': content, 'section_id': section_id})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'section_id': section_id})}\n\n"
            except Exception as e:
                logger.error(f"Stream error for section {section_id}: {e}")
                yield f"data: {json.dumps({'type': 'error', 'message': str(e), 'section_id': section_id})}\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            }
        )

    except Exception as e:
        logger.error(f"Error generating content for section {section_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
