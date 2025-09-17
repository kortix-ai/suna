from typing import Optional
from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
import httpx
from io import BytesIO
import uuid
from litellm import aimage_generation, aimage_edit
import base64


class SandboxDesignerTool(SandboxToolsBase):
    def __init__(self, project_id: str, thread_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        self.thread_manager = thread_manager
        self.designs_dir = "/workspace/designs"
        
    async def _ensure_designs_directory(self):
        await self._ensure_sandbox()
        try:
            await self.sandbox.fs.make_dir(self.designs_dir)
        except:
            pass

    @openapi_schema(
        {
            "type": "function",
            "function": {
                "name": "designer_create_or_edit",
                "description": "Professional design tool for creating or editing high-quality graphics, UI designs, logos, mockups, and other visual assets. Features flexible dimensions and enhanced design capabilities.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "mode": {
                            "type": "string",
                            "enum": ["create", "edit"],
                            "description": "'create' for new designs from scratch, 'edit' to modify existing designs.",
                        },
                        "prompt": {
                            "type": "string",
                            "description": "Professional design prompt. Be specific about style, composition, colors, typography, and design elements. This tool excels at: UI/UX designs, logos, marketing materials, mockups, icons, illustrations, and professional graphics.",
                        },
                        "width": {
                            "type": "integer",
                            "description": "Design width in pixels. Common sizes: 1920 (HD), 1080 (square), 800 (social), 400 (icon). Default: 1024",
                            "minimum": 256,
                            "maximum": 4096,
                        },
                        "height": {
                            "type": "integer",
                            "description": "Design height in pixels. Common sizes: 1080 (HD), 1080 (square), 600 (social), 400 (icon). Default: 1024",
                            "minimum": 256,
                            "maximum": 4096,
                        },
                        "design_style": {
                            "type": "string",
                            "enum": ["modern", "minimalist", "material", "glassmorphism", "neomorphism", "flat", "skeuomorphic", "organic", "geometric", "abstract", "professional", "playful"],
                            "description": "Optional design style preset to enhance the prompt. Helps achieve consistent professional results.",
                        },
                        "image_path": {
                            "type": "string",
                            "description": "(edit mode only) Path to the design file to edit. Supports workspace files or URLs.",
                        },
                        "quality": {
                            "type": "string",
                            "enum": ["standard", "hd"],
                            "description": "Output quality. 'hd' for highest quality (recommended for final designs). Default: 'standard'",
                        },
                    },
                    "required": ["mode", "prompt"],
                },
            },
        }
    )
    @usage_example("""
        Create a modern UI mockup:
        <function_calls>
        <invoke name="designer_create_or_edit">
        <parameter name="mode">create</parameter>
        <parameter name="prompt">Modern dashboard UI design with dark theme, featuring analytics cards with graphs, sidebar navigation with icons, clean typography using Inter font, purple accent colors, subtle shadows, and glassmorphism effects</parameter>
        <parameter name="width">1920</parameter>
        <parameter name="height">1080</parameter>
        <parameter name="design_style">glassmorphism</parameter>
        <parameter name="quality">hd</parameter>
        </invoke>
        </function_calls>
        
        Create a professional logo:
        <function_calls>
        <invoke name="designer_create_or_edit">
        <parameter name="mode">create</parameter>
        <parameter name="prompt">Minimalist tech company logo, abstract geometric shapes forming a letter 'A', gradient from deep blue to electric purple, clean lines, scalable vector style, white background, professional and modern</parameter>
        <parameter name="width">800</parameter>
        <parameter name="height">800</parameter>
        <parameter name="design_style">minimalist</parameter>
        <parameter name="quality">hd</parameter>
        </invoke>
        </function_calls>
        
        Edit existing design:
        <function_calls>
        <invoke name="designer_create_or_edit">
        <parameter name="mode">edit</parameter>
        <parameter name="prompt">Add floating 3D elements around the main content, enhance with soft ambient lighting, add subtle particle effects, increase color vibrancy, make it more dynamic and eye-catching</parameter>
        <parameter name="image_path">design_draft_v1.png</parameter>
        <parameter name="design_style">modern</parameter>
        </invoke>
        </function_calls>
        
        Create social media banner:
        <function_calls>
        <invoke name="designer_create_or_edit">
        <parameter name="mode">create</parameter>
        <parameter name="prompt">Professional LinkedIn banner for software developer, abstract code patterns in background, subtle blue gradient, 'Building the Future' text in bold modern typography, tech-inspired geometric patterns, clean and sophisticated</parameter>
        <parameter name="width">1584</parameter>
        <parameter name="height">396</parameter>
        <parameter name="design_style">professional</parameter>
        <parameter name="quality">hd</parameter>
        </invoke>
        </function_calls>
        """)
    async def designer_create_or_edit(
        self,
        mode: str,
        prompt: str,
        width: int = 1024,
        height: int = 1024,
        design_style: Optional[str] = None,
        image_path: Optional[str] = None,
        quality: str = "standard",
    ) -> ToolResult:
        """Create or edit professional designs with flexible dimensions."""
        try:
            await self._ensure_designs_directory()

            enhanced_prompt = self._enhance_design_prompt(prompt, design_style)
            
            size_string = self._get_size_string(width, height)

            if mode == "create":
                response = await aimage_generation(
                    model="gpt-image-1",
                    prompt=enhanced_prompt,
                    n=1,
                    size=size_string,
                    quality=quality,
                )
            elif mode == "edit":
                if not image_path:
                    return self.fail_response("'image_path' is required for edit mode.")

                image_bytes = await self._get_image_bytes(image_path)
                if isinstance(image_bytes, ToolResult):  
                    return image_bytes

                image_io = BytesIO(image_bytes)
                image_io.name = "design.png"

                response = await aimage_edit(
                    image=[image_io],  
                    prompt=enhanced_prompt,
                    model="gpt-image-1",
                    n=1,
                    size=size_string,
                )
            else:
                return self.fail_response("Invalid mode. Use 'create' or 'edit'.")

            design_path = await self._process_design_response(response, width, height)
            if isinstance(design_path, ToolResult):  
                return design_path

            dimensions_text = f"{width}x{height}px"
            style_text = f" in {design_style} style" if design_style else ""
            
            await self._ensure_sandbox()
            
            return self.success_response({
                "success": True,
                "design_path": design_path,
                "sandbox_id": self.sandbox_id,
                "dimensions": {"width": width, "height": height},
                "style": design_style,
                "quality": quality,
                "message": f"Successfully created professional design ({dimensions_text}){style_text}. Design saved at: {design_path}"
            })

        except Exception as e:
            return self.fail_response(
                f"An error occurred during design creation/editing: {str(e)}"
            )

    def _enhance_design_prompt(self, prompt: str, design_style: Optional[str] = None) -> str:
        style_enhancements = {
            "modern": "with contemporary aesthetics, clean lines, bold typography, and current design trends",
            "minimalist": "with minimal elements, plenty of whitespace, simple color palette, and focus on essential components",
            "material": "following Material Design principles, with proper elevation, shadows, and material surfaces",
            "glassmorphism": "with frosted glass effect, transparency, vivid colors behind glass, and subtle borders",
            "neomorphism": "with soft UI elements, subtle shadows and highlights, creating a soft extruded plastic look",
            "flat": "with flat design principles, no shadows or gradients, bold colors, and simple shapes",
            "skeuomorphic": "with realistic textures, shadows, and three-dimensional appearance mimicking real objects",
            "organic": "with natural flowing shapes, soft curves, nature-inspired elements, and organic forms",
            "geometric": "with strong geometric shapes, patterns, precise angles, and mathematical precision",
            "abstract": "with abstract artistic elements, unconventional compositions, and creative interpretations",
            "professional": "with corporate aesthetics, business-appropriate design, polished and refined appearance",
            "playful": "with fun, vibrant elements, playful typography, bright colors, and whimsical design",
        }
        
        base_enhancement = "Professional high-quality design: "
        enhanced = base_enhancement + prompt
        
        if design_style and design_style in style_enhancements:
            enhanced += f", {style_enhancements[design_style]}"
        
        enhanced += ". Ensure professional quality, proper composition, visual hierarchy, and attention to detail."
        
        return enhanced

    def _get_size_string(self, width: int, height: int) -> str:
        allowed_sizes = [
            (1024, 1024),
            (1024, 1792),
            (1792, 1024),
        ]
        
        for allowed_w, allowed_h in allowed_sizes:
            if width == allowed_w and height == allowed_h:
                return f"{width}x{height}"
        
        ratio = width / height
        
        if ratio > 1.5:  
            return "1792x1024"
        elif ratio < 0.66:  
            return "1024x1792"
        else:  
            return "1024x1024"

    async def _get_image_bytes(self, image_path: str) -> bytes | ToolResult:
        if image_path.startswith(("http://", "https://")):
            return await self._download_image_from_url(image_path)
        else:
            return await self._read_image_from_sandbox(image_path)

    async def _download_image_from_url(self, url: str) -> bytes | ToolResult:
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(url)
                response.raise_for_status()
                return response.content
        except Exception:
            return self.fail_response(f"Could not download design from URL: {url}")

    async def _read_image_from_sandbox(self, image_path: str) -> bytes | ToolResult:
        try:
            cleaned_path = self.clean_path(image_path)
            full_path = f"{self.workspace_path}/{cleaned_path}"

            file_info = await self.sandbox.fs.get_file_info(full_path)
            if file_info.is_dir:
                return self.fail_response(
                    f"Path '{cleaned_path}' is a directory, not a design file."
                )

            return await self.sandbox.fs.download_file(full_path)

        except Exception as e:
            return self.fail_response(
                f"Could not read design file from sandbox: {image_path} - {str(e)}"
            )

    async def _process_design_response(self, response, width: int, height: int) -> str | ToolResult:
        try:
            original_b64_str = response.data[0].b64_json
            image_data = base64.b64decode(original_b64_str)

            random_filename = f"design_{width}x{height}_{uuid.uuid4().hex[:8]}.png"
            full_path = f"{self.designs_dir}/{random_filename}"

            await self.sandbox.fs.upload_file(image_data, full_path)
            
            return full_path

        except Exception as e:
            return self.fail_response(f"Failed to save design: {str(e)}") 