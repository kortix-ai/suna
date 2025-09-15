#!/usr/bin/env python3
"""
Visual HTML Editor Router

Provides visual HTML editing endpoints as a FastAPI router that can be included in other applications.
"""

import os
import re
from typing import Optional, Dict, Any
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from bs4 import BeautifulSoup, NavigableString, Comment

# Create router
router = APIRouter(prefix="/api/html", tags=["visual-editor"])

# Use /workspace as the default workspace directory
workspace_dir = "/workspace"

# All text elements that should be editable
TEXT_ELEMENTS = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',  # Headings
    'p',  # Paragraphs
    'span', 'strong', 'em', 'b', 'i', 'u',  # Inline text formatting
    'small', 'mark', 'del', 'ins', 'sub', 'sup',  # Text modifications
    'code', 'kbd', 'samp', 'var', 'pre',  # Code and preformatted text
    'blockquote', 'cite', 'q',  # Quotes and citations
    'abbr', 'dfn', 'time', 'data',  # Semantic text
    'address', 'figcaption', 'caption',  # Descriptive text
    'th', 'td',  # Table cells
    'dt', 'dd',  # Definition lists
    'li',  # List items
    'label', 'legend',  # Form text
]


class EditTextRequest(BaseModel):
    file_path: str
    element_selector: str  # CSS selector to identify element
    new_text: str


class DeleteElementRequest(BaseModel):
    file_path: str
    element_selector: str


class SaveContentRequest(BaseModel):
    file_path: str
    html_content: str


class GetEditableElementsResponse(BaseModel):
    elements: list[Dict[str, Any]]


