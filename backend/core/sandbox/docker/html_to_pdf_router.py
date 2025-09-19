#!/usr/bin/env python3
"""
FastAPI HTML Presentation to PDF Converter Router

Provides PDF conversion endpoints as a FastAPI router that can be included in other applications.
"""

import json
import asyncio
from pathlib import Path
from typing import Dict, List
import tempfile

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

try:
    from playwright.async_api import async_playwright
except ImportError:
    raise ImportError("Playwright is not installed. Please install it with: pip install playwright")

try:
    from PyPDF2 import PdfWriter, PdfReader
except ImportError:
    raise ImportError("PyPDF2 is not installed. Please install it with: pip install PyPDF2")


# Create router
router = APIRouter(prefix="/presentation", tags=["pdf-conversion"])

# Create output directory for generated PDFs
output_dir = Path("generated_pdfs")
output_dir.mkdir(exist_ok=True)


class ConvertRequest(BaseModel):
    presentation_path: str = Field(..., description="Path to the presentation folder containing metadata.json")
    download: bool = Field(False, description="If true, returns the PDF file directly. If false, returns JSON with download URL.")


class ConvertResponse(BaseModel):
    success: bool
    message: str
    pdf_url: str
    filename: str
    total_slides: int


class PresentationToPDFAPI:
    def __init__(self, presentation_dir: str):
        """Initialize the converter with presentation directory."""
        self.presentation_dir = Path(presentation_dir).resolve()
        self.metadata_path = self.presentation_dir / "metadata.json"
        self.metadata = None
        self.slides_info = []
        
        # Validate inputs
        if not self.presentation_dir.exists():
            raise FileNotFoundError(f"Presentation directory not found: {self.presentation_dir}")
        
        if not self.metadata_path.exists():
            raise FileNotFoundError(f"metadata.json not found in: {self.presentation_dir}")
    
    def load_metadata(self) -> Dict:
        """Load and parse metadata.json"""
        try:
            with open(self.metadata_path, 'r', encoding='utf-8') as f:
                self.metadata = json.load(f)
            
            # Extract slide information and sort by slide number
            slides = self.metadata.get('slides', {})
            self.slides_info = []
            
            for slide_num, slide_data in slides.items():
                filename = slide_data.get('filename')
                file_path = slide_data.get('file_path')
                title = slide_data.get('title', f'Slide {slide_num}')
                
                if file_path:
                    html_path = Path(f"/workspace/{file_path}")
                    print(f"Using path: {html_path}")
                    
                    # Verify the path exists
                    if html_path.exists():
                        self.slides_info.append({
                            'number': int(slide_num),
                            'title': title,
                            'filename': filename,
                            'path': html_path
                        })
                        print(f"Added slide {slide_num}: {html_path}")
                    else:
                        print(f"Warning: HTML file does not exist: {html_path}")
            
            # Sort slides by number
            self.slides_info.sort(key=lambda x: x['number'])
            
            if not self.slides_info:
                raise ValueError("No valid slides found in metadata.json")
            
            return self.metadata
            
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON in metadata.json: {e}")
        except Exception as e:
            raise ValueError(f"Error loading metadata: {e}")
    
    async def render_slide_to_pdf(self, browser, slide_info: Dict, temp_dir: Path) -> Path:
        """Render a single HTML slide to PDF using Playwright."""
        html_path = slide_info['path']
        slide_num = slide_info['number']
        
        print(f"Rendering slide {slide_num}: {slide_info['title']}")
        
        # Create new page with exact presentation dimensions
        page = await browser.new_page()
        
        try:
            # Set exact viewport to 1920x1080
            await page.set_viewport_size({"width": 1920, "height": 1080})
            await page.emulate_media(media='screen')
            
            # Override device pixel ratio for exact dimensions
            await page.evaluate("""
                () => {
                    Object.defineProperty(window, 'devicePixelRatio', {
                        get: () => 1
                    });
                }
            """)
            
            # Navigate to the HTML file
            file_url = f"file://{html_path.absolute()}"
            await page.goto(file_url, wait_until="networkidle", timeout=30000)
            
            # Wait for fonts and dynamic content to load
            await page.wait_for_timeout(3000)
            
            # Ensure exact slide dimensions
            await page.evaluate("""
                () => {
                    const slideContainer = document.querySelector('.slide-container');
                    if (slideContainer) {
                        slideContainer.style.width = '1920px';
                        slideContainer.style.height = '1080px';
                        slideContainer.style.transform = 'none';
                        slideContainer.style.maxWidth = 'none';
                        slideContainer.style.maxHeight = 'none';
                    }
                    
                    document.body.style.margin = '0';
                    document.body.style.padding = '0';
                    document.body.style.width = '1920px';
                    document.body.style.height = '1080px';
                    document.body.style.overflow = 'hidden';
                }
            """)
            
            await page.wait_for_timeout(1000)
            
            # Generate PDF for this slide
            temp_pdf_path = temp_dir / f"slide_{slide_num:02d}.pdf"
            
            await page.pdf(
                path=str(temp_pdf_path),
                width="1920px",
                height="1080px",
                margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
                print_background=True,
                prefer_css_page_size=False
            )
            
            print(f"  ✓ Slide {slide_num} rendered")
            return temp_pdf_path
            
        except Exception as e:
            raise RuntimeError(f"Error rendering slide {slide_num}: {e}")
        finally:
            await page.close()
    
    def combine_pdfs(self, pdf_paths: List[Path], output_path: Path) -> None:
        """Combine multiple PDF files into a single PDF."""
        print(f"Combining {len(pdf_paths)} PDFs...")
        
        pdf_writer = PdfWriter()
        
        try:
            for pdf_path in pdf_paths:
                if pdf_path.exists():
                    with open(pdf_path, 'rb') as pdf_file:
                        pdf_reader = PdfReader(pdf_file)
                        for page in pdf_reader.pages:
                            pdf_writer.add_page(page)
            
            # Write the combined PDF
            with open(output_path, 'wb') as output_file:
                pdf_writer.write(output_file)
            
            print(f"✅ PDF created: {output_path}")
            
        except Exception as e:
            raise RuntimeError(f"Error combining PDFs: {e}")
    
    async def convert_to_pdf(self, store_locally: bool = True) -> tuple:
        """Main conversion method with concurrent processing."""
        print("🚀 Starting concurrent HTML to PDF conversion...")
        
        # Load metadata
        self.load_metadata()
        
        # Create temporary directory for intermediate files
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            
            # Launch browser
            async with async_playwright() as p:
                print("🌐 Launching browser...")
                browser = await p.chromium.launch(
                    headless=True,
                    args=[
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--force-device-scale-factor=1',
                        '--disable-background-timer-throttling'
                    ]
                )
                
                try:
                    # Process all slides concurrently using asyncio.gather
                    print(f"📄 Processing {len(self.slides_info)} slides concurrently...")
                    
                    tasks = [
                        self.render_slide_to_pdf(browser, slide_info, temp_path)
                        for slide_info in self.slides_info
                    ]
                    
                    # Wait for all slides to be processed concurrently
                    pdf_paths = await asyncio.gather(*tasks)
                    
                finally:
                    await browser.close()
            
            # Create output path
            presentation_name = self.metadata.get('presentation_name', 'presentation')
            temp_output_path = temp_path / f"{presentation_name}.pdf"
            
            # Combine all PDFs (sort by slide number to maintain order)
            sorted_pdf_paths = sorted(pdf_paths, key=lambda p: int(p.stem.split('_')[1]))
            self.combine_pdfs(sorted_pdf_paths, temp_output_path)
            
            if store_locally:
                # Store in the static files directory for URL serving
                timestamp = int(asyncio.get_event_loop().time())
                filename = f"{presentation_name}_{timestamp}.pdf"
                final_output = output_dir / filename
                import shutil
                shutil.copy2(temp_output_path, final_output)
                return final_output, len(self.slides_info)
            else:
                # For direct download, read file content into memory (no local storage)
                with open(temp_output_path, 'rb') as f:
                    pdf_content = f.read()
                return pdf_content, len(self.slides_info), presentation_name


