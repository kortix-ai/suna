from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from typing import List, Dict, Optional, Union
import json
import os
from datetime import datetime
import re
import asyncio
import httpx

@tool_metadata(
    display_name="Presentations",
    description="Create and manage stunning presentation slides",
    icon="Presentation",
    color="bg-orange-100 dark:bg-orange-800/50",
    weight=70,
    visible=True
)
class SandboxPresentationTool(SandboxToolsBase):
    """
    Per-slide HTML presentation tool for creating presentation slides.
    Each slide is created as a basic HTML document without predefined CSS styling.
    Users can include their own CSS styling inline or in style tags as needed.
    """
    
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.presentations_dir = "presentations"
        # Path to built-in templates (on the backend filesystem, not in sandbox)
        self.templates_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "templates", "presentations")


    async def _ensure_presentations_dir(self):
        """Ensure the presentations directory exists"""
        full_path = f"{self.workspace_path}/{self.presentations_dir}"
        try:
            await self.sandbox.fs.create_folder(full_path, "755")
        except:
            pass

    async def _ensure_presentation_dir(self, presentation_name: str):
        """Ensure a specific presentation directory exists"""
        safe_name = self._sanitize_filename(presentation_name)
        presentation_path = f"{self.workspace_path}/{self.presentations_dir}/{safe_name}"
        try:
            await self.sandbox.fs.create_folder(presentation_path, "755")
        except:
            pass
        return safe_name, presentation_path

    def _sanitize_filename(self, name: str) -> str:
        """Convert presentation name to safe filename"""
        return "".join(c for c in name if c.isalnum() or c in "-_").lower()


    def _create_slide_html(self, slide_content: str, slide_number: int, total_slides: int, presentation_title: str) -> str:
        """Create a basic HTML document without predefined CSS"""
        
        html_template = f"""<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>{presentation_title} - Slide {slide_number}</title>
                <script src="https://d3js.org/d3.v7.min.js"></script>
                <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" rel="stylesheet">
                <script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1"></script>
                <style>
                    body {{
                        height: 1080px;
                        width: 1920px;
                        margin: 0;
                        padding: 0;
                    }}
                </style>
            </head>
            <body>
                {slide_content}
            </body>
            </html>"""
        return html_template

    async def _load_presentation_metadata(self, presentation_path: str):
        """Load presentation metadata, create if doesn't exist"""
        metadata_path = f"{presentation_path}/metadata.json"
        try:
            metadata_content = await self.sandbox.fs.download_file(metadata_path)
            return json.loads(metadata_content.decode())
        except:
            # Create default metadata
            return {
                "presentation_name": "",
                "title": "Presentation", 
                "description": "",
                "slides": {},
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat()
            }

    async def _save_presentation_metadata(self, presentation_path: str, metadata: Dict):
        """Save presentation metadata"""
        metadata["updated_at"] = datetime.now().isoformat()
        metadata_path = f"{presentation_path}/metadata.json"
        await self.sandbox.fs.upload_file(json.dumps(metadata, indent=2).encode(), metadata_path)

    def _load_template_metadata(self, template_name: str) -> Dict:
        """Load metadata from a template on the backend filesystem"""
        metadata_path = os.path.join(self.templates_dir, template_name, "metadata.json")
        try:
            with open(metadata_path, 'r') as f:
                return json.load(f)
        except Exception as e:
            return {}

    def _read_template_slide(self, template_name: str, slide_filename: str) -> str:
        """Read a slide HTML file from a template"""
        slide_path = os.path.join(self.templates_dir, template_name, slide_filename)
        try:
            with open(slide_path, 'r') as f:
                return f.read()
        except Exception as e:
            return ""

    async def _copy_template_to_workspace(self, template_name: str, presentation_name: str) -> str:
        """Copy entire template directory structure to workspace using os.walk
        
        Returns:
            The presentation path in the workspace
        """
        await self._ensure_sandbox()
        await self._ensure_presentations_dir()
        
        template_path = os.path.join(self.templates_dir, template_name)
        safe_name = self._sanitize_filename(presentation_name)
        presentation_path = f"{self.workspace_path}/{self.presentations_dir}/{safe_name}"
        
        # Ensure presentation directory exists
        await self._ensure_presentation_dir(presentation_name)
        
        # Use os.walk to recursively copy all files
        copied_files = []
        for root, dirs, files in os.walk(template_path):
            # Calculate relative path from template root
            rel_path = os.path.relpath(root, template_path)
            
            # Create corresponding directory in workspace (if not root)
            if rel_path != '.':
                target_dir = os.path.join(presentation_path, rel_path)
                target_dir_path = target_dir.replace('\\', '/')  # Normalize path separators
                try:
                    await self.sandbox.fs.create_folder(target_dir_path, "755")
                except:
                    pass  # Directory might already exist
            else:
                target_dir_path = presentation_path
            
            # Copy all files
            for file in files:
                source_file = os.path.join(root, file)
                rel_file_path = os.path.relpath(source_file, template_path)
                target_file = os.path.join(presentation_path, rel_file_path).replace('\\', '/')
                
                try:
                    with open(source_file, 'rb') as f:
                        file_content = f.read()
                    await self.sandbox.fs.upload_file(file_content, target_file)
                    copied_files.append(rel_file_path)
                except Exception as e:
                    # Log error but continue with other files
                    print(f"Error copying {rel_file_path}: {str(e)}")
        
        # Update metadata.json with correct paths for the new presentation
        metadata = await self._load_presentation_metadata(presentation_path)
        template_metadata = self._load_template_metadata(template_name)
        
        # Update presentation name and preserve slides structure
        metadata["presentation_name"] = presentation_name
        metadata["title"] = template_metadata.get("title", presentation_name)
        metadata["description"] = template_metadata.get("description", "")
        metadata["created_at"] = datetime.now().isoformat()
        metadata["updated_at"] = datetime.now().isoformat()
        
        # Update slide paths to match new presentation name
        if "slides" in template_metadata:
            updated_slides = {}
            for slide_num, slide_data in template_metadata["slides"].items():
                slide_filename = slide_data.get("filename", f"slide_{int(slide_num):02d}.html")
                updated_slides[str(slide_num)] = {
                    "title": slide_data.get("title", f"Slide {slide_num}"),
                    "filename": slide_filename,
                    "file_path": f"{self.presentations_dir}/{safe_name}/{slide_filename}",
                    "preview_url": f"/workspace/{self.presentations_dir}/{safe_name}/{slide_filename}",
                    "created_at": datetime.now().isoformat()
                }
            metadata["slides"] = updated_slides
        
        # Save updated metadata
        await self._save_presentation_metadata(presentation_path, metadata)
        
        return presentation_path

    def _extract_style_from_html(self, html_content: str) -> Dict:
        """Extract CSS styles and design patterns from HTML content"""
        style_info = {
            "fonts": [],
            "colors": [],
            "layout_patterns": [],
            "key_css_classes": []
        }
        
        # Extract font imports
        font_imports = re.findall(r'@import url\([\'"]([^\'"]+)[\'"]', html_content)
        font_families = re.findall(r'font-family:\s*[\'"]?([^;\'"]+)[\'"]?', html_content)
        style_info["fonts"] = list(set(font_imports + font_families))
        
        # Extract color values (hex, rgb, rgba)
        hex_colors = re.findall(r'#[0-9A-Fa-f]{3,6}', html_content)
        rgb_colors = re.findall(r'rgba?\([^)]+\)', html_content)
        style_info["colors"] = list(set(hex_colors + rgb_colors))[:20]  # Limit to top 20
        
        # Extract class names
        class_names = re.findall(r'class=[\'"]([^\'"]+)[\'"]', html_content)
        style_info["key_css_classes"] = list(set(class_names))[:30]
        
        # Identify layout patterns
        if 'display: flex' in html_content or 'display:flex' in html_content:
            style_info["layout_patterns"].append("flexbox")
        if 'display: grid' in html_content or 'display:grid' in html_content:
            style_info["layout_patterns"].append("grid")
        if 'position: absolute' in html_content:
            style_info["layout_patterns"].append("absolute positioning")
        
        return style_info

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "load_presentation_instructions",
            "description": "REQUIRED FIRST STEP BEFORE CREATING A PRESENTATION: Load detailed presentation creation workflow and requirements. You MUST call this before creating any presentations to understand the 4-phase workflow, research requirements, image handling, and best practices.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def load_presentation_instructions(self) -> ToolResult:
        """Load detailed presentation creation workflow and requirements"""
        try:
            return self.success_response({
                "message": "Presentation creation workflow and requirements loaded successfully",
                "instructions": """
                ## PRESENTATION CREATION WORKFLOW

                **🔴 DEFAULT: CUSTOM THEME (ALWAYS USE UNLESS USER EXPLICITLY REQUESTS TEMPLATE) 🔴**

                Always create truly unique presentations with custom design systems based on the topic's actual brand colors and visual identity. Only use templates when user explicitly asks (e.g., "use a template", "show me templates").

                **FOLDER STRUCTURE:**
                ```
                presentations/
                └── [topic]/
                        └── (template structure - images are inside this folder)
                ```
                * When a template is loaded, it's copied to `presentations/[topic]/` folder
                * Images are already inside the template structure within `presentations/[topic]/` folder
                * Download any new images to the `presentations/[topic]/` folder structure (follow where the template stores its images)
                * Reference images using paths relative to the slide location based on where they are in the template structure

                **Custom Theme Workflow:**
                ```
                presentations/
                ├── images/              (shared images folder - used BEFORE presentation folder is created)
                │     └── image1.png
                └── [title]/             (created when first slide is made)
                        └── slide01.html
                ```
                * Images go to `presentations/images/` BEFORE the presentation folder exists
                * Reference images using `../images/[filename]` (go up one level from presentation folder)

                ### **CUSTOM THEME WORKFLOW** (DEFAULT)

                Follow this simplified, four-step workflow for every presentation. **DO NOT SKIP OR REORDER STEPS. YOU MUST COMPLETE EACH PHASE FULLY BEFORE MOVING TO THE NEXT.**

                **🚨 CRITICAL EXECUTION RULES:**
                - **NEVER start Phase 2 until Phase 1 is complete and user has confirmed**
                - **NEVER start Phase 3 until Phase 2 is complete**
                - **NEVER start Phase 4 (slide creation) until Phase 3 is 100% complete, including ALL image downloads**
                - **Each phase has a checkpoint - you must reach it before proceeding**

                ### **Phase 1: Topic Confirmation** 📋
                **⚠️ MANDATORY: Complete ALL steps in this phase before proceeding. DO NOT do any research or slide creation until user confirms.**

                1.  **Topic and Context Confirmation**: Ask the user about:
                    *   **Presentation topic/subject**
                    *   **Target audience**
                    *   **Presentation goals**
                    *   **Any specific requirements or preferences**
                2. **WAIT FOR USER CONFIRMATION**: Use the `ask` tool to present your questions and **explicitly wait for the user's response**. DO NOT proceed to Phase 2 until the user has provided all the requested information.

                **✅ CHECKPOINT: Only after receiving user confirmation with all topic details, proceed to Phase 2.**

                ### **Phase 2: Theme and Content Planning** 📝
                **⚠️ MANDATORY: Complete ALL steps in this phase before proceeding. DO NOT start Phase 3 until this phase is complete.**

                1.  **Initial Context Web Search**: Use `web_search` tool in BATCH MODE with multiple queries to get an initial idea of the topic context efficiently. This preliminary search helps understand the topic domain, industry, and general context, which will inform the theme declaration. **MANDATORY**: Use `web_search(query=["query1", "query2", "query3"])` format to execute multiple searches concurrently. **CRITICAL**: Search for specific brand colors, visual identity, and design elements associated with the actual topic. Use your research to autonomously determine what sources are relevant:
                - For companies/products: Search for their official website, brand guidelines, marketing materials, or visual identity documentation
                - For people: Search for their personal website, portfolio, professional profiles, or any publicly available visual identity - use your research to determine what platforms/sources are relevant for that person
                - For topics: Search for visual identity, brand colors, or design style associated with the topic
                - **MANDATORY**: You MUST search for actual brand colors/visual identity before choosing colors. Do NOT use generic color associations. Use your intelligence to determine what sources are most relevant for the specific topic.
                2. **Define Context-Based Custom Color Scheme and Design Elements**: Based on the research findings from your web searches, define the custom color palette, font families, typography, and layout patterns. **🚨 CRITICAL REQUIREMENTS - NO GENERIC COLORS ALLOWED**:
                - **USE ACTUAL TOPIC-SPECIFIC COLORS**: The color scheme MUST be based on the actual topic's brand colors, visual identity, or associated colors discovered in research, NOT generic color associations:
                    - **CORRECT APPROACH**: Research the actual topic's brand colors, visual identity, or design elements from official sources (website, brand guidelines, marketing materials, etc.) and use those specific colors discovered in research
                    - **WRONG APPROACH**: Using generic color associations like "blue for tech", "red for speed", "green for innovation", "purple-to-blue gradient for tech" without first checking what the actual topic's brand uses
                    - **For companies/products**: Use their actual brand colors from their official website, brand guidelines, or marketing materials discovered in research
                    - **For people**: Use your research to find their actual visual identity from relevant sources (website, portfolio, professional profiles, etc. - determine what's relevant based on the person's context)
                    - **For topics**: Use visual identity, brand colors, or design style associated with the topic discovered through research
                    - **Always verify first**: Never use generic industry color stereotypes without checking the actual topic's brand/visual identity
                - **🚨 ABSOLUTELY FORBIDDEN**: Do NOT use generic tech color schemes like "purple-to-blue gradient", "blue for tech", "green for innovation" unless your research specifically shows these are the topic's actual brand colors. Always verify first!
                - **Research-Driven**: If the topic has specific brand colors discovered in research, you MUST use those. If research shows no specific brand colors exist, only then use colors that are contextually associated with the topic based on your research findings, but EXPLAIN why those colors are contextually appropriate based on your research.
                - **No Generic Associations**: Avoid generic color meanings like "blue = tech", "red = speed", "green = growth", "purple-to-blue gradient = tech" unless your research specifically shows these colors are associated with the topic. These generic associations are FORBIDDEN.
                - **For People Specifically**: If researching a person, you MUST use your research to find their actual color scheme and visual identity from relevant sources. Determine what sources are appropriate based on the person's profession, field, and what you discover in research (could be website, portfolio, professional profiles, social media, etc. - decide based on context). Only if you cannot find any visual identity, then use colors contextually appropriate based on their field/work, but EXPLAIN the reasoning and what research you did.
                - **Match Visual Identity**: Font families, typography, and layout patterns should also align with the topic's actual visual identity if discoverable, or be contextually appropriate based on research
                - **Document Your Theme**: When defining the theme, you MUST document:
                    - Where you found the color information (specific URLs, portfolio link, brand website, etc.)
                    - If no specific colors were found, explain what research you did and why you chose the colors based on context
                    - Never use generic tech/industry color schemes without explicit research justification

                **✅ CHECKPOINT: Only after completing web search, searching for brand colors/visual identity, and defining the design system based on actual research findings, proceed to Phase 3. DO NOT proceed until you have searched for and found the actual brand colors/visual identity of the topic.**

                ### **Phase 3: Research and Content Planning** 📝
                **🚨 CRITICAL: This phase MUST be completed in FULL before any slide creation. DO NOT call `create_slide` tool until ALL steps below are complete.**
                **⚠️ MANDATORY: Complete ALL 7 steps in this phase, including ALL image downloads, before proceeding to Phase 4. DO NOT create any slides until ALL images are downloaded and verified.**
                **🚨 ABSOLUTELY FORBIDDEN: Do NOT skip steps 2-7 (content outline, image search, image download, verification). These are MANDATORY and cannot be skipped.**

                1.  **Main Research Phase**: Use `web_search` in BATCH MODE with multiple queries to thoroughly research the confirmed topic efficiently. **MANDATORY**: Use `web_search(query=["aspect1", "aspect2", "aspect3", "aspect4"])` format to execute all searches concurrently instead of sequentially. This dramatically speeds up research when investigating multiple aspects. Then use `web_scrape` to gather detailed information, facts, data, and insights that will be used in the presentation content. The more context you gather from concurrent batch searches, the better you can select appropriate images.

                2.  **Create a Content Outline** (MANDATORY - DO NOT SKIP): Develop a structured outline that maps out the content for each slide. Focus on one main idea per slide. Also decide if a slide needs any images or not, if yes what images will it need based on content. For each image needed, note the specific query that will be used to search for it. **CRITICAL**: Use your research context to create intelligent, context-aware image queries that are **TOPIC-SPECIFIC**, not generic:
                - **CORRECT APPROACH**: Always include the actual topic name, brand, product, person's name, or entity in your queries (e.g., "[actual topic name] [specific attribute]", "[actual brand] [specific element]", "[actual person name] [relevant context]", "[actual location] [specific feature]")
                - **WRONG APPROACH**: Generic category queries without the specific topic name (e.g., using "technology interface" instead of including the actual topic name, or "tropical destination" instead of including the actual location name)
                - **For companies/products**: Include the actual company/product name in queries (e.g., "[company name] [specific element]", "[product name] [specific feature]")
                - **For people**: ALWAYS include the person's full name in the query along with relevant context
                - **For topics/locations**: ALWAYS include the topic/location name in the query along with specific attributes
                - Match image queries to the EXACT topic being researched, not just the category
                - Use specific names, brands, products, people, locations you discovered in research
                - **Document which slide needs which image** - you'll need this mapping in Phase 4.
                3. **Smart Topic-Specific Image Search** (MANDATORY - DO NOT SKIP): Search for images using `image_search`. You can perform **multiple image searches** (either as separate calls or as batch arrays) based on your research context. **CRITICAL**: You MUST search for images before downloading. DO NOT skip this step. For each search:
                - **TOPIC-SPECIFIC IMAGES REQUIRED**: Images MUST be specific to the actual topic/subject being researched, NOT generic category images. Always include the specific topic name, brand, product, person's name, or entity in your queries:
                    - **CORRECT APPROACH**: Include the actual topic name, brand, product, person's name, or location in every query (e.g., "[actual topic name] [specific attribute]", "[actual brand] [specific element]", "[actual person name] [relevant context]", "[actual location] [specific feature]")
                    - **WRONG APPROACH**: Generic category queries without the specific topic name (e.g., using "technology interface" instead of including the actual topic name, or "tropical destination" instead of including the actual location name)
                - **For companies/products**: ALWAYS include the actual company/product name in every image query
                - **For people**: ALWAYS include the person's full name in every image query along with relevant context
                - **For topics/locations**: ALWAYS include the topic/location name in every image query along with specific attributes
                - Use context-aware queries based on your research that include the specific topic name/brand/product/person/location
                - Set `num_results=2` to get 2-3 relevant results per query for selection flexibility
                - You can search for images in batches (using arrays of topic-specific queries) OR perform individual searches if you need more control
                - **Be intelligent about image selection**: Use your research context to understand which images best match the slide content and presentation theme, but ALWAYS prioritize topic-specific images over generic ones
                4. **Extract and Select Topic-Specific Image URLs** (MANDATORY - DO NOT SKIP): From the `image_search` results, extract image URLs. For batch searches, results will be in format: `{{"batch_results": [{{"query": "...", "images": ["url1", "url2"]}}, ...]}}`. For single searches: `{{"query": "...", "images": ["url1", "url2"]}}`. **CRITICAL**: You MUST extract image URLs before downloading. **Select the most contextually appropriate image** from the results based on:
                - **TOPIC SPECIFICITY FIRST**: Does it show the actual topic/subject being researched or just a generic category? Always prefer images that directly show the specific topic, brand, product, person, or entity over generic category images
                - How well it matches the slide content and your research findings
                - How well it aligns with your research findings (specific names, brands, products discovered)
                - How well it fits the presentation theme and color scheme
                - Visual quality and relevance
                5. **Ensure Images Folder Exists** (MANDATORY - DO NOT SKIP): Before downloading, ensure the `presentations/images` folder exists by creating it if needed: `mkdir -p presentations/images`
                - **CRITICAL**: For custom theme workflow, images go to `presentations/images/` (shared folder outside presentation folder) because we download images BEFORE the presentation folder is created
                - This folder is at the same level as where the presentation folder will be created later

                6. **Batch Image Download with Descriptive Names** (MANDATORY - DO NOT SKIP): **🚨 CRITICAL**: You MUST download ALL images using wget before creating any slides. This step is MANDATORY. Download all images using wget, giving each image a descriptive filename based on its query. Use a single command that downloads all images with proper naming. Example approach:
                - Create a mapping of URL to filename based on the query (e.g., "technology_startup_logo.jpg", "team_collaboration.jpg")
                - Use wget with `-O` flag to specify the full output path: `wget "URL1" -O presentations/images/descriptive_name1.jpg && wget "URL2" -O presentations/images/descriptive_name2.jpg` (chain with `&&` for multiple downloads)
                - **CRITICAL**: Download to `presentations/images/` folder (not inside a presentation folder, since we don't know the presentation name yet)
                - **CRITICAL**: Use descriptive filenames that clearly identify the image's purpose (e.g., `slide1_intro_image.jpg`, `slide2_team_photo.jpg`) so you can reference them correctly in slides. Preserve or add appropriate file extensions (.jpg, .png, etc.) based on the image URL or content type.
                7. **Verify Downloaded Images** (MANDATORY - DO NOT SKIP): After downloading, verify all images exist by listing the `presentations/images` folder: `ls -lh presentations/images/`. Confirm all expected images are present and note their exact filenames. If any download failed, retry the download for that specific image. **CRITICAL**: Create a clear mapping of slide number → image filename for reference in Phase 4. **🚨 ABSOLUTELY FORBIDDEN**: Do NOT proceed to Phase 4 until you have verified all images exist.

                **🚨 MANDATORY VERIFICATION BEFORE PROCEEDING**: Before moving to Phase 4, you MUST:
                - List all downloaded images: `ls -lh presentations/images/`
                - Confirm every expected image file exists and is accessible
                - Document the exact filename of each downloaded image (e.g., `slide1_intro_image.jpg`, `slide2_tech_photo.png`)
                - Create a mapping: Slide 1 → `slide1_intro_image.jpg`, Slide 2 → `slide2_tech_photo.png`, etc.
                - **DO NOT proceed to Phase 4 if any images are missing or if you haven't verified the downloads**
                - **🚨 ABSOLUTELY FORBIDDEN**: Do NOT call `create_slide` until ALL images are downloaded and verified. Creating slides before images are ready is a critical error.

                **✅ CHECKPOINT: Only after completing ALL research, creating the outline, searching for images, downloading ALL images with wget, verifying they exist with `ls -lh presentations/images/`, and documenting the exact filenames, proceed to Phase 4. DO NOT start creating slides until this checkpoint is reached. DO NOT call `create_slide` tool until ALL images are downloaded and verified.**

                ### **Phase 4: Slide Creation** (USE AS MUCH IMAGES AS POSSIBLE)
                **🚨 ABSOLUTELY FORBIDDEN TO START THIS PHASE UNTIL PHASE 3 IS 100% COMPLETE**
                **⚠️ MANDATORY: You may ONLY start this phase after completing Phase 3 checkpoint. Before calling `create_slide`, you MUST verify:**
                - ✅ (1) Completed all research
                - ✅ (2) Created content outline with image requirements
                - ✅ (3) Searched for ALL images using topic-specific queries
                - ✅ (4) Downloaded ALL images using wget to `presentations/images/`
                - ✅ (5) Verified all images exist by running `ls -lh presentations/images/`
                - ✅ (6) Documented exact filenames and created slide → image mapping
                - **🚨 DO NOT call `create_slide` until ALL 6 steps above are complete**

                1.  **Create the Slide**: Create the slide using the `create_slide` tool. All styling MUST be derived from the **custom color scheme and design elements** defined in Phase 2. Use the custom color palette, fonts, and layout patterns consistently.
                2.  **Use Downloaded Images**: For each slide that requires images, **MANDATORY**: Use the images that were downloaded in Phase 3. **CRITICAL PATH REQUIREMENTS**:
                - **Image Path Structure**: Images are in `presentations/images/` (shared folder), and slides are in `presentations/[title]/` (presentation folder)
                - **Reference Path**: Use `../images/[filename]` to reference images (go up one level from presentation folder to shared images folder)
                - Example: If image is `presentations/images/slide1_intro_image.jpg` and slide is `presentations/[presentation-title]/slide_01.html`, use path: `../images/slide1_intro_image.jpg`
                - **CRITICAL REQUIREMENTS**:
                    - **DO NOT skip images** - if a slide outline specified images, they must be included in the slide HTML
                    - Use the exact filenames you verified in step 7 (e.g., `../images/slide1_intro_image.jpg`)
                    - Include images in `<img>` tags within your slide HTML content
                    - Ensure images are properly sized and positioned within the slide layout
                    - If an image doesn't appear, verify the filename matches exactly (including extension) and the path is correct (`../images/` not `images/`)

                ### **Final Phase: Final Presentation** 🎯

                1.  **Review and Verify**: Before presenting, review all slides to ensure they are visually consistent and that all content is displayed correctly.
                2.  **Deliver the Presentation**: Use the `complete` tool with the **first slide** (e.g., `presentations/[name]/slide_01.html`) attached to deliver the final, polished presentation to the user. **IMPORTANT**: Only attach the opening/first slide to keep the UI tidy - the presentation card will automatically appear and show the full presentation when any presentation slide file is attached. The UI will automatically detect presentation attachments and render them beautifully.
                """
            })
        except Exception as e:
            return self.fail_response(f"Failed to load presentation creation workflow and requirements: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_templates",
            "description": "List all available presentation templates. ** CRITICAL: ONLY USE WHEN USER EXPLICITLY REQUESTS TEMPLATES ** **WHEN TO USE**: Call this tool ONLY when the user explicitly asks for templates (e.g., 'use a template', 'show me templates', 'use the minimalist template', 'I want to use a template'). **WHEN TO SKIP**: Do NOT call this tool by default. The default workflow is CUSTOM THEME which creates truly unique designs. Do NOT call this tool if: (1) the user requests a presentation without mentioning templates (use custom theme instead), (2) the user explicitly requests a custom theme, or (3) the user wants a unique/original design. **IMPORTANT**: Templates are optional - only use when explicitly requested. The default is always a custom, unique design based on the topic's actual brand colors and visual identity.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def list_templates(self) -> ToolResult:
        """List all available presentation templates with metadata and images"""
        try:
            templates = []
            
            # Check if templates directory exists
            if not os.path.exists(self.templates_dir):
                return self.success_response({
                    "message": "No templates directory found",
                    "templates": []
                })
            
            # List all subdirectories in templates folder
            for item in os.listdir(self.templates_dir):
                template_path = os.path.join(self.templates_dir, item)
                if os.path.isdir(template_path) and not item.startswith('.'):
                    # Load metadata for this template
                    metadata = self._load_template_metadata(item)
                    
                    # Check if image.png exists
                    image_path = os.path.join(template_path, "image.png")
                    has_image = os.path.exists(image_path)
                    
                    template_info = {
                        "id": item,
                        "name": item,  # Use folder name directly
                        "has_image": has_image
                    }
                    templates.append(template_info)
            
            if not templates:
                return self.success_response({
                    "message": "No templates found",
                    "templates": []
                })
            
            # Sort templates by name
            templates.sort(key=lambda x: x["name"])
            
            return self.success_response({
                "message": f"Found {len(templates)} template(s)",
                "templates": templates,
                "note": "Use load_template_design with a template id to get the complete design reference. If you don't like any of these templates, you can choose a custom theme instead."
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to list templates: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "load_template_design",
            "description": "Load complete design reference from a presentation template including all slide HTML and extracted style patterns (colors, fonts, layouts). If presentation_name is provided, the entire template will be copied to /workspace/presentations/{presentation_name}/ so you can edit ONLY the text content using full_file_rewrite - you MUST preserve 100% of the CSS styling, colors, fonts, and HTML structure. The visual design must remain identical; only text/data should change. Otherwise, use this template as DESIGN INSPIRATION ONLY - study the visual styling, CSS patterns, and layout structure to create your own original slides with similar aesthetics but completely different content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "template_name": {
                        "type": "string",
                        "description": "Name of the template to load (e.g., 'textbook')"
                    },
                    "presentation_name": {
                        "type": "string",
                        "description": "Optional: Name for the presentation. If provided, the entire template will be copied to /workspace/presentations/{presentation_name}/ so you can edit the slides directly. All files from the template (including HTML slides, images, and subdirectories) will be copied."
                    }
                },
                "required": ["template_name"]
            }
        }
    })
    async def load_template_design(self, template_name: str, presentation_name: Optional[str] = None) -> ToolResult:
        """Load complete template design including all slides HTML and extracted style patterns.
        
        If presentation_name is provided, copies the entire template to workspace for editing.
        """
        try:
            template_path = os.path.join(self.templates_dir, template_name)
            
            if not os.path.exists(template_path):
                return self.fail_response(f"Template '{template_name}' not found")
            
            # If presentation_name is provided, copy template to workspace
            presentation_path = None
            if presentation_name:
                try:
                    presentation_path = await self._copy_template_to_workspace(template_name, presentation_name)
                except Exception as e:
                    return self.fail_response(f"Failed to copy template to workspace: {str(e)}")
            
            # Load template metadata
            metadata = self._load_template_metadata(template_name)
            
            if not metadata or "slides" not in metadata:
                return self.fail_response(f"Template '{template_name}' has no metadata or slides")
            
            # Extract all slides HTML
            slides = []
            all_fonts = set()
            all_colors = set()
            all_layout_patterns = set()
            all_css_classes = set()
            
            for slide_num, slide_data in sorted(metadata["slides"].items(), key=lambda x: int(x[0])):
                slide_filename = slide_data.get("filename", f"slide_{int(slide_num):02d}.html")
                html_content = self._read_template_slide(template_name, slide_filename)
                
                if html_content:
                    # Add slide info
                    slides.append({
                        "slide_number": int(slide_num),
                        "title": slide_data.get("title", f"Slide {slide_num}"),
                        "filename": slide_filename,
                        "html_content": html_content,
                        "html_length": len(html_content)
                    })
                    
                    # Extract style information from this slide
                    style_info = self._extract_style_from_html(html_content)
                    all_fonts.update(style_info["fonts"])
                    all_colors.update(style_info["colors"])
                    all_layout_patterns.update(style_info["layout_patterns"])
                    all_css_classes.update(style_info["key_css_classes"])
            
            if not slides:
                return self.fail_response(f"Could not load any slides from template '{template_name}'")
            
            # Build response
            response_data = {
                "template_name": template_name,
                "template_title": metadata.get("title", template_name),
                "description": metadata.get("description", ""),
                "total_slides": len(slides),
                "slides": slides,
                "design_system": {
                    "fonts": list(all_fonts)[:10],  # Top 10 fonts
                    "color_palette": list(all_colors)[:20],  # Top 20 colors
                    "layout_patterns": list(all_layout_patterns),
                    "common_css_classes": list(all_css_classes)[:30]  # Top 30 classes
                }
            }
            
            # Add workspace path info if template was copied
            if presentation_path:
                safe_name = self._sanitize_filename(presentation_name)
                response_data["presentation_path"] = f"{self.presentations_dir}/{safe_name}"
                response_data["presentation_name"] = presentation_name.lower()
                response_data["copied_to_workspace"] = True
                response_data["note"] = f"Template copied to /workspace/{self.presentations_dir}/{safe_name}/. **CRITICAL**: Use full_file_rewrite to edit slides. ONLY change text content - preserve ALL CSS, styling, colors, fonts, and HTML structure 100% exactly. The template's visual design must remain identical. This template provides ALL slides and extracted design patterns in one response."
                response_data["usage_instructions"] = {
                    "purpose": "TEMPLATE COPIED TO WORKSPACE - Edit ONLY the content, preserve ALL design/styling",
                    "do": [
                        "Use full_file_rewrite tool to edit the copied slide HTML files",
                        "ONLY modify text content inside HTML elements (headings, paragraphs, list items, data values)",
                        "Replace placeholder/example data with actual presentation content",
                        "Keep ALL <img>, <svg>, icon elements - only update src/alt attributes to point to your images",
                        "Keep the exact same number and type of elements (if template has 3 logo images, keep 3 <img> tags)",
                        "Preserve the content structure - if it's a list, keep it a list; if it's images, keep images"
                    ],
                    "dont": [
                        "NEVER modify <style> blocks or CSS styling - preserve them 100% exactly as-is",
                        "NEVER change class names, colors, fonts, gradients, or any design properties",
                        "NEVER change the HTML structure or layout patterns (flex, grid, positioning)",
                        "NEVER add/remove major structural elements (containers, sections, wrappers)",
                        "NEVER replace images with text - if template has <img> tags, keep them and only update src/alt",
                        "NEVER remove visual elements like images, icons, SVGs, or graphics - only update their content/sources",
                        "NEVER use create_slide tool - it's only for custom themes, NOT templates",
                        "NEVER change the visual design - colors, fonts, spacing, sizes must stay identical"
                    ]
                }
            else:
                response_data["copied_to_workspace"] = False
                response_data["usage_instructions"] = {
                    "purpose": "DESIGN REFERENCE ONLY - Use for visual inspiration",
                    "do": [
                        "Study the HTML structure and CSS styling patterns",
                        "Learn the layout techniques and visual hierarchy",
                        "Understand the color scheme and typography usage",
                        "Analyze how elements are positioned and styled",
                        "Create NEW slides with similar design but ORIGINAL content"
                    ],
                    "dont": [
                        "Copy template content directly",
                        "Use template text, data, or information",
                        "Duplicate slides without modification",
                        "Treat templates as final deliverables"
                    ]
                }
                response_data["note"] = "This template provides ALL slides and extracted design patterns in one response. Study the HTML and CSS to understand the design system, then create your own original slides with similar visual styling. To edit this template directly, provide a presentation_name parameter."
            
            return self.success_response(response_data)
            
        except Exception as e:
            return self.fail_response(f"Failed to load template design: {str(e)}")


    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_slide",
            "description": "Create or update a single slide in a presentation. **WHEN TO USE**: This tool is ONLY for custom theme presentations (when no template is selected). **WHEN TO SKIP**: Do NOT use this tool for template-based presentations - use `full_file_rewrite` instead to rewrite existing template slide files. Each slide is saved as a standalone HTML file with 1920x1080 dimensions (16:9 aspect ratio). Slides are automatically validated to ensure both width (≤1920px) and height (≤1080px) limits are met. Use `box-sizing: border-box` on containers with padding to prevent dimension overflow. **CRITICAL**: For custom theme presentations, you MUST have completed Phase 3 (research, content outline, image search, and ALL image downloads) before using this tool. All styling MUST be derived from the custom color scheme and design elements defined in Phase 2.",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation (creates folder if doesn't exist)"
                    },
                    "slide_number": {
                        "type": "integer",
                        "description": "Slide number (1-based). If slide exists, it will be updated."
                    },
                    "slide_title": {
                        "type": "string",
                        "description": "Title of this specific slide (for reference and navigation)"
                    },
                    "content": {
                        "type": "string",
                        "description": """HTML body content only (DO NOT include <!DOCTYPE>, <html>, <head>, or <body> tags - these are added automatically). Include your content with inline CSS or <style> blocks. Design for 1920x1080 resolution. D3.js, Font Awesome, and Chart.js are pre-loaded and available to use.
                        
                        **🚨 IMPORTANT - Pre-configured Body Styles**: The slide template ALREADY includes base body styling in the <head>:
                        ```
                        body {
                            height: 1080px;
                            width: 1920px;
                            margin: 0;
                            padding: 0;
                        }
                        ```
                        **DO NOT** add conflicting body styles (like `height: 100vh`, `margin`, or `padding` on body) in your content - this will override the fixed dimensions and cause validation failures. Style your content containers instead.
                        
                        ## 📐 **Critical Dimension Requirements**

                        ### **Strict Limits**
                        *   **Slide Size**: MUST fit within 1920px width × 1080px height
                        *   **Validation**: Slides are automatically validated - both width AND height must not exceed limits
                        *   **Box-Sizing**: ALWAYS use `box-sizing: border-box` on containers with padding/margin to prevent overflow
                        
                        ### **Common Overflow Issues**
                        *   **Body Style Conflicts**: NEVER add `body { height: 100vh }` or other body styles in your content - the template already sets `body { height: 1080px; width: 1920px }`. Adding conflicting styles will break dimensions!
                        *   **Padding/Margin**: With default `box-sizing: content-box`, padding adds to total dimensions
                        *   **Example Problem**: `width: 100%` (1920px) + `padding: 80px` = 2080px total (exceeds limit!)
                        *   **Solution**: Use `box-sizing: border-box` so padding is included in the width/height
                        *   **CRITICAL HEIGHT ISSUE**: Containers with `height: 100%` (1080px) + `padding: 50px` top/bottom WILL cause ~100px overflow during validation! The scrollHeight measurement includes all content rendering, and flex centering with padding can push total height beyond 1080px. Use `max-height: 1080px` and reduce padding to 40px or less, OR ensure your content + padding stays well under 1080px.
                        
                        ### **Dimensions & Spacing**
                        *   **Slide Size**: 1920x1080 pixels (16:9)
                        *   **Container Padding**: Maximum 40px on all edges (avoid 50px+ to prevent height overflow) - ALWAYS use `box-sizing: border-box`!
                        *   **Section Gaps**: 40-60px between major sections  
                        *   **Element Gaps**: 20-30px between related items
                        *   **List Spacing**: Use `gap: 25px` in flex/grid layouts
                        *   **Line Height**: 1.5-1.8 for readability

                        ### **Typography**
                        Use `font_family` from **Theme Object**:
                        *   **Titles**: 48-72px (bold)
                        *   **Subtitles**: 32-42px (semi-bold)  
                        *   **Headings**: 28-36px (semi-bold)
                        *   **Body**: 20-24px (normal)
                        *   **Small**: 16-18px (light)

                        ### **Color Usage**
                        Use ONLY **Theme Object** colors:
                        *   **Primary**: Backgrounds, main elements
                        *   **Secondary**: Subtle backgrounds
                        *   **Accent**: Highlights, CTAs
                        *   **Text**: All text content

                        ### **Layout Principles**
                        *   Focus on 1-2 main ideas per slide
                        *   Limit to 3-5 bullet points max
                        *   Use `overflow: hidden` on containers
                        *   Grid columns: Use `gap: 50-60px`
                        *   Embrace whitespace - don't fill every pixel
                        *   **CRITICAL**: Always use `box-sizing: border-box` on main containers to prevent dimension overflow
                        """
                    },
                    "presentation_title": {
                        "type": "string",
                        "description": "Main title of the presentation (used in HTML title and navigation)",
                        "default": "Presentation"
                    }
                },
                "required": ["presentation_name", "slide_number", "slide_title", "content"]
            }
        }
    })
    async def create_slide(
        self,
        presentation_name: str,
        slide_number: int,
        slide_title: str,
        content: str,
        presentation_title: str = "Presentation"
    ) -> ToolResult:
        """Create or update a single slide in a presentation"""
        try:
            await self._ensure_sandbox()
            await self._ensure_presentations_dir()
            
            # Validation
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            if slide_number < 1:
                return self.fail_response("Slide number must be 1 or greater.")
            
            if not slide_title:
                return self.fail_response("Slide title is required.")
            
            if not content:
                return self.fail_response("Slide content is required.")
            
            # Ensure presentation directory exists
            safe_name, presentation_path = await self._ensure_presentation_dir(presentation_name)
            
            # Load or create metadata
            metadata = await self._load_presentation_metadata(presentation_path)
            metadata["presentation_name"] = presentation_name
            if presentation_title != "Presentation":  # Only update if explicitly provided
                metadata["title"] = presentation_title
            
            # Create slide HTML
            slide_html = self._create_slide_html(
                slide_content=content,
                slide_number=slide_number,
                total_slides=0,  # Will be updated when regenerating navigation
                presentation_title=presentation_title
            )
            
            # Save slide file
            slide_filename = f"slide_{slide_number:02d}.html"
            slide_path = f"{presentation_path}/{slide_filename}"
            await self.sandbox.fs.upload_file(slide_html.encode(), slide_path)
            
            # Update metadata
            if "slides" not in metadata:
                metadata["slides"] = {}
            
            metadata["slides"][str(slide_number)] = {
                "title": slide_title,
                "filename": slide_filename,
                "file_path": f"{self.presentations_dir}/{safe_name}/{slide_filename}",
                "preview_url": f"/workspace/{self.presentations_dir}/{safe_name}/{slide_filename}",
                "created_at": datetime.now().isoformat()
            }
            
            # Save updated metadata
            await self._save_presentation_metadata(presentation_path, metadata)
            
            response_data = {
                "message": f"Slide {slide_number} '{slide_title}' created/updated successfully",
                "presentation_name": presentation_name,
                "presentation_path": f"{self.presentations_dir}/{safe_name}",
                "slide_number": slide_number,
                "slide_title": slide_title,
                "slide_file": f"{self.presentations_dir}/{safe_name}/{slide_filename}",
                "preview_url": f"/workspace/{self.presentations_dir}/{safe_name}/{slide_filename}",
                "total_slides": len(metadata["slides"]),
                "note": "Professional slide created with custom styling - designed for 1920x1080 resolution"
            }
            
            # Auto-validate slide dimensions
            try:
                validation_result = await self.validate_slide(presentation_name, slide_number)
                
                # Append validation message to response
                if validation_result.success and validation_result.output:
                    # output can be a dict or string
                    if isinstance(validation_result.output, dict):
                        validation_message = validation_result.output.get("message", "")
                        if validation_message:
                            response_data["message"] += f"\n\n{validation_message}"
                            response_data["validation"] = {
                                "passed": validation_result.output.get("validation_passed", False),
                                "content_height": validation_result.output.get("actual_content_height", 0)
                            }
                    elif isinstance(validation_result.output, str):
                        response_data["message"] += f"\n\n{validation_result.output}"
                elif not validation_result.success:
                    # If validation failed to run, append a warning
                    logger.warning(f"Slide validation failed to execute: {validation_result.output}")
                    response_data["message"] += f"\n\n⚠️ Note: Slide validation could not be completed."
                    
            except Exception as e:
                # Log the error but don't fail the slide creation
                logger.warning(f"Failed to auto-validate slide: {str(e)}")
                response_data["message"] += f"\n\n⚠️ Note: Slide validation could not be completed."
            
            return self.success_response(response_data)
            
        except Exception as e:
            return self.fail_response(f"Failed to create slide: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_slides",
            "description": "List all slides in a presentation, showing their titles and order",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation to list slides for"
                    }
                },
                "required": ["presentation_name"]
            }
        }
    })
    async def list_slides(self, presentation_name: str) -> ToolResult:
        """List all slides in a presentation"""
        try:
            await self._ensure_sandbox()
            
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            safe_name = self._sanitize_filename(presentation_name)
            presentation_path = f"{self.workspace_path}/{self.presentations_dir}/{safe_name}"
            
            # Load metadata
            metadata = await self._load_presentation_metadata(presentation_path)
            
            if not metadata.get("slides"):
                return self.success_response({
                    "message": f"No slides found in presentation '{presentation_name}'",
                    "presentation_name": presentation_name,
                    "slides": [],
                    "total_slides": 0
                })
            
            # Sort slides by number
            slides_info = []
            for slide_num_str, slide_data in metadata["slides"].items():
                slides_info.append({
                    "slide_number": int(slide_num_str),
                    "title": slide_data["title"],
                    "filename": slide_data["filename"],
                    "preview_url": slide_data["preview_url"],
                    "created_at": slide_data.get("created_at", "Unknown")
                })
            
            slides_info.sort(key=lambda x: x["slide_number"])
            
            return self.success_response({
                "message": f"Found {len(slides_info)} slides in presentation '{presentation_name}'",
                "presentation_name": presentation_name,
                "presentation_title": metadata.get("title", "Presentation"),
                "slides": slides_info,
                "total_slides": len(slides_info),
                "presentation_path": f"{self.presentations_dir}/{safe_name}"
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to list slides: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_slide",
            "description": "Delete a specific slide from a presentation",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation"
                    },
                    "slide_number": {
                        "type": "integer",
                        "description": "Slide number to delete (1-based)"
                    }
                },
                "required": ["presentation_name", "slide_number"]
            }
        }
    })
    async def delete_slide(self, presentation_name: str, slide_number: int) -> ToolResult:
        """Delete a specific slide from a presentation"""
        try:
            await self._ensure_sandbox()
            
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            if slide_number < 1:
                return self.fail_response("Slide number must be 1 or greater.")
            
            safe_name = self._sanitize_filename(presentation_name)
            presentation_path = f"{self.workspace_path}/{self.presentations_dir}/{safe_name}"
            
            # Load metadata
            metadata = await self._load_presentation_metadata(presentation_path)
            
            if not metadata.get("slides") or str(slide_number) not in metadata["slides"]:
                return self.fail_response(f"Slide {slide_number} not found in presentation '{presentation_name}'")
            
            # Get slide info before deletion
            slide_info = metadata["slides"][str(slide_number)]
            slide_filename = slide_info["filename"]
            
            # Delete slide file
            slide_path = f"{presentation_path}/{slide_filename}"
            try:
                await self.sandbox.fs.delete_file(slide_path)
            except:
                pass  # File might not exist
            
            # Remove from metadata
            del metadata["slides"][str(slide_number)]
            
            # Save updated metadata
            await self._save_presentation_metadata(presentation_path, metadata)
            
            return self.success_response({
                "message": f"Slide {slide_number} '{slide_info['title']}' deleted successfully",
                "presentation_name": presentation_name,
                "deleted_slide": slide_number,
                "deleted_title": slide_info['title'],
                "remaining_slides": len(metadata["slides"])
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to delete slide: {str(e)}")




    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_presentations",
            "description": "List all available presentations in the workspace",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def list_presentations(self) -> ToolResult:
        """List all presentations in the workspace"""
        try:
            await self._ensure_sandbox()
            presentations_path = f"{self.workspace_path}/{self.presentations_dir}"
            
            try:
                files = await self.sandbox.fs.list_files(presentations_path)
                presentations = []
                
                for file_info in files:
                    if file_info.is_directory:
                        metadata = await self._load_presentation_metadata(f"{presentations_path}/{file_info.name}")
                        presentations.append({
                            "folder": file_info.name,
                            "title": metadata.get("title", "Unknown Title"),
                            "description": metadata.get("description", ""),
                            "total_slides": len(metadata.get("slides", {})),
                            "created_at": metadata.get("created_at", "Unknown"),
                            "updated_at": metadata.get("updated_at", "Unknown")
                        })
                
                return self.success_response({
                    "message": f"Found {len(presentations)} presentations",
                    "presentations": presentations,
                    "presentations_directory": f"/workspace/{self.presentations_dir}"
                })
                
            except Exception as e:
                return self.success_response({
                    "message": "No presentations found",
                    "presentations": [],
                    "presentations_directory": f"/workspace/{self.presentations_dir}",
                    "note": "Create your first slide using create_slide"
                })
                
        except Exception as e:
            return self.fail_response(f"Failed to list presentations: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_presentation",
            "description": "Delete an entire presentation and all its files",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation to delete"
                    }
                },
                "required": ["presentation_name"]
            }
        }
    })
    async def delete_presentation(self, presentation_name: str) -> ToolResult:
        """Delete a presentation and all its files"""
        try:
            await self._ensure_sandbox()
            
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            safe_name = self._sanitize_filename(presentation_name)
            presentation_path = f"{self.workspace_path}/{self.presentations_dir}/{safe_name}"
            
            try:
                await self.sandbox.fs.delete_folder(presentation_path)
                return self.success_response({
                    "message": f"Presentation '{presentation_name}' deleted successfully",
                    "deleted_path": f"{self.presentations_dir}/{safe_name}"
                })
            except Exception as e:
                return self.fail_response(f"Presentation '{presentation_name}' not found or could not be deleted: {str(e)}")
                
        except Exception as e:
            return self.fail_response(f"Failed to delete presentation: {str(e)}")


    @openapi_schema({
        "type": "function",
        "function": {
            "name": "validate_slide",
            "description": "Validate a slide by reading its HTML code and checking if the content height exceeds 1080px. Use this tool to ensure slides fit within the standard presentation dimensions before finalizing them. This helps maintain proper slide formatting and prevents content overflow issues.",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation containing the slide to validate"
                    },
                    "slide_number": {
                        "type": "integer",
                        "description": "Slide number to validate (1-based)"
                    }
                },
                "required": ["presentation_name", "slide_number"]
            }
        }
    })
    async def validate_slide(self, presentation_name: str, slide_number: int) -> ToolResult:
        """Validate a slide by rendering it in a browser and measuring actual content height"""
        try:
            await self._ensure_sandbox()
            
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            if slide_number < 1:
                return self.fail_response("Slide number must be 1 or greater.")
            
            safe_name = self._sanitize_filename(presentation_name)
            presentation_path = f"{self.workspace_path}/{self.presentations_dir}/{safe_name}"
            
            # Load metadata to verify slide exists
            metadata = await self._load_presentation_metadata(presentation_path)
            
            if not metadata.get("slides") or str(slide_number) not in metadata["slides"]:
                return self.fail_response(f"Slide {slide_number} not found in presentation '{presentation_name}'")
            
            # Get slide info
            slide_info = metadata["slides"][str(slide_number)]
            slide_filename = slide_info["filename"]
            
            # Create a Python script to measure the actual rendered height using Playwright
            measurement_script = f'''
import asyncio
import json
from playwright.async_api import async_playwright

async def measure_slide_height():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox']
        )
        page = await browser.new_page(viewport={{"width": 1920, "height": 1080}})
        
        # Load the HTML file
        await page.goto('file:///workspace/{self.presentations_dir}/{safe_name}/{slide_filename}')
        
        # Wait for page to load
        await page.wait_for_load_state('networkidle')
        
        # Measure the actual content height
        dimensions = await page.evaluate("""
            () => {{
                const body = document.body;
                const html = document.documentElement;
                
                // Get the actual scroll height (total content height)
                const scrollHeight = Math.max(
                    body.scrollHeight, body.offsetHeight,
                    html.clientHeight, html.scrollHeight, html.offsetHeight
                );
                
                // Get viewport height
                const viewportHeight = window.innerHeight;
                
                // Check if content overflows
                const overflows = scrollHeight > 1080;
                
                return {{
                    scrollHeight: scrollHeight,
                    viewportHeight: viewportHeight,
                    overflows: overflows,
                    excessHeight: scrollHeight - 1080
                }};
            }}
        """)
        
        await browser.close()
        return dimensions

result = asyncio.run(measure_slide_height())
print(json.dumps(result))
'''
            
            # Write the script to a temporary file in the sandbox
            script_path = f"{self.workspace_path}/.validate_slide_temp.py"
            await self.sandbox.fs.upload_file(measurement_script.encode(), script_path)
            
            # Execute the script
            try:
                result = await self.sandbox.process.exec(
                    f"/bin/sh -c 'cd /workspace && python3 .validate_slide_temp.py'",
                    timeout=30
                )
                
                # Parse the result
                output = (getattr(result, "result", None) or getattr(result, "output", "") or "").strip()
                if not output:
                    raise Exception("No output from validation script")
                
                dimensions = json.loads(output)
                
                # Clean up the temporary script
                try:
                    await self.sandbox.fs.delete_file(script_path)
                except:
                    pass
                
            except Exception as e:
                # Clean up on error
                try:
                    await self.sandbox.fs.delete_file(script_path)
                except:
                    pass
                return self.fail_response(f"Failed to measure slide dimensions: {str(e)}")
            
            # Analyze results - simple pass/fail
            validation_passed = not dimensions["overflows"]
            
            validation_results = {
                "presentation_name": presentation_name,
                "presentation_path": presentation_path,
                "slide_number": slide_number,
                "slide_title": slide_info["title"],
                "actual_content_height": dimensions["scrollHeight"],
                "target_height": 1080,
                "validation_passed": validation_passed
            }
            
            # Add pass/fail message
            if validation_passed:
                validation_results["message"] = f"✓ Slide {slide_number} '{slide_info['title']}' validation passed. Content height: {dimensions['scrollHeight']}px"
            else:
                validation_results["message"] = f"✗ Slide {slide_number} '{slide_info['title']}' validation failed. Content height: {dimensions['scrollHeight']}px exceeds 1080px limit by {dimensions['excessHeight']}px"
                validation_results["excess_height"] = dimensions["excessHeight"]
            
            return self.success_response(validation_results)
            
        except Exception as e:
            return self.fail_response(f"Failed to validate slide: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "export_to_pptx",
            "description": "Export a presentation to PPTX format. The PPTX file can be stored locally in the sandbox for repeated downloads, or returned directly. Use store_locally=True to enable the download button in the UI for repeated downloads.",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation to export"
                    },
                    "store_locally": {
                        "type": "boolean",
                        "description": "If True, stores the PPTX file in the sandbox at /workspace/presentations/{presentation_name}/{presentation_name}.pptx for repeated downloads. If False, returns the file content directly without storing.",
                        "default": True
                    }
                },
                "required": ["presentation_name"]
            }
        }
    })
    async def export_to_pptx(self, presentation_name: str, store_locally: bool = True) -> ToolResult:
        """Export presentation to PPTX format via sandbox conversion service"""
        try:
            await self._ensure_sandbox()
            
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            safe_name = self._sanitize_filename(presentation_name)
            presentation_path = f"/workspace/{self.presentations_dir}/{safe_name}"
            
            # Verify presentation exists
            metadata = await self._load_presentation_metadata(presentation_path)
            if not metadata.get("slides"):
                return self.fail_response(f"Presentation '{presentation_name}' not found or has no slides")
            
            # Call sandbox conversion endpoint
            async with httpx.AsyncClient(timeout=120.0) as client:
                convert_response = await client.post(
                    f"{self.sandbox_url}/presentation/convert-to-pptx",
                    json={
                        "presentation_path": presentation_path,
                        "download": not store_locally
                    }
                )
                
                if not convert_response.is_success:
                    error_detail = convert_response.json().get("detail", "Unknown error") if convert_response.headers.get("content-type", "").startswith("application/json") else convert_response.text
                    return self.fail_response(f"PPTX conversion failed: {error_detail}")
                
                if store_locally:
                    # Response is JSON with download URL
                    result = convert_response.json()
                    pptx_filename = result.get("filename")
                    
                    # File is already stored in /workspace/downloads/ by the conversion service
                    # Optionally copy to presentation directory for organization
                    downloads_path = f"/workspace/downloads/{pptx_filename}"
                    presentation_pptx_path = f"{presentation_path}/{safe_name}.pptx"
                    
                    try:
                        # Copy to presentation directory as well for easy access
                        pptx_content = await self.sandbox.fs.download_file(downloads_path)
                        await self.sandbox.fs.upload_file(pptx_content, presentation_pptx_path)
                    except Exception as e:
                        # If copy fails, file is still available in downloads, so continue
                        pass
                    
                    return self.success_response({
                        "message": f"Presentation '{presentation_name}' exported to PPTX successfully",
                        "presentation_name": presentation_name,
                        "pptx_file": f"{self.presentations_dir}/{safe_name}/{safe_name}.pptx",
                        "download_url": f"/workspace/downloads/{pptx_filename}",
                        "total_slides": result.get("total_slides"),
                        "stored_locally": True,
                        "note": "PPTX file is stored in /workspace/downloads/ and can be downloaded repeatedly"
                    })
                else:
                    # Response is the PPTX file content directly
                    pptx_content = convert_response.content
                    filename = f"{safe_name}.pptx"
                    
                    # Extract filename from Content-Disposition if available
                    content_disposition = convert_response.headers.get("Content-Disposition", "")
                    if "filename=" in content_disposition:
                        filename = content_disposition.split('filename="')[1].split('"')[0]
                    
                    return self.success_response({
                        "message": f"Presentation '{presentation_name}' exported to PPTX successfully",
                        "presentation_name": presentation_name,
                        "filename": filename,
                        "file_size": len(pptx_content),
                        "stored_locally": False,
                        "note": "PPTX file content returned directly (not stored in sandbox)"
                    })
        
        except Exception as e:
            return self.fail_response(f"Failed to export presentation to PPTX: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "export_to_pdf",
            "description": "Export a presentation to PDF format. The PDF file can be stored locally in the sandbox for repeated downloads, or returned directly. Use store_locally=True to enable the download button in the UI for repeated downloads.",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation to export"
                    },
                    "store_locally": {
                        "type": "boolean",
                        "description": "If True, stores the PDF file in the sandbox at /workspace/downloads/ for repeated downloads. If False, returns the file content directly without storing.",
                        "default": True
                    }
                },
                "required": ["presentation_name"]
            }
        }
    })
    async def export_to_pdf(self, presentation_name: str, store_locally: bool = True) -> ToolResult:
        """Export presentation to PDF format via sandbox conversion service"""
        try:
            await self._ensure_sandbox()
            
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            safe_name = self._sanitize_filename(presentation_name)
            presentation_path = f"/workspace/{self.presentations_dir}/{safe_name}"
            
            # Verify presentation exists
            metadata = await self._load_presentation_metadata(presentation_path)
            if not metadata.get("slides"):
                return self.fail_response(f"Presentation '{presentation_name}' not found or has no slides")
            
            # Call sandbox conversion endpoint
            async with httpx.AsyncClient(timeout=120.0) as client:
                convert_response = await client.post(
                    f"{self.sandbox_url}/presentation/convert-to-pdf",
                    json={
                        "presentation_path": presentation_path,
                        "download": not store_locally
                    }
                )
                
                if not convert_response.is_success:
                    error_detail = convert_response.json().get("detail", "Unknown error") if convert_response.headers.get("content-type", "").startswith("application/json") else convert_response.text
                    return self.fail_response(f"PDF conversion failed: {error_detail}")
                
                if store_locally:
                    # Response is JSON with download URL
                    result = convert_response.json()
                    pdf_filename = result.get("filename")
                    
                    # File is already stored in /workspace/downloads/ by the conversion service
                    # Optionally copy to presentation directory for organization
                    downloads_path = f"/workspace/downloads/{pdf_filename}"
                    presentation_pdf_path = f"{presentation_path}/{safe_name}.pdf"
                    
                    try:
                        # Copy to presentation directory as well for easy access
                        pdf_content = await self.sandbox.fs.download_file(downloads_path)
                        await self.sandbox.fs.upload_file(pdf_content, presentation_pdf_path)
                    except Exception as e:
                        # If copy fails, file is still available in downloads, so continue
                        pass
                    
                    return self.success_response({
                        "message": f"Presentation '{presentation_name}' exported to PDF successfully",
                        "presentation_name": presentation_name,
                        "pdf_file": f"{self.presentations_dir}/{safe_name}/{safe_name}.pdf",
                        "download_url": f"/workspace/downloads/{pdf_filename}",
                        "total_slides": result.get("total_slides"),
                        "stored_locally": True,
                        "note": "PDF file is stored in /workspace/downloads/ and can be downloaded repeatedly"
                    })
                else:
                    # Response is the PDF file content directly
                    pdf_content = convert_response.content
                    filename = f"{safe_name}.pdf"
                    
                    # Extract filename from Content-Disposition if available
                    content_disposition = convert_response.headers.get("Content-Disposition", "")
                    if "filename=" in content_disposition:
                        filename = content_disposition.split('filename="')[1].split('"')[0]
                    
                    return self.success_response({
                        "message": f"Presentation '{presentation_name}' exported to PDF successfully",
                        "presentation_name": presentation_name,
                        "filename": filename,
                        "file_size": len(pdf_content),
                        "stored_locally": False,
                        "note": "PDF file content returned directly (not stored in sandbox)"
                    })
        
        except Exception as e:
            return self.fail_response(f"Failed to export presentation to PDF: {str(e)}")