@router.get("/{file_path:path}/editable-elements")
async def get_editable_elements(file_path: str):
    """Get all editable text elements from an HTML file"""
    try:
        full_path = os.path.join(workspace_dir, file_path)
        if not os.path.exists(full_path):
            raise HTTPException(status_code=404, detail="File not found")
        
        with open(full_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        soup = BeautifulSoup(content, 'html.parser')
        elements = []
        
        editable_counter = 0
        
        # Find all elements that could contain text
        all_elements = soup.find_all(TEXT_ELEMENTS + ['div'])
        
        # Filter out elements that only contain comments
        filtered_elements = []
        for element in all_elements:
            # Check if element only contains comments
            only_comments = True
            for child in element.children:
                if isinstance(child, Comment):
                    continue
                if isinstance(child, NavigableString) and not child.strip():
                    continue
                only_comments = False
                break
                
            if not only_comments:
                filtered_elements.append(element)
                
        all_elements = filtered_elements
        
        for element in all_elements:
            # Strategy 1: Elements with ONLY text content (no child elements)
            if element.string and element.string.strip():
                element_id = f"editable-{editable_counter}"
                element['data-editable-id'] = element_id
                element['class'] = element.get('class', []) + ['editable-element']
                
                elements.append({
                    'id': element_id,
                    'tag': element.name,
                    'text': element.string.strip(),
                    'selector': f'[data-editable-id="{element_id}"]',
                    'innerHTML': element.string.strip()
                })
                editable_counter += 1
            
            # Strategy 2: Elements with mixed content - wrap raw text nodes individually
            elif element.contents:
                has_mixed_content = False
                # Process each child node
                for child in list(element.contents):  # Use list() to avoid modification during iteration
                    # Skip comment nodes (Comments are a subclass of NavigableString)
                    if isinstance(child, Comment):
                        continue
                    # Check if it's a NavigableString (raw text) with actual content
                    if (isinstance(child, NavigableString) and child.strip()):
                        
                        # This is a raw text node with content
                        text_content = child.strip()
                        if text_content:
                            # Create a wrapper span for the raw text
                            wrapper_span = soup.new_tag('span')
                            wrapper_span['data-editable-id'] = f"editable-{editable_counter}"
                            wrapper_span['class'] = 'editable-element raw-text-wrapper'
                            wrapper_span.string = text_content
                            
                            # Replace the text node with the wrapped span
                            child.replace_with(wrapper_span)
                            
                            elements.append({
                                'id': f"editable-{editable_counter}",
                                'tag': 'text-node',
                                'text': text_content,
                                'selector': f'[data-editable-id="editable-{editable_counter}"]',
                                'innerHTML': text_content
                            })
                            editable_counter += 1
                            has_mixed_content = True
                
                # Removed fallback - prevents complex containers from becoming editable text
        
        return {"elements": elements}
        
    except Exception as e:
        print(f"Error getting editable elements: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/edit-text")
async def edit_text(request: EditTextRequest):
    """Edit text content of an element in an HTML file"""
    try:
        full_path = os.path.join(workspace_dir, request.file_path)
        if not os.path.exists(full_path):
            raise HTTPException(status_code=404, detail="File not found")
        
        with open(full_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        soup = BeautifulSoup(content, 'html.parser')
        
        # Extract element ID from selector
        element_id = request.element_selector.replace('[data-editable-id="', '').replace('"]', '')
        
        # Find the specific editable element by its data-editable-id
        target_element = soup.find(attrs={'data-editable-id': element_id})
        
        if not target_element:
            raise HTTPException(status_code=404, detail=f"Element with ID {element_id} not found")
        
        print(f"🎯 Found element: {target_element.name} with ID {element_id} - '{target_element.get_text()[:50]}...'")
        
        # Simple replacement - whether it's a regular element or a wrapped text node
        if target_element.string:
            target_element.string.replace_with(request.new_text)
        else:
            # Clear content and add new text
            target_element.clear()
            target_element.string = request.new_text
        
        # Write back to file
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(str(soup))
        
        print(f"✅ Successfully updated text in {request.file_path}: '{request.new_text}'")
        return {"success": True, "message": "Text updated successfully"}
        
    except Exception as e:
        print(f"❌ Error editing text: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/delete-element")
async def delete_element(request: DeleteElementRequest):
    """Delete an element from an HTML file"""
    try:
        full_path = os.path.join(workspace_dir, request.file_path)
        if not os.path.exists(full_path):
            raise HTTPException(status_code=404, detail="File not found")
        
        with open(full_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        soup = BeautifulSoup(content, 'html.parser')
        
        # Handle both editable elements and removable divs
        if '[data-editable-id="' in request.element_selector:
            # Text element deletion
            element_id = request.element_selector.replace('[data-editable-id="', '').replace('"]', '')
            
            # Find the specific editable element by its data-editable-id
            target_element = soup.find(attrs={'data-editable-id': element_id})
            
            if not target_element:
                raise HTTPException(status_code=404, detail=f"Element with ID {element_id} not found")
                    
        elif '[data-removable-id="' in request.element_selector:
            # Div removal
            element_id = request.element_selector.replace('[data-removable-id="', '').replace('"]', '')
            
            # Find the specific removable element by its data-removable-id
            target_element = soup.find(attrs={'data-removable-id': element_id})
            
            if not target_element:
                raise HTTPException(status_code=404, detail=f"Element with ID {element_id} not found")
        else:
            raise HTTPException(status_code=400, detail="Invalid element selector")
        
        print(f"🗑️ Deleting element: {target_element.name} - '{target_element.get_text()[:50]}...'")
        
        # Remove element
        target_element.decompose()
        
        # Write back to file
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(str(soup))
        
        print(f"🗑️ Successfully deleted element from {request.file_path}")
        return {"success": True, "message": "Element deleted successfully"}
        
    except Exception as e:
        print(f"❌ Error deleting element: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/save-content")
async def save_content(request: SaveContentRequest):
    """Save the entire HTML content to file"""
    try:
        full_path = os.path.join(workspace_dir, request.file_path)
        if not os.path.exists(full_path):
            raise HTTPException(status_code=404, detail="File not found")
        
        # Clean up the HTML content by removing editor-specific classes and attributes
        soup = BeautifulSoup(request.html_content, 'html.parser')
        
        # Remove editor-specific elements and attributes
        for element in soup.find_all():
            # Remove editor classes
            if element.get('class'):
                classes = element['class']
                classes = [cls for cls in classes if cls not in ['editable-element', 'removable-element', 'raw-text-wrapper', 'selected', 'editing', 'element-modified', 'element-deleted']]
                if classes:
                    element['class'] = classes
                else:
                    del element['class']
            
            # Remove editor data attributes
            if element.get('data-editable-id'):
                del element['data-editable-id']
            if element.get('data-removable-id'):
                del element['data-removable-id']
            if element.get('data-original-text'):
                del element['data-original-text']
        
        # Remove editor controls
        for control in soup.find_all(['div'], class_=['edit-controls', 'remove-controls', 'save-cancel-controls']):
            control.decompose()
        
        # Remove editor header
        for header in soup.find_all(['div'], class_='editor-header'):
            header.decompose()
        
        # Remove editor CSS and JS
        for style in soup.find_all('style'):
            if 'Visual Editor Styles' in style.get_text():
                style.decompose()
        
        for script in soup.find_all('script'):
            if 'VisualHtmlEditor' in script.get_text():
                script.decompose()
        
        # Write the cleaned HTML back to file
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(str(soup))
        
        print(f"💾 Successfully saved content to {request.file_path}")
        return {"success": True, "message": "Content saved successfully"}
        
    except Exception as e:
        print(f"❌ Error saving content: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{file_path:path}/images/{image_path:path}")
async def proxy_images(file_path: str, image_path: str):
    """Proxy images for editor context - resolves relative paths"""
    try:
        # Extract the actual image path from the relative reference
        # When HTML has ../images/image.jpg from presentations/pres_name/slide.html
        # Browser requests /api/html/presentations/pres_name/slide.html/images/image.jpg
        # We need to serve from /workspace/presentations/images/image.jpg
        
        # workspace_dir is /workspace, so presentations/images/ is the target
        actual_image_path = os.path.join(workspace_dir, "presentations", "images", image_path)
        actual_image_path = os.path.abspath(actual_image_path)
        
        if not os.path.exists(actual_image_path):
            raise HTTPException(status_code=404, detail="Image not found")
        
        # Serve the image file
        return FileResponse(actual_image_path)
        
    except Exception as e:
        print(f"❌ Error serving image: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{file_path:path}/editor")
async def get_html_editor(file_path: str):
    """Serve the visual editor for an HTML file"""
    try:
        full_path = os.path.join(workspace_dir, file_path)
        if not os.path.exists(full_path):
            raise HTTPException(status_code=404, detail="File not found")
        
        with open(full_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Inject editor functionality into the HTML
        editor_html = inject_editor_functionality(content, file_path)
        
        return HTMLResponse(content=editor_html)
        
    except Exception as e:
        print(f"❌ Error serving editor: {e}")
        raise HTTPException(status_code=500, detail=str(e))



def inject_editor_functionality(html_content: str, file_path: str) -> str:
    """Inject visual editor functionality into existing HTML"""
    
    # Parse the HTML
    soup = BeautifulSoup(html_content, 'html.parser')
    
    
    # Apply the same transformation as the API endpoint
    editable_counter = 0
    
    # Find all elements that could contain text
    all_elements = soup.find_all(TEXT_ELEMENTS + ['div'])
    
    # Filter out elements that only contain comments
    filtered_elements = []
    for element in all_elements:
        # Check if element only contains comments
        only_comments = True
        for child in element.children:
            if isinstance(child, Comment):
                continue
            if isinstance(child, NavigableString) and not child.strip():
                continue
            only_comments = False
            break
            
        if not only_comments:
            filtered_elements.append(element)
            
    all_elements = filtered_elements
    
    for element in all_elements:
        # Strategy 1: Elements with ONLY text content (no child elements)
        if element.string and element.string.strip():
            element['data-editable-id'] = f"editable-{editable_counter}"
            element['class'] = element.get('class', []) + ['editable-element']
            editable_counter += 1
        
        # Strategy 2: Elements with mixed content - wrap raw text nodes individually
        elif element.contents:
            has_mixed_content = False
            # Process each child node
            for child in list(element.contents):  # Use list() to avoid modification during iteration
                # Skip comment nodes (Comments are a subclass of NavigableString)
                if isinstance(child, Comment):
                    continue
                # Check if it's a NavigableString (raw text) with actual content
                if (isinstance(child, NavigableString) and child.strip()):
                    
                    # This is a raw text node with content
                    text_content = child.strip()
                    if text_content:
                        # Create a wrapper span for the raw text
                        wrapper_span = soup.new_tag('span')
                        wrapper_span['data-editable-id'] = f"editable-{editable_counter}"
                        wrapper_span['class'] = 'editable-element raw-text-wrapper'
                        wrapper_span.string = text_content
                        
                        # Replace the text node with the wrapped span
                        child.replace_with(wrapper_span)
                        editable_counter += 1
                        has_mixed_content = True
            
            # Removed fallback - prevents complex containers from becoming editable text
    
    # All divs are removable (except editor control elements)
    div_elements = soup.find_all('div')
    removable_counter = 0
    for element in div_elements:
        # Skip editor control divs
        element_classes = element.get('class', [])
        if any(cls in ['edit-controls', 'remove-controls', 'save-cancel-controls', 'editor-header'] for cls in element_classes):
            continue
        
        element['data-removable-id'] = f'div-{removable_counter}'
        element['class'] = element.get('class', []) + ['removable-element']
        removable_counter += 1
    
    # Add editor CSS
    editor_css = """
    <style>
        /* Visual Editor Styles - Clean Black/White Theme */
        .editable-element, .removable-element {
            position: relative;
            transition: all 0.15s ease;
        }
        
        /* Style for wrapped raw text nodes - make them completely invisible */
        .raw-text-wrapper {
            display: inline;
            background: transparent;
            border: none;
            padding: 0;
            margin: 0;
            font: inherit;
            color: inherit;
            text-decoration: inherit;
            font-weight: inherit;
            font-style: inherit;
            font-size: inherit;
            line-height: inherit;
            letter-spacing: inherit;
            text-transform: inherit;
        }
        
        .editable-element {
            cursor: pointer;
            transition: outline 0.15s ease;
        }
        
        .removable-element {
            cursor: pointer;
            transition: outline 0.15s ease;
        }
        
        /* Only show visual feedback on selection, not hover */
        .editable-element.selected {
            outline: 2px solid #3b82f6;
            outline-offset: 2px;
        }
        
        .removable-element.selected {
            outline: 2px solid #f97316;
            outline-offset: 2px;
        }
        

        
        .editable-element.editing {
            outline: 2px solid #3b82f6;
            outline-offset: 2px;
        }
        
        .element-modified {
            outline: 2px dashed #f59e0b !important;
            outline-offset: 2px;
        }
        
        .element-deleted {
            opacity: 0.4;
            outline: 2px dashed #ef4444 !important;
            outline-offset: 2px;
        }
        
        .edit-controls {
            position: fixed;
            display: none;
            z-index: 999999;
            background: white;
            border: 1px solid #e4e4e7;
            padding: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            border-radius: 8px;
            transition: opacity 0.15s ease;
            pointer-events: auto;
        }
        
        /* Controls are now positioned via JavaScript - these selectors removed */
        
        .remove-controls {
            position: fixed;
            display: none;
            z-index: 999999;
            background: white;
            border: 1px solid #e4e4e7;
            padding: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            border-radius: 8px;
            transition: opacity 0.15s ease;
            pointer-events: auto;
        }
        
        .edit-btn, .delete-btn {
            background: white;
            border: 1px solid #e4e4e7;
            cursor: pointer;
            padding: 6px 8px;
            font-size: 12px;
            color: #09090b;
            transition: all 0.15s ease;
            min-width: 32px;
            text-align: center;
            border-radius: 6px;
            font-weight: 500;
        }
        
        .edit-btn:hover {
            background: #f4f4f5;
            border-color: #d4d4d8;
        }
        
        .delete-btn:hover {
            background: #fef2f2;
            border-color: #fca5a5;
            color: #dc2626;
        }
        
        .editor-input {
            min-width: 200px;
            padding: 8px 12px;
            border: 1px solid #e4e4e7;
            border-radius: 6px;
            font-family: inherit;
            font-size: inherit;
            background: white;
            color: #09090b;
            outline: none;
            transition: all 0.15s ease;
        }
        
        .editor-input:focus {
            border-color: #09090b;
            box-shadow: 0 0 0 2px rgba(9, 9, 11, 0.1);
        }
        
        .save-cancel-controls {
            position: absolute;
            top: 100%;
            left: 0;
            background: white;
            border: 1px solid #e4e4e7;
            border-radius: 8px;
            padding: 4px;
            margin-top: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            display: flex;
            gap: 4px;
            z-index: 1000;
        }
        
        .save-btn, .cancel-btn {
            padding: 6px 12px;
            border: 1px solid #e4e4e7;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            background: white;
            color: #09090b;
            transition: all 0.15s ease;
            font-weight: 500;
        }
        
        .save-btn {
            background: #09090b;
            color: white;
            border-color: #09090b;
        }
        
        .save-btn:hover {
            background: #18181b;
            border-color: #18181b;
        }
        
        .cancel-btn:hover {
            background: #f4f4f5;
            border-color: #d4d4d8;
        }
        
        .editor-notification {
            position: fixed;
            top: 80px;
            right: 20px;
            padding: 12px 16px;
            background: white;
            border: 1px solid #e4e4e7;
            color: #09090b;
            font-weight: 500;
            z-index: 10000;
            animation: slideIn 0.3s ease;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
            font-size: 13px;
            border-radius: 8px;
        }
        
        .editor-notification.success:before {
            content: "✓ ";
            color: #09090b;
        }
        
        .editor-notification.error {
            background: #09090b;
            color: white;
            border-color: #09090b;
        }
        
        .editor-notification.error:before {
            content: "✗ ";
        }
        
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        
        @keyframes flash {
            0%, 100% { background-color: transparent; }
            50% { background-color: rgba(59, 130, 246, 0.2); }
        }
        
        /* Editor header */
        .editor-header {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            color: #09090b;
            padding: 12px 20px;
            z-index: 9999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 12px;
            display: flex;
            justify-content: center;
            align-items: center;
            cursor: move;
            user-select: none;
            transition: all 0.15s ease;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        
        .editor-header:hover {
            background: rgba(255, 255, 255, 0.15);
            border-color: rgba(255, 255, 255, 0.3);
        }
        
        .editor-header.dragging {
            background: rgba(255, 255, 255, 0.2);
            transform: translateX(-50%) scale(1.05);
        }
        
        .editor-actions {
            display: flex;
            gap: 12px;
            align-items: center;
        }
        
        .nav-controls {
            display: flex;
            gap: 4px;
            margin-right: 12px;
        }
        
        .nav-btn {
            padding: 6px 12px;
            border: 1px solid #e4e4e7;
            background: white;
            color: #09090b;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
            border-radius: 6px;
            width: 5rem;
        }
        
        .nav-btn:hover:not(:disabled) {
            background: #f4f4f5;
            border-color: #d4d4d8;
        }
        
        .nav-btn:disabled {
            opacity: 1;
            cursor: not-allowed;
        }
        
        .editor-status {
            font-size: 13px;
            color: white;
            font-weight: 500;
            margin: 0 8px;
        }
        
        .header-btn {
            padding: 6px 16px;
            border: 1px solid #e4e4e7;
            background: white;
            color: #09090b;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
            border-radius: 6px;
            width: 7rem;
        }
        
        .header-btn:hover:not(:disabled) {
            background: #f4f4f5;
            border-color: #d4d4d8;
        }
        
        .header-btn:disabled {
            opacity: 1;
            cursor: not-allowed;
        }
        
        .save-btn-header {
            background: #09090b;
            color: white;
            border-color: #09090b;
        }
        
        .save-btn-header:hover:not(:disabled) {
            background: #18181b;
            border-color: #18181b;
        }
        
        body {
            padding-top: 0 !important;
        }
    </style>
    """
    
    # Add editor JavaScript
    editor_js = f"""
    <script>
        const API_BASE = '/api/html';
        const FILE_PATH = '{file_path}';
        
        class VisualHtmlEditor {{
            constructor() {{
                this.currentlyEditing = null;
                this.pendingChanges = new Map(); // Store changes before saving
                this.deletedElements = new Set(); // Track deleted elements
                this.originalContent = new Map(); // Store original content for revert
                this.selectedElement = null; // Currently selected element
                this.changeOrder = []; // Array to track order of changes (for undo)
                this.undoneChanges = []; // Array to track undone changes (for redo)
                
                // Header drag functionality
                this.isDraggingHeader = false;
                this.headerDragOffset = {{ x: 0, y: 0 }};
                this.headerPosition = {{ x: 0, y: 20 }};
                
                this.init();
                this.setupBeforeUnload();
            }}
            
            init() {{
                this.addEditorHeader();
                this.addEditControls();
                this.bindEvents();
                console.log('🎨 Visual HTML Editor initialized for:', FILE_PATH);
            }}
            
            addEditorHeader() {{
                const header = document.createElement('div');
                header.className = 'editor-header';
                header.innerHTML = `
                    <div class="editor-actions">
                        <div class="nav-controls">
                            <button class="nav-btn" id="undo-change" disabled title="Undo last change">← Undo</button>
                            <button class="nav-btn" id="redo-change" disabled title="Redo last undone change">Redo →</button>
                        </div>
                        <span class="editor-status" id="editor-status">No changes</span>
                        <button class="header-btn" id="revert-btn" disabled>Revert All</button>
                        <button class="header-btn save-btn-header" id="save-btn" disabled>Save All</button>
                    </div>
                `;
                document.body.insertBefore(header, document.body.firstChild);
            }}
            
            addEditControls() {{
                // Store original text for editable elements
                document.querySelectorAll('.editable-element').forEach(element => {{
                    if (!element.dataset.originalText) {{
                        // For mixed content, try to get direct text nodes only
                        const directTextNodes = Array.from(element.childNodes)
                            .filter(node => node.nodeType === Node.TEXT_NODE)
                            .map(node => node.textContent.trim())
                            .filter(text => text.length > 0);
                        
                        if (directTextNodes.length > 0) {{
                            element.dataset.originalText = directTextNodes.join(' ');
                        }} else {{
                            // Fallback to all text content
                            element.dataset.originalText = element.textContent.trim();
                        }}
                    }}
                }});
                
                // Note: Controls are now created dynamically on click, not pre-added
            }}
            
            createEditControls(element) {{
                // Remove any existing controls first
                this.removeAllControls();
                
                const controls = document.createElement('div');
                controls.className = 'edit-controls';
                
                const editBtn = document.createElement('button');
                editBtn.className = 'edit-btn';
                editBtn.innerHTML = '✏️';
                editBtn.title = 'Edit text';
                
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'delete-btn';
                deleteBtn.innerHTML = '🗑️';
                deleteBtn.title = 'Delete element';
                
                controls.appendChild(editBtn);
                controls.appendChild(deleteBtn);
                document.body.appendChild(controls);
                
                // Position the controls intelligently
                this.positionControls(controls, element);
                
                return controls;
            }}
            
            createRemoveControls(element) {{
                // Remove any existing controls first
                this.removeAllControls();
                
                const controls = document.createElement('div');
                controls.className = 'remove-controls';
                
                const removeBtn = document.createElement('button');
                removeBtn.className = 'delete-btn';
                removeBtn.innerHTML = '🗑️';
                removeBtn.title = 'Remove this div';
                
                controls.appendChild(removeBtn);
                document.body.appendChild(controls);
                
                // Position the controls intelligently
                this.positionControls(controls, element);
                
                return controls;
            }}
            
            removeAllControls() {{
                // Remove all existing control elements
                document.querySelectorAll('.edit-controls, .remove-controls').forEach(control => {{
                    control.remove();
                }});
                
                // Clean up scroll/resize listeners when all controls are removed
                if (this._repositionHandler) {{
                    window.removeEventListener('scroll', this._repositionHandler);
                    window.removeEventListener('resize', this._repositionHandler);
                    this._repositionHandler = null;
                }}
            }}
            
            positionControls(controls, element) {{
                // Safety checks - ensure both controls and element exist
                if (!controls || !element) {{
                    console.error('❌ Cannot position controls: controls or element is null');
                    return;
                }}
                
                // Get element position and viewport dimensions
                const rect = element.getBoundingClientRect();
                const viewportWidth = window.innerWidth;
                const viewportHeight = window.innerHeight;
                
                // Temporary append to measure control dimensions
                controls.style.visibility = 'hidden';
                controls.style.display = 'flex';
                const controlsRect = controls.getBoundingClientRect();
                controls.style.display = 'none';
                controls.style.visibility = 'visible';
                
                // Calculate preferred position (above and to the right of element)
                let left = rect.right - controlsRect.width - 5;
                let top = rect.top - controlsRect.height - 10;
                
                // Ensure controls stay within viewport bounds
                if (left < 10) {{
                    left = 10; // Keep some margin from left edge
                }}
                if (left + controlsRect.width > viewportWidth - 10) {{
                    left = viewportWidth - controlsRect.width - 10;
                }}
                
                // If controls would be above viewport, position them below the element
                if (top < 10) {{
                    top = rect.bottom + 10;
                }}
                
                // If still out of bounds below, position at top of viewport
                if (top + controlsRect.height > viewportHeight - 10) {{
                    top = 10;
                }}
                
                // Apply position
                controls.style.left = left + 'px';
                controls.style.top = top + 'px';
                controls.style.display = 'flex';
                
                // Store reference to element for repositioning on scroll/resize
                controls._targetElement = element;
                
                // Add scroll and resize listeners to reposition
                const repositionHandler = () => {{
                    if (controls._targetElement && document.body.contains(controls) && document.body.contains(controls._targetElement)) {{
                        this.positionControls(controls, controls._targetElement);
                    }} else if (document.body.contains(controls)) {{
                        // Target element no longer exists, remove controls
                        controls.remove();
                    }}
                }};
                
                if (!this._repositionHandler) {{
                    this._repositionHandler = repositionHandler;
                    window.addEventListener('scroll', this._repositionHandler);
                    window.addEventListener('resize', this._repositionHandler);
                }}
            }}
            

            
            bindEvents() {{
                document.addEventListener('click', (e) => {{
                    if (e.target.classList.contains('edit-btn')) {{
                        e.stopPropagation();
                        // Use stored reference from controls
                        const controls = e.target.closest('.edit-controls');
                        const element = controls ? controls._targetElement : null;
                        if (element) {{
                            this.startEditing(element);
                        }} else {{
                            console.error('❌ Could not find element to edit - button may be detached');
                        }}
                    }} else if (e.target.classList.contains('delete-btn')) {{
                        e.stopPropagation();
                        // Use stored reference from controls  
                        const controls = e.target.closest('.edit-controls') || e.target.closest('.remove-controls');
                        const element = controls ? controls._targetElement : null;
                        if (element) {{
                            this.deleteElement(element);
                        }} else {{
                            console.error('❌ Could not find element to delete - button may be detached');
                        }}
                    }} else if (e.target.classList.contains('save-btn')) {{
                        e.stopPropagation();
                        this.saveEdit();
                    }} else if (e.target.classList.contains('cancel-btn')) {{
                        e.stopPropagation();
                        this.cancelEdit();
                    }} else if (e.target.id === 'save-btn') {{
                        e.stopPropagation();
                        this.saveAllChanges();
                    }} else if (e.target.id === 'revert-btn') {{
                        e.stopPropagation();
                        this.revertAllChanges();
                    }} else if (e.target.id === 'undo-change') {{
                        e.stopPropagation();
                        this.undoLastChange();
                    }} else if (e.target.id === 'redo-change') {{
                        e.stopPropagation();
                        this.redoLastChange();
                    }} else if (e.target.closest('.editable-element')) {{
                        e.stopPropagation();
                        const element = e.target.closest('.editable-element');
                        if (element) {{
                            this.selectElement(element);
                        }}
                    }} else if (e.target.closest('.removable-element')) {{
                        e.stopPropagation();
                        const element = e.target.closest('.removable-element');
                        if (element) {{
                            this.selectElement(element);
                        }}
                    }} else {{
                        // Clicking outside elements deselects
                        this.clearSelection();
                        if (this.currentlyEditing) {{
                            this.cancelEdit();
                        }}
                    }}
                }});
                
                document.addEventListener('keydown', (e) => {{
                    if (this.currentlyEditing) {{
                        if (e.key === 'Enter' && e.ctrlKey) {{
                            this.saveEdit();
                        }} else if (e.key === 'Escape') {{
                            this.cancelEdit();
                        }}
                    }} else if (e.ctrlKey && e.key === 's') {{
                        e.preventDefault();
                        this.saveAllChanges();
                    }}
                }});
                
                // Header drag functionality
                this.setupHeaderDrag();
            }}
            
            setupHeaderDrag() {{
                document.addEventListener('mousedown', (e) => {{
                    const header = e.target.closest('.editor-header');
                    if (header && !e.target.closest('button') && !e.target.closest('.nav-controls')) {{
                        this.startHeaderDrag(e, header);
                    }}
                }});
                
                document.addEventListener('mousemove', (e) => {{
                    if (this.isDraggingHeader) {{
                        this.handleHeaderDrag(e);
                    }}
                }});
                
                document.addEventListener('mouseup', () => {{
                    if (this.isDraggingHeader) {{
                        this.endHeaderDrag();
                    }}
                }});
            }}
            
            startHeaderDrag(e, header) {{
                e.preventDefault();
                e.stopPropagation();
                
                this.isDraggingHeader = true;
                this.headerElement = header;
                
                // Calculate offset from mouse to element center
                const rect = header.getBoundingClientRect();
                this.headerDragOffset.x = e.clientX - (rect.left + rect.width / 2);
                this.headerDragOffset.y = e.clientY - rect.top;
                
                // Add dragging class for visual feedback
                header.classList.add('dragging');
                
                console.log('🖱️ Started dragging header');
            }}
            
            handleHeaderDrag(e) {{
                if (!this.headerElement) return;
                
                const newCenterX = e.clientX - this.headerDragOffset.x;
                const newY = e.clientY - this.headerDragOffset.y;
                
                // Keep within viewport bounds
                const viewportWidth = window.innerWidth;
                const viewportHeight = window.innerHeight;
                const headerRect = this.headerElement.getBoundingClientRect();
                
                const constrainedCenterX = Math.max(headerRect.width / 2, Math.min(viewportWidth - headerRect.width / 2, newCenterX));
                const constrainedY = Math.max(0, Math.min(viewportHeight - headerRect.height, newY));
                
                // Apply position
                this.headerElement.style.left = constrainedCenterX + 'px';
                this.headerElement.style.top = constrainedY + 'px';
                this.headerElement.style.transform = 'translateX(-50%) scale(1.05)';
                
                // Store position
                this.headerPosition.x = constrainedCenterX - viewportWidth / 2;
                this.headerPosition.y = constrainedY;
            }}
            
            endHeaderDrag() {{
                if (!this.headerElement) return;
                
                // Remove dragging class
                this.headerElement.classList.remove('dragging');
                this.headerElement.style.transform = 'translateX(-50%)';
                
                console.log('🖱️ Ended dragging header');
                
                this.isDraggingHeader = false;
                this.headerElement = null;
            }}
            
            selectElement(element) {{
                // Safety check - ensure element exists
                if (!element) {{
                    console.error('❌ Cannot select: element is null');
                    return;
                }}
                
                // Clear previous selection
                this.clearSelection();
                
                // Set new selection
                this.selectedElement = element;
                element.classList.add('selected');
                
                // Create appropriate controls based on element type
                if (element.classList.contains('editable-element')) {{
                    this.createEditControls(element);
                }} else if (element.classList.contains('removable-element')) {{
                    this.createRemoveControls(element);
                }}
                
                console.log('🎯 Selected element:', element.dataset.editableId || element.dataset.removableId);
            }}
            
            clearSelection() {{
                if (this.selectedElement) {{
                    this.selectedElement.classList.remove('selected');
                    this.selectedElement = null;
                }}
                // Remove all controls when clearing selection
                this.removeAllControls();
            }}
            
            undoLastChange() {{
                if (this.changeOrder.length === 0) return;
                
                // Get the most recent change (last in array)
                const elementId = this.changeOrder[this.changeOrder.length - 1];
                const change = this.pendingChanges.get(elementId);
                if (!change) return;
                
                // Log what we're undoing
                const changeType = change.type === 'edit' ? 'text edit' : 'deletion';
                console.log(`↩️ Undoing ${{changeType}} for element:`, elementId);
                
                // Move to undo stack before reverting
                this.undoneChanges.push({{
                    elementId: elementId,
                    change: change,
                    originalContent: this.originalContent.get(elementId)
                }});
                
                // Revert the change
                this.revertSingleChange(elementId);
                
                // Update UI
                this.updateStatus();
                this.updateUndoRedoButtons();

                
                this.showNotification('Change undone', 'success');
            }}
            
            redoLastChange() {{
                if (this.undoneChanges.length === 0) return;
                
                // Get the most recently undone change
                const undoneItem = this.undoneChanges.pop();
                const {{ elementId, change, originalContent }} = undoneItem;
                
                // Log what we're redoing
                const changeType = change.type === 'edit' ? 'text edit' : 'deletion';
                console.log(`🔄 Redoing ${{changeType}} for element:`, elementId);
                
                // Restore the change
                if (change.type === 'edit') {{
                    change.element.textContent = change.newText;
                    change.element.dataset.originalText = change.newText;
                    change.element.classList.add('element-modified');
                }} else if (change.type === 'delete') {{
                    change.element.classList.add('element-deleted');
                    this.deletedElements.add(elementId);
                }}
                
                // Restore to tracking
                this.pendingChanges.set(elementId, change);
                this.originalContent.set(elementId, originalContent);
                this.changeOrder.push(elementId);
                
                // Scroll to and highlight
                change.element.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
                this.selectElement(change.element);
                
                // Flash animation
                change.element.style.animation = 'none';
                setTimeout(() => {{
                    change.element.style.animation = 'flash 0.6s ease-out';
                }}, 10);
                
                // Update UI
                this.updateStatus();
                this.updateUndoRedoButtons();

                this.showNotification('Change redone', 'success');
            }}
            
            revertSingleChange(elementId) {{
                const change = this.pendingChanges.get(elementId);
                if (!change) return;
                
                if (change.type === 'edit') {{
                    // Revert text edit
                    const originalContent = this.originalContent.get(elementId);
                    if (originalContent) {{
                        change.element.textContent = originalContent;
                        change.element.dataset.originalText = originalContent;
                    }}
                    change.element.classList.remove('element-modified');
                    
                    // Scroll to and highlight the reverted element
                    change.element.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
                    this.selectElement(change.element);
                    
                }} else if (change.type === 'delete') {{
                    // Revert deletion
                    change.element.classList.remove('element-deleted');
                    this.deletedElements.delete(elementId);
                    
                    // Scroll to and highlight the restored element
                    change.element.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
                    this.selectElement(change.element);
                }}
                
                // Remove from tracking
                this.pendingChanges.delete(elementId);
                this.originalContent.delete(elementId);
                
                // Remove from change order
                const index = this.changeOrder.indexOf(elementId);
                if (index > -1) {{
                    this.changeOrder.splice(index, 1);
                }}
                
                // Flash animation to show revert
                change.element.style.animation = 'none';
                setTimeout(() => {{
                    change.element.style.animation = 'flash 0.6s ease-out';
                }}, 10);
                
                this.showNotification('Change reverted', 'success');
            }}
            
            updateUndoRedoButtons() {{
                const undoBtn = document.getElementById('undo-change');
                const redoBtn = document.getElementById('redo-change');
                
                undoBtn.disabled = this.changeOrder.length === 0;
                redoBtn.disabled = this.undoneChanges.length === 0;
            }}
            

            
            setupBeforeUnload() {{
                window.addEventListener('beforeunload', (e) => {{
                    if (this.pendingChanges.size > 0) {{
                        const message = 'You have unsaved changes. Are you sure you want to leave?';
                        e.preventDefault();
                        e.returnValue = message;
                        return message;
                    }}
                }});
            }}
            
            startEditing(element) {{
                // Safety check - ensure element exists
                if (!element) {{
                    console.error('❌ Cannot edit: element is null');
                    return;
                }}
                
                if (this.currentlyEditing) {{
                    this.cancelEdit();
                }}
                
                this.currentlyEditing = element;
                element.classList.add('editing');
                
                const currentText = element.dataset.originalText || element.textContent;
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'editor-input';
                input.value = currentText;
                input.style.width = Math.max(200, element.offsetWidth) + 'px';
                
                const controls = document.createElement('div');
                controls.className = 'save-cancel-controls';
                
                const saveBtn = document.createElement('button');
                saveBtn.className = 'save-btn';
                saveBtn.textContent = 'Save';
                
                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'cancel-btn';
                cancelBtn.textContent = 'Cancel';
                
                controls.appendChild(saveBtn);
                controls.appendChild(cancelBtn);
                
                element.style.position = 'relative';
                element.textContent = '';
                element.appendChild(input);
                element.appendChild(controls);
                
                input.focus();
                input.select();
                
                this.originalText = currentText;
                console.log('📝 Started editing element:', element.dataset.editableId);
            }}
            
            saveEdit() {{
                if (!this.currentlyEditing) return;
                
                const input = this.currentlyEditing.querySelector('.editor-input');
                const newText = input.value.trim();
                
                if (!newText) {{
                    this.showNotification('Text cannot be empty', 'error');
                    return;
                }}
                
                const elementId = this.currentlyEditing.dataset.editableId;
                
                // Store original content if not already stored
                if (!this.originalContent.has(elementId)) {{
                    this.originalContent.set(elementId, this.originalText);
                }}
                
                // Track the pending change
                this.pendingChanges.set(elementId, {{
                    type: 'edit',
                    element: this.currentlyEditing,
                    oldText: this.originalText,
                    newText: newText,
                    selector: `[data-editable-id="${{elementId}}"]`
                }});
                
                // Track change order for navigation
                if (!this.changeOrder.includes(elementId)) {{
                    this.changeOrder.push(elementId);
                }}
                
                // Clear redo stack when new change is made
                this.undoneChanges = [];
                
                // Update the visual content
                this.currentlyEditing.textContent = newText;
                this.currentlyEditing.dataset.originalText = newText;
                this.currentlyEditing.classList.add('element-modified');
                
                console.log('📝 Change tracked locally:', elementId, newText);
                this.updateStatus();
                this.updateUndoRedoButtons();

                this.finishEditing();
            }}
            
            cancelEdit() {{
                if (!this.currentlyEditing) return;
                
                console.log('❌ Cancelled editing');
                this.currentlyEditing.textContent = this.originalText;
                this.finishEditing();
            }}
            
            finishEditing() {{
                if (this.currentlyEditing) {{
                    this.currentlyEditing.classList.remove('editing');
                    
                    // If this element is still selected, recreate its controls
                    if (this.selectedElement === this.currentlyEditing) {{
                        setTimeout(() => {{
                            if (this.selectedElement && this.selectedElement.classList.contains('editable-element')) {{
                                this.createEditControls(this.selectedElement);
                            }}
                        }}, 10);
                    }}
                    
                    this.currentlyEditing = null;
                    this.originalText = null;
                }}
            }}
            
            deleteElement(element) {{
                // Safety check - ensure element exists
                if (!element) {{
                    console.error('❌ Cannot delete: element is null');
                    return;
                }}
                
                const text = element.textContent.substring(0, 60);
                if (!confirm('Delete this element?\\\\n\\\\n"' + text + '..."')) {{
                    return;
                }}
                
                const elementId = element.dataset.editableId || element.dataset.removableId;
                const isRemovable = element.classList.contains('removable-element');
                
                // Store original content if not already stored
                if (!this.originalContent.has(elementId)) {{
                    this.originalContent.set(elementId, {{
                        element: element.cloneNode(true),
                        parent: element.parentNode,
                        nextSibling: element.nextSibling
                    }});
                }}
                
                // Track the deletion
                this.pendingChanges.set(elementId, {{
                    type: 'delete',
                    element: element,
                    selector: isRemovable ? `[data-removable-id="${{elementId}}"]` : `[data-editable-id="${{elementId}}"]`
                }});
                
                // Track change order for navigation
                if (!this.changeOrder.includes(elementId)) {{
                    this.changeOrder.push(elementId);
                }}
                
                // Clear redo stack when new change is made
                this.undoneChanges = [];
                
                // Visual indication of deletion
                element.classList.add('element-deleted');
                this.deletedElements.add(elementId);
                
                console.log('🗑️ Element marked for deletion:', elementId);
                this.updateStatus();
                this.updateUndoRedoButtons();

            }}
            
            updateStatus() {{
                const statusEl = document.getElementById('editor-status');
                const saveBtn = document.getElementById('save-btn');
                const revertBtn = document.getElementById('revert-btn');
                
                const changeCount = this.pendingChanges.size;
                
                if (changeCount === 0) {{
                    statusEl.textContent = 'No changes';
                    saveBtn.disabled = true;
                    revertBtn.disabled = true;
                }} else {{
                    statusEl.textContent = `${{changeCount}} unsaved change${{changeCount === 1 ? '' : 's'}}`;
                    saveBtn.disabled = false;
                    revertBtn.disabled = false;
                }}
                
                this.updateUndoRedoButtons();
            }}
            
            async saveAllChanges() {{
                if (this.pendingChanges.size === 0) return;
                
                // Confirm before saving (permanent action)
                const changeCount = this.pendingChanges.size;
                if (!confirm(`Save all ${{changeCount}} change${{changeCount === 1 ? '' : 's'}} to file?\\\\n\\\\nThis action cannot be undone.`)) {{
                    return;
                }}
                
                const saveBtn = document.getElementById('save-btn');
                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving...';
                
                try {{
                    // IMPORTANT: Actually remove elements marked for deletion from DOM before saving
                    console.log('🗑️ Processing deletions before save...');
                    for (const [elementId, change] of this.pendingChanges) {{
                        if (change.type === 'delete') {{
                            console.log(`🗑️ Removing element ${{elementId}} from DOM`);
                            // Actually remove the element from the DOM
                            if (change.element && change.element.parentNode) {{
                                change.element.parentNode.removeChild(change.element);
                            }}
                        }}
                    }}
                    
                    // Get the current HTML content from the DOM (now without deleted elements)
                    const currentHtml = document.documentElement.outerHTML;
                    
                    // Send it to a new endpoint that replaces the file content
                    const response = await fetch(`${{API_BASE}}/save-content`, {{
                        method: 'POST',
                        headers: {{ 'Content-Type': 'application/json' }},
                        body: JSON.stringify({{
                            file_path: FILE_PATH,
                            html_content: currentHtml
                        }})
                    }});
                    
                    if (!response.ok) {{
                        const error = await response.text();
                        throw new Error(`Failed to save: ${{error}}`);
                    }}
                    
                    // Clear all tracking
                    this.pendingChanges.clear();
                    this.deletedElements.clear();
                    this.originalContent.clear();
                    this.changeOrder = [];
                    this.undoneChanges = [];
                    
                    // Remove visual indicators
                    document.querySelectorAll('.element-modified, .element-deleted').forEach(el => {{
                        el.classList.remove('element-modified', 'element-deleted');
                    }});
                    

                    
                    this.showNotification('All changes saved', 'success');
                    console.log('✅ All changes saved to server');
                    
                }} catch (error) {{
                    this.showNotification('Failed to save: ' + error.message, 'error');
                    console.error('❌ Error saving changes:', error);
                }} finally {{
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save All';
                    this.updateStatus();
                }}
            }}
            
            revertAllChanges() {{
                if (!confirm('Revert all unsaved changes?')) return;
                
                // Revert all changes
                for (const [elementId, change] of this.pendingChanges) {{
                    if (change.type === 'edit') {{
                        const originalContent = this.originalContent.get(elementId);
                        if (originalContent) {{
                            change.element.textContent = originalContent;
                            change.element.dataset.originalText = originalContent;
                        }}
                        change.element.classList.remove('element-modified');
                        
                    }} else if (change.type === 'delete') {{
                        change.element.classList.remove('element-deleted');
                        this.deletedElements.delete(elementId);
                    }}
                }}
                
                // Clear all tracking
                this.pendingChanges.clear();
                this.originalContent.clear();
                this.changeOrder = [];
                this.undoneChanges = [];
                
                // Clear localStorage
                localStorage.removeItem(`editor_changes_${{FILE_PATH}}`);
                
                this.showNotification('All changes reverted', 'success');
                console.log('↩️ All changes reverted');
                this.updateStatus();
            }}
            
            showNotification(message, type) {{
                const notification = document.createElement('div');
                notification.className = `editor-notification ${{type}}`;
                notification.textContent = message;
                
                document.body.appendChild(notification);
                
                setTimeout(() => {{
                    notification.remove();
                }}, 3000);
            }}
        }}
        
        // Initialize editor when DOM is loaded
        document.addEventListener('DOMContentLoaded', () => {{
            new VisualHtmlEditor();
        }});
    </script>
    """
    
    # Inject CSS and JS
    if soup.head:
        soup.head.append(BeautifulSoup(editor_css, 'html.parser'))
    
    if soup.body:
        soup.body.append(BeautifulSoup(editor_js, 'html.parser'))
    
    return str(soup)