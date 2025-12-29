from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
import httpx
import asyncio
import json
from core.services import llm
from core.utils.logger import logger
from core.utils.config import config

router = APIRouter(tags=["Kortixpedia"])

# ============ CONFIGURATION ============
ENABLE_IMAGE_OCR = False  # Set to True to enable vision-based OCR for image context extraction

# ============ IMAGE SEARCH & OCR ============
# Image data structure with dimensions and OCR text
class ImageData:
    def __init__(self, url: str, width: int = 0, height: int = 0, ocr_text: str = ""):
        self.url = url
        self.width = width
        self.height = height
        self.aspect_ratio = round(width / height, 2) if height > 0 else 1.5  # Default to 3:2
        self.ocr_text = ocr_text  # Extracted text/description from image
    
    def to_dict(self):
        return {
            "url": self.url,
            "width": self.width,
            "height": self.height,
            "aspect_ratio": self.aspect_ratio,
            "ocr_text": self.ocr_text
        }


async def extract_image_context(image_url: str, topic: str = "") -> str:
    """
    SUPER FAST OCR + description extraction using Groq's Llama 4 Scout vision model.
    Groq provides blazing fast inference for vision tasks.
    Returns extracted text and brief description to match content with image.
    
    See: https://console.groq.com/docs/vision
    """
    try:
        # Use Groq's Llama 4 Scout - blazing fast vision model
        messages = [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f"""FAST SCAN - Extract in 2-3 lines max:
1. Any visible TEXT (labels, titles, numbers, captions)
2. Key visual elements (diagram type, objects, symbols)

Topic context: {topic}

Format: TEXT: [extracted text] | VISUAL: [key elements]
Be concise. Skip if nothing relevant."""
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": image_url}
                    }
                ]
            }
        ]
        
        # Use Groq's Llama 4 Scout - super fast vision inference
        response = await llm.make_llm_api_call(
            messages=messages,
            model_name="groq/meta-llama/llama-4-scout-17b-16e-instruct",
            temperature=0.1,
            max_tokens=150,  # Keep it short for speed
            stream=False,
        )
        
        if response and response.choices:
            ocr_result = response.choices[0].message.content.strip()
            logger.info(f"👁️ Groq OCR extracted: {ocr_result[:100]}...")
            return ocr_result
        return ""
    except Exception as e:
        logger.warning(f"⚠️ Groq OCR extraction failed (non-blocking): {e}")
        return ""  # Non-blocking - return empty if OCR fails


async def search_images(query: str, num_results: int = 8, with_metadata: bool = False) -> list:
    """Search for images using SERPER API. Returns URLs or ImageData objects."""
    if not config.SERPER_API_KEY:
        return []
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://google.serper.dev/images",
                json={"q": query, "num": num_results},
                headers={"X-API-KEY": config.SERPER_API_KEY, "Content-Type": "application/json"},
                timeout=10.0
            )
            response.raise_for_status()
            images = response.json().get("images", [])
            logger.info(f"🔍 SERPER returned {len(images)} images for query: {query}")
            
            # Filter out SVGs and extract data
            valid_images = []
            for img in images:
                url = img.get("imageUrl", "")
                if url and not url.endswith('.svg'):
                    if with_metadata:
                        width = img.get("imageWidth", 0) or img.get("width", 0) or 400
                        height = img.get("imageHeight", 0) or img.get("height", 0) or 300
                        valid_images.append(ImageData(url, width, height))
                    else:
                        valid_images.append(url)
                    if len(valid_images) >= num_results:
                        break
            
            return valid_images
    except Exception as e:
        logger.error(f"Image search error: {e}")
        return []


# ============ DYNAMIC LAYOUT PLANNER ============
PLANNER_SYSTEM_PROMPT = """You create educational pages with DYNAMIC, VARIED layouts. NOT all same-type cells grouped together.

OUTPUT ONLY VALID XML. No markdown. Start with <page>.

CRITICAL LAYOUT RULES:
1. NEVER put all stats together - spread them throughout the page
2. ALTERNATE between large sections and small cells
3. Create visual rhythm: section → 2 small cells → section → 1 stat + 1 fact → etc.
4. The page should feel like reading a well-designed magazine, not a data dump
5. ADD IMAGES to sections that benefit from visual explanation (diagrams, illustrations, examples)

EXAMPLE FLOW (vary this based on topic):
- Overview section (full width) + image
- 1 stat + 1 key fact (half width each)
- How It Works section (full width) + diagram image
- 2-3 component cards (quarter/half width)
- 1 stat + deep insight (half width each)
- Applications section (full width) + real-world image
- Pros + Cons (half width each)
- 1 stat + timeline intro (quarter + three-quarter)
- History section (full width) + historical image
- Resources (2 half-width cards)

XML STRUCTURE:
<page>
  <title>Clear Topic Title</title>
  <subtitle>One compelling sentence</subtitle>
  
  <toc>
    <section id="overview" title="Overview" />
    <section id="how-it-works" title="How It Works" />
    <section id="components" title="Key Parts" />
    <section id="deep-dive" title="Deep Dive" />
    <section id="applications" title="Applications" />
    <section id="history" title="History" />
  </toc>
  
  <grid>
    <!-- INTRO: Overview first - WITH IMAGE -->
    <cell id="overview" cols="4" type="section" tokens="400" image_query="[topic] concept diagram illustration">
      <title>What is [Topic]?</title>
      <desc>Clear introduction explaining what it is and why it matters.</desc>
    </cell>
    
    <!-- MIXED ROW: Stat + Fact - No images for small cells -->
    <cell id="stat1" cols="2" type="stat" tokens="100">
      <title>Key Number</title>
      <desc>Important metric</desc>
    </cell>
    <cell id="keypoint1" cols="2" type="fact" tokens="200">
      <title>Key Point</title>
      <desc>Important concept</desc>
    </cell>
    
    <!-- MAIN SECTION: How it works - WITH DIAGRAM -->
    <cell id="how-it-works" cols="4" type="steps" tokens="700" image_query="[topic] how it works diagram process">
      <title>How [Topic] Works</title>
      <desc>Step-by-step A-to-Z explanation</desc>
    </cell>
    
    <!-- COMPONENTS ROW: Mixed sizes - Some with images -->
    <cell id="part1" cols="1" type="component" tokens="120">
      <title>Part 1</title>
      <desc>Key component</desc>
    </cell>
    <cell id="part2" cols="1" type="component" tokens="120">
      <title>Part 2</title>
      <desc>Key component</desc>
    </cell>
    <cell id="stat2" cols="2" type="stat" tokens="100">
      <title>Another Metric</title>
      <desc>Relevant number</desc>
    </cell>
    
    <!-- DEEP SECTION - WITH TECHNICAL IMAGE -->
    <cell id="deep-dive" cols="4" type="section" tokens="450" image_query="[topic] technical architecture visualization">
      <title>Understanding [Detail]</title>
      <desc>Deeper technical explanation</desc>
    </cell>
    
    <!-- INSIGHT ROW - Fact with image -->
    <cell id="insight1" cols="2" type="fact" tokens="200" image_query="[topic] key insight infographic">
      <title>Key Insight</title>
      <desc>Important takeaway</desc>
    </cell>
    <cell id="stat3" cols="2" type="stat" tokens="100">
      <title>Impact Metric</title>
      <desc>Measurable result</desc>
    </cell>
    
    <!-- COMPARISON - No images -->
    <cell id="pros" cols="2" type="pros" tokens="200">
      <title>Advantages</title>
      <desc>Benefits</desc>
    </cell>
    <cell id="cons" cols="2" type="cons" tokens="200">
      <title>Limitations</title>
      <desc>Challenges</desc>
    </cell>
    
    <!-- APPLICATIONS - WITH REAL-WORLD IMAGE -->
    <cell id="applications" cols="4" type="section" tokens="400" image_query="[topic] real world application example">
      <title>Real-World Applications</title>
      <desc>Practical uses and examples</desc>
    </cell>
    
    <!-- HISTORY with stat -->
    <cell id="stat4" cols="1" type="stat" tokens="80">
      <title>Year Started</title>
      <desc>Origin date</desc>
    </cell>
    <cell id="history" cols="3" type="timeline" tokens="350" image_query="[topic] history evolution timeline">
      <title>History & Evolution</title>
      <desc>Key milestones</desc>
    </cell>
    
    <!-- RESOURCES - No images -->
    <cell id="learn" cols="2" type="resource" tokens="150">
      <title>Learn More</title>
      <desc>Resources</desc>
    </cell>
    <cell id="start" cols="2" type="resource" tokens="150">
      <title>Get Started</title>
      <desc>First steps</desc>
    </cell>
  </grid>
</page>

IMAGE QUERY GUIDELINES:
- Add image_query="..." attribute to cells that benefit from visual explanation
- Queries should be specific and descriptive for good image search results
- Include the topic name in each query for relevance
- Best for: section, steps, timeline, large fact cells (cols>=2)
- Skip for: stat, small component, pros/cons, resource cells
- Aim for 5-8 image_query attributes per page (not every cell needs one)
- Make queries descriptive: "[topic] diagram", "[topic] example", "[topic] visualization"

CELL TYPES:
- stat: Big number (80-100 tokens) - SPREAD THESE OUT, don't group - NO IMAGE
- fact: Quick insight card (150-200 tokens) - OPTIONAL IMAGE if cols>=2
- component: Part/element (100-150 tokens) - NO IMAGE
- section: In-depth content (400-500 tokens) - SHOULD HAVE IMAGE
- steps: A-to-Z guide (600-800 tokens) - SHOULD HAVE IMAGE (diagram)
- timeline: Chronological (300-400 tokens) - SHOULD HAVE IMAGE
- pros/cons: Lists (150-200 tokens) - NO IMAGE
- resource: Next steps (100-150 tokens) - NO IMAGE

COLS: 1=quarter, 2=half, 3=three-quarter, 4=full

REMEMBER: Create VISUAL VARIETY. Never group same types. Alternate big/small cells. Add images to enhance understanding."""


# ============ CONTENT GENERATOR ============
CONTENT_SYSTEM_PROMPT = """Generate clean educational HTML content.

OUTPUT: <div class="kp-cell">...<style>...</style></div>. NO markdown.

CSS Variables: --kp-text, --kp-muted, --kp-primary, --kp-card, --kp-border

STYLES BY TYPE:

STAT: Center a large number (2.5rem), label below, subtle gradient bg
FACT: Bold title, 2-3 bullet points or short paragraph
COMPONENT: Emoji + title + 2-sentence description
SECTION: h2 title, 2-3 paragraphs, bold key terms
STEPS: Numbered steps with colored circles, title + explanation each
TIMELINE: Vertical line, year badges, events
PROS: Green ✓ items with brief text
CONS: Red ✗ items with brief text  
RESOURCE: Card with icon, action items

IMAGE INTEGRATION:
If an image URL is provided, integrate it naturally into the content:
- For SECTION/STEPS: Place image at top or alongside content with object-fit: cover
- For FACT: Small image thumbnail to the left or top
- For TIMELINE: Optional header image
- Use class="kp-cell-image" for the image wrapper
- Style: border-radius: 12px, max-height: 200px for sections, 120px for smaller cells
- Add subtle shadow and smooth loading transition

Keep it scannable, educational, well-spaced."""

CONTENT_WITH_IMAGE_TEMPLATE = """
IMAGE AVAILABLE: {image_url}
Include this image in the content using an <img> tag with:
- src="{image_url}"
- class="kp-cell-image" 
- loading="lazy"
- alt="[descriptive alt text]"
- Style appropriately for the cell type (see IMAGE INTEGRATION guidelines)
"""


# ============ API ENDPOINTS ============

@router.get("/explore/images", summary="Batch fetch images for queries", operation_id="batch_fetch_images")
async def batch_fetch_images(queries: str):
    """
    Fetch images for multiple queries in parallel.
    queries: comma-separated list of image search queries
    Returns: dict mapping query to list of image URLs
    """
    query_list = [q.strip() for q in queries.split(",") if q.strip()]
    if not query_list:
        return {"images": {}}
    
    logger.info(f"🖼️ Batch fetching images for {len(query_list)} queries")
    
    async def fetch_for_query(query: str):
        images = await search_images(query, num_results=2)
        return (query, images)
    
    results = await asyncio.gather(*[fetch_for_query(q) for q in query_list])
    image_map = {query: urls for query, urls in results}
    
    logger.info(f"✅ Fetched images for {len([v for v in image_map.values() if v])} queries")
    return {"images": image_map}


@router.get("/explore/{topic}", summary="Stream knowledge page", operation_id="explore_topic")
async def explore_topic(topic: str):
    """Stream structured layout XML. Cells with image_query attribute will fetch images on-demand."""
    logger.info(f"📋 Generating dynamic page for: {topic}")
    
    # Fetch a hero/fallback image for the page
    hero_images = await search_images(f"{topic} concept illustration", num_results=3)
    logger.info(f"🖼️ Found {len(hero_images)} hero images")
    
    messages = [
        {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
        {"role": "user", "content": f"Create a comprehensive, visually varied educational page about: {topic}\n\nRemember to add image_query attributes to 5-8 cells that would benefit from visual explanation."}
    ]

    try:
        llm_response = await llm.make_llm_api_call(
            messages=messages,
            model_name="groq/moonshotai/kimi-k2-instruct",
            temperature=0.8,  # Slightly higher for more variety
            max_tokens=2500,
            stream=True,
        )

        async def stream_generator():
            # Send hero images first (can be used as page header or fallbacks)
            yield f"data: {json.dumps({'type': 'hero_images', 'images': hero_images, 'count': len(hero_images)})}\n\n"
            try:
                async for chunk in llm_response:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        yield f"data: {json.dumps({'type': 'content', 'content': chunk.choices[0].delta.content})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
            except Exception as e:
                logger.error(f"Stream error: {e}")
                yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        logger.error(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/explore/content/{cell_id}", summary="Stream cell content", operation_id="generate_cell_content")
async def generate_cell_content(
    cell_id: str,
    title: str,
    description: str,
    type: str = "text",
    cols: str = "2",
    tokens: str = "300",
    topic: str = "",
    image_query: str = ""
):
    """Generate HTML content for a cell, optionally with an image + OCR context."""
    max_tokens = min(int(tokens), 1200) if tokens.isdigit() else 300
    
    # Fetch image with metadata if image_query is provided
    image_data = None
    image_url = None
    ocr_context = ""
    
    if image_query:
        logger.info(f"🔍 Fetching image for cell {cell_id}: {image_query}")
        images = await search_images(image_query, num_results=3, with_metadata=True)
        if images:
            image_data = images[0]  # ImageData object
            image_url = image_data.url
            logger.info(f"🖼️ Found image for {cell_id}: {image_url[:50]}... (aspect: {image_data.aspect_ratio})")
            
            # SUPER FAST OCR - extract text/context from image (optional)
            if ENABLE_IMAGE_OCR:
                logger.info(f"👁️ Running OCR for cell {cell_id}...")
                ocr_context = await extract_image_context(image_url, topic)
                if ocr_context:
                    image_data.ocr_text = ocr_context
                    logger.info(f"✅ OCR complete for {cell_id}: {len(ocr_context)} chars")
        else:
            logger.info(f"⚠️ No image found for {cell_id}")
    
    logger.info(f"🎨 Cell {cell_id}: {title} ({type}, {cols} cols, {max_tokens} tokens, image: {bool(image_url)}, ocr: {bool(ocr_context)})")

    type_instructions = {
        "stat": "Large centered number (2.5rem), label below, subtle gradient background.",
        "fact": "Bold title, 2-3 concise bullet points. Clean scannable format.",
        "component": "Emoji icon + bold title + 2-sentence description. Card style.",
        "section": "h2 title, 2-3 paragraphs with bold key terms. Educational depth.",
        "steps": "Numbered steps (Step 1, Step 2...) with colored circle numbers. Each: bold title + explanation. 5-7 steps.",
        "timeline": "Vertical timeline with year badges on left, event descriptions. 4-6 milestones.",
        "pros": "Green checkmarks (✓), 4-5 benefit items with brief text.",
        "cons": "Red x marks (✗), 4-5 limitation items with brief text.",
        "resource": "Card with emoji, title, 3-4 action items or resources.",
    }

    # Build user prompt with optional image + OCR context
    image_instruction = ""
    if image_url:
        image_instruction = CONTENT_WITH_IMAGE_TEMPLATE.format(image_url=image_url)
        if ocr_context:
            image_instruction += f"""
IMAGE CONTEXT (from OCR/vision scan):
{ocr_context}

Use this context to ensure your content MATCHES and COMPLEMENTS the image.
Reference specific elements, numbers, or labels from the image in your explanation."""

    user_prompt = f"""Create {type.upper()} content for "{topic}":
Title: {title}
Description: {description}
{image_instruction}
{type_instructions.get(type, "Create clear educational content.")}

Start with <div class="kp-cell">, include <style>, end with </div>."""

    messages = [
        {"role": "system", "content": CONTENT_SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt}
    ]

    try:
        llm_response = await llm.make_llm_api_call(
            messages=messages,
            model_name="groq/moonshotai/kimi-k2-instruct",
            temperature=0.7,
            max_tokens=max_tokens + (150 if image_url else 0),  # Extra tokens for image HTML
            stream=True,
        )

        async def stream_generator():
            # First, send image metadata with dimensions if we have one
            if image_data:
                yield f"data: {json.dumps({'type': 'image', 'cell_id': cell_id, **image_data.to_dict()})}\n\n"
            
            try:
                async for chunk in llm_response:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        yield f"data: {json.dumps({'type': 'content', 'content': chunk.choices[0].delta.content, 'cell_id': cell_id})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'cell_id': cell_id, 'has_image': bool(image_data)})}\n\n"
            except Exception as e:
                logger.error(f"Stream error {cell_id}: {e}")
                yield f"data: {json.dumps({'type': 'error', 'message': str(e), 'cell_id': cell_id})}\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        logger.error(f"Error cell {cell_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