@router.post("/convert-to-pdf")
async def convert_presentation_to_pdf(request: ConvertRequest):
    """
    Convert HTML presentation to PDF with concurrent processing.
    
    Takes a presentation folder path and returns either:
    - PDF file directly (if download=true) - uses presentation name as filename
    - JSON response with download URL (if download=false, default)
    """
    try:
        print(f"📥 Received conversion request for: {request.presentation_path}")
        
        # Create converter
        converter = PresentationToPDFAPI(request.presentation_path)
        
        # If download is requested, don't store locally and return file directly
        if request.download:
            pdf_content, total_slides, presentation_name = await converter.convert_to_pdf(store_locally=False)
            
            print(f"✨ Direct download conversion completed for: {presentation_name}")
            
            return Response(
                content=pdf_content,
                media_type="application/pdf",
                headers={"Content-Disposition": f"attachment; filename=\"{presentation_name}.pdf\""}
            )
        
        # Otherwise, store locally and return JSON with download URL
        pdf_path, total_slides = await converter.convert_to_pdf(store_locally=True)
        
        print(f"✨ Conversion completed: {pdf_path}")
        
        pdf_url = f"/downloads/{pdf_path.name}"
        
        return ConvertResponse(
            success=True,
            message=f"PDF generated successfully with {total_slides} slides",
            pdf_url=pdf_url,
            filename=pdf_path.name,
            total_slides=total_slides
        )
        
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"❌ Conversion error: {e}")
        raise HTTPException(status_code=500, detail=f"Conversion failed: {str(e)}")


@router.get("/health")
async def pdf_health_check():
    """PDF service health check endpoint."""
    return {"status": "healthy", "service": "HTML to PDF Converter"}