"""
Presentation Styles Configuration
Contains all visual style definitions for the presentation tool.
Each style includes colors, fonts, and characteristics.
"""

from typing import Dict, Any

PRESENTATION_STYLES: Dict[str, Dict[str, Any]] = {
    "default": {
        "name": "Default",
        "description": "Clean Inter black/white theme - perfect starting point",
        "primary_color": "#000000",
        "accent_color": "#666666",
        "background": "#FFFFFF",
        "text_color": "#000000",
        "font_family": "'Inter', '-apple-system', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap",
        "font": "Inter (clean sans-serif)",
        "characteristics": ["Clean black/white", "Modern Inter font", "Minimal design", "Professional default", "Universal appeal"]
    },
    "velvet": {
        "name": "Velvet",
        "description": "Luxurious dark theme with rich purples and gold accents",
        "primary_color": "#6B46C1",
        "accent_color": "#F59E0B",
        "background": "#1F2937",
        "text_color": "#F9FAFB",
        "font_family": "'Playfair Display', 'Georgia', serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&display=swap",
        "font": "Playfair Display (elegant serif)",
        "characteristics": ["Dark elegant background", "Purple and gold palette", "Luxury feel", "High contrast", "Elegant serif typography"]
    },
    "glacier": {
        "name": "Glacier",
        "description": "Cool and clean with icy blues and crisp whites",
        "primary_color": "#0EA5E9",
        "accent_color": "#06B6D4",
        "background": "#F0F9FF",
        "text_color": "#0F172A",
        "font_family": "'Inter', 'Helvetica Neue', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap",
        "font": "Inter (modern sans-serif)",
        "characteristics": ["Cool blue tones", "Ice-inspired palette", "Clean and fresh", "Professional clarity", "Modern sans-serif"]
    },
    "ember": {
        "name": "Ember",
        "description": "Warm and energetic with fiery oranges and deep reds",
        "primary_color": "#EA580C",
        "accent_color": "#DC2626",
        "background": "#FFF7ED",
        "text_color": "#1C1917",
        "font_family": "'Oswald', 'Arial Black', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&display=swap",
        "font": "Oswald (bold display font)",
        "characteristics": ["Warm orange-red palette", "Energetic feel", "Bold and confident", "High impact", "Strong display typography"]
    },
    "sage": {
        "name": "Sage",
        "description": "Natural and calming with earth greens and soft browns",
        "primary_color": "#059669",
        "accent_color": "#92400E",
        "background": "#F0FDF4",
        "text_color": "#14532D",
        "font_family": "'Lora', 'Times New Roman', serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap",
        "font": "Lora (readable serif)",
        "characteristics": ["Nature-inspired greens", "Earthy and organic", "Calming presence", "Sustainability themes", "Readable serif font"]
    },
    "obsidian": {
        "name": "Obsidian",
        "description": "Sleek and modern with deep blacks and electric blue accents",
        "primary_color": "#1E40AF",
        "accent_color": "#3B82F6",
        "background": "#111827",
        "text_color": "#F9FAFB",
        "font_family": "'JetBrains Mono', 'Courier New', monospace",
        "font_import": "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap",
        "font": "JetBrains Mono (tech monospace)",
        "characteristics": ["Modern dark theme", "Tech-inspired", "High contrast", "Professional edge", "Monospace coding font"]
    },
    "coral": {
        "name": "Coral",
        "description": "Vibrant and tropical with coral pinks and ocean blues",
        "primary_color": "#EC4899",
        "accent_color": "#0891B2",
        "background": "#FDF2F8",
        "text_color": "#1F2937",
        "font_family": "'Poppins', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap",
        "font": "Poppins (friendly rounded)",
        "characteristics": ["Tropical color palette", "Vibrant and lively", "Creative energy", "Playful professional", "Friendly rounded font"]
    },
    "platinum": {
        "name": "Platinum",
        "description": "Sophisticated monochrome with silver accents and clean typography",
        "primary_color": "#6B7280",
        "accent_color": "#9CA3AF",
        "background": "#FFFFFF",
        "text_color": "#111827",
        "font_family": "'Source Sans Pro', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@300;400;600;700&display=swap",
        "font": "Source Sans Pro (professional)",
        "characteristics": ["Sophisticated grays", "Minimalist elegance", "Timeless appeal", "Premium feel", "Professional typography"]
    },
    "aurora": {
        "name": "Aurora",
        "description": "Magical gradients with northern lights inspired colors",
        "primary_color": "#8B5CF6",
        "accent_color": "#10B981",
        "background": "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        "text_color": "#FFFFFF",
        "font_family": "'Montserrat', 'Helvetica', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap",
        "font": "Montserrat (modern geometric)",
        "characteristics": ["Gradient backgrounds", "Purple-green palette", "Mystical feel", "Creative inspiration", "Geometric sans-serif"]
    },
    "midnight": {
        "name": "Midnight",
        "description": "Professional dark mode with navy blues and crisp whites",
        "primary_color": "#1E3A8A",
        "accent_color": "#3B82F6",
        "background": "#0F172A",
        "text_color": "#F8FAFC",
        "font_family": "'Roboto Slab', 'Times', serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Roboto+Slab:wght@300;400;500;600;700&display=swap",
        "font": "Roboto Slab (structured serif)",
        "characteristics": ["Dark professional theme", "Navy blue focus", "Executive feel", "Easy on eyes", "Structured slab serif"]
    },
    "citrus": {
        "name": "Citrus",
        "description": "Fresh and energetic with bright yellows and lime greens",
        "primary_color": "#EAB308",
        "accent_color": "#65A30D",
        "background": "#FFFBEB",
        "text_color": "#1C1917",
        "font_family": "'Quicksand', 'Verdana', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Quicksand:wght@300;400;500;600;700&display=swap",
        "font": "Quicksand (light and airy)",
        "characteristics": ["Bright and energetic", "Yellow-green palette", "Optimistic feel", "Innovation themes", "Light rounded font"]
    },
    "silicon": {
        "name": "Silicon",
        "description": "Apple-inspired ultra-clean minimalism with perfect spacing",
        "primary_color": "#1D1D1F",
        "accent_color": "#007AFF",
        "background": "#FAFAFA",
        "text_color": "#1D1D1F",
        "font_family": "'-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap",
        "font": "SF Pro Display (Apple system)",
        "characteristics": ["Ultra-clean design", "Apple aesthetics", "Perfect typography", "Minimal distractions", "Premium feel"]
    },
    "vercel": {
        "name": "Vercel",
        "description": "Modern developer-focused design with sharp contrasts",
        "primary_color": "#000000",
        "accent_color": "#0070F3",
        "background": "#FFFFFF",
        "text_color": "#000000",
        "font_family": "'Inter', '-apple-system', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap",
        "font": "Inter (modern web)",
        "characteristics": ["Developer-focused", "Sharp black/white", "Modern spacing", "Tech industry", "Clean geometry"]
    },
    "legal": {
        "name": "Legal",
        "description": "Sophisticated law firm style with traditional authority",
        "primary_color": "#1A202C",
        "accent_color": "#B8860B",
        "background": "#FFFFFF",
        "text_color": "#2D3748",
        "font_family": "'Crimson Text', 'Times New Roman', serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Crimson+Text:wght@400;600;700&display=swap",
        "font": "Crimson Text (traditional serif)",
        "characteristics": ["Professional authority", "Traditional colors", "Trustworthy feel", "Legal industry", "Serif elegance"]
    },
    "investment": {
        "name": "Investment",
        "description": "Premium investment bank style with financial gravitas",
        "primary_color": "#1A365D",
        "accent_color": "#C53030",
        "background": "#F7FAFC",
        "text_color": "#1A202C",
        "font_family": "'IBM Plex Sans', 'Helvetica', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap",
        "font": "IBM Plex Sans (corporate)",
        "characteristics": ["Financial gravitas", "Conservative colors", "Data-focused", "Banking industry", "Corporate trust"]
    },
    "luxury": {
        "name": "Luxury",
        "description": "High-end luxury brand aesthetics with premium materials",
        "primary_color": "#2C1810",
        "accent_color": "#DAA520",
        "background": "#FDF8F3",
        "text_color": "#2C1810",
        "font_family": "'Libre Baskerville', 'Georgia', serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&display=swap",
        "font": "Libre Baskerville (luxury serif)",
        "characteristics": ["Luxury aesthetics", "Premium materials", "Rich textures", "Exclusive feel", "High-end branding"]
    },
    "minimal": {
        "name": "Minimal",
        "description": "Ultra-minimalist design with perfect negative space",
        "primary_color": "#000000",
        "accent_color": "#666666",
        "background": "#FFFFFF",
        "text_color": "#000000",
        "font_family": "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&display=swap",
        "font": "Helvetica Neue (minimal)",
        "characteristics": ["Ultra-minimal", "Perfect spacing", "No distractions", "Pure content focus", "Timeless design"]
    },
    "medical": {
        "name": "Medical",
        "description": "Healthcare-focused design with trust and clarity",
        "primary_color": "#2B6CB0",
        "accent_color": "#38A169",
        "background": "#F7FAFC",
        "text_color": "#2D3748",
        "font_family": "'Open Sans', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&display=swap",
        "font": "Open Sans (healthcare)",
        "characteristics": ["Healthcare trust", "Clear communication", "Calming colors", "Medical industry", "Accessible design"]
    },
    "startup": {
        "name": "Startup",
        "description": "Y Combinator-inspired startup energy and disruption",
        "primary_color": "#FF6600",
        "accent_color": "#000000",
        "background": "#FFFFFF",
        "text_color": "#000000",
        "font_family": "'SF Pro Display', 'Helvetica Neue', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
        "font": "SF Pro Display (startup)",
        "characteristics": ["Startup energy", "Disruptive feel", "Bold statements", "Innovation focus", "Silicon Valley"]
    },
    "academic": {
        "name": "Academic",
        "description": "University research style with scholarly authority",
        "primary_color": "#2C5282",
        "accent_color": "#B83280",
        "background": "#F7FAFC",
        "text_color": "#2D3748",
        "font_family": "'Merriweather', 'Georgia', serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&display=swap",
        "font": "Merriweather (scholarly)",
        "characteristics": ["Scholarly authority", "Research-focused", "Academic tradition", "Knowledge-based", "Educational clarity"]
    },
    "vintage": {
        "name": "Vintage",
        "description": "Retro magazine aesthetic with nostalgic appeal",
        "primary_color": "#8B4513",
        "accent_color": "#FF8C00",
        "background": "#F5DEB3",
        "text_color": "#2F4F4F",
        "font_family": "'Bebas Neue', 'Arial Black', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap",
        "font": "Bebas Neue (retro display)",
        "characteristics": ["Retro aesthetic", "Magazine style", "Nostalgic colors", "Bold typography", "Vintage charm"]
    },
    "pencil": {
        "name": "Pencil",
        "description": "Hand-drawn creative style with artistic flair",
        "primary_color": "#2F2F2F",
        "accent_color": "#696969",
        "background": "#FEFEFE",
        "text_color": "#2F2F2F",
        "font_family": "'Caveat', 'Comic Sans MS', cursive",
        "font_import": "https://fonts.googleapis.com/css2?family=Caveat:wght@400;600;700&display=swap",
        "font": "Caveat (handwritten)",
        "characteristics": ["Hand-drawn feel", "Creative energy", "Artistic approach", "Casual professional", "Sketch aesthetic"]
    },
    "frost": {
        "name": "Frost",
        "description": "Clean business data style with crisp presentation",
        "primary_color": "#1E3A8A",
        "accent_color": "#3B82F6",
        "background": "#F8FAFC",
        "text_color": "#1E293B",
        "font_family": "'Work Sans', 'Helvetica', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Work+Sans:wght@300;400;500;600&display=swap",
        "font": "Work Sans (business)",
        "characteristics": ["Clean data focus", "Business clarity", "Professional blue", "Chart-friendly", "Corporate clean"]
    },
    "sky": {
        "name": "Sky",
        "description": "Soft blue gallery style with gentle aesthetics",
        "primary_color": "#0369A1",
        "accent_color": "#0EA5E9",
        "background": "#E0F2FE",
        "text_color": "#0C4A6E",
        "font_family": "'Nunito Sans', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@300;400;600;700&display=swap",
        "font": "Nunito Sans (friendly)",
        "characteristics": ["Soft blue tones", "Gallery style", "Gentle aesthetics", "Calming presence", "Light and airy"]
    },
    "clean": {
        "name": "Clean",
        "description": "Ultra-clean minimalist with perfect simplicity",
        "primary_color": "#1F2937",
        "accent_color": "#6B7280",
        "background": "#F9FAFB",
        "text_color": "#111827",
        "font_family": "'DM Sans', 'Helvetica', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap",
        "font": "DM Sans (clean)",
        "characteristics": ["Ultra-clean", "Perfect simplicity", "Minimal elements", "Pure design", "Content focus"]
    },
    "forest": {
        "name": "Forest",
        "description": "Rich green nature theme with organic appeal",
        "primary_color": "#065F46",
        "accent_color": "#10B981",
        "background": "#064E3B",
        "text_color": "#ECFDF5",
        "font_family": "'Fira Sans', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Fira+Sans:wght@300;400;500;600&display=swap",
        "font": "Fira Sans (natural)",
        "characteristics": ["Nature-inspired", "Rich greens", "Organic feel", "Environmental themes", "Natural harmony"]
    },
    "electric": {
        "name": "Electric",
        "description": "Vibrant colorful energy with dynamic gradients",
        "primary_color": "#DB2777",
        "accent_color": "#06B6D4",
        "background": "linear-gradient(135deg, #1E1B4B 0%, #7C3AED 50%, #DB2777 100%)",
        "text_color": "#F8FAFC",
        "font_family": "'Space Grotesk', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap",
        "font": "Space Grotesk (dynamic)",
        "characteristics": ["Vibrant energy", "Dynamic gradients", "Electric colors", "High impact", "Creative bold"]
    },
    "bronze": {
        "name": "Bronze",
        "description": "Warm brown metallic with rich earth tones",
        "primary_color": "#92400E",
        "accent_color": "#D97706",
        "background": "#78350F",
        "text_color": "#FEF3C7",
        "font_family": "'Spectral', 'Georgia', serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Spectral:wght@300;400;600;700&display=swap",
        "font": "Spectral (warm serif)",
        "characteristics": ["Warm metallics", "Earth tones", "Rich browns", "Natural warmth", "Sophisticated depth"]
    },
    "slate": {
        "name": "Slate",
        "description": "Professional dark theme with modern sophistication",
        "primary_color": "#FFFFFF",
        "accent_color": "#D1D5DB",
        "background": "#1F2937",
        "text_color": "#F9FAFB",
        "font_family": "'Inter', 'Helvetica', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap",
        "font": "Inter (professional)",
        "characteristics": ["Professional dark", "Modern sophistication", "Clean contrast", "Executive style", "Contemporary edge"]
    },
    "dune": {
        "name": "Dune",
        "description": "Charts and data focus with analytical clarity",
        "primary_color": "#0F766E",
        "accent_color": "#F59E0B",
        "background": "#FFFBEB",
        "text_color": "#0F172A",
        "font_family": "'IBM Plex Sans', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;606&display=swap",
        "font": "IBM Plex Sans (data)",
        "characteristics": ["Data focused", "Analytical clarity", "Chart optimization", "Information design", "Clear metrics"]
    },
    "crimson": {
        "name": "Crimson",
        "description": "Bold business presentation with strong impact",
        "primary_color": "#7C2D12",
        "accent_color": "#DC2626",
        "background": "#FEF2F2",
        "text_color": "#450A0A",
        "font_family": "'Roboto', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap",
        "font": "Roboto (bold business)",
        "characteristics": ["Bold impact", "Strong presence", "Business authority", "Confident red", "Executive power"]
    },
    "canvas": {
        "name": "Canvas",
        "description": "Natural business style with organic professionalism",
        "primary_color": "#374151",
        "accent_color": "#F59E0B",
        "background": "#F9FAFB",
        "text_color": "#1F2937",
        "font_family": "'Source Sans Pro', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@300;400;600&display=swap",
        "font": "Source Sans Pro (natural)",
        "characteristics": ["Natural business", "Organic professional", "Warm neutrals", "Comfortable style", "Approachable corporate"]
    },
    "paper": {
        "name": "Paper",
        "description": "Magazine editorial style with literary sophistication",
        "primary_color": "#6B7280",
        "accent_color": "#3B82F6",
        "background": "#F3F4F6",
        "text_color": "#1F2937",
        "font_family": "'Playfair Display', 'Georgia', serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;700&display=swap",
        "font": "Playfair Display (editorial)",
        "characteristics": ["Editorial style", "Literary sophistication", "Magazine quality", "Reading focus", "Publishing aesthetic"]
    },
    "golden": {
        "name": "Golden",
        "description": "Warm gallery aesthetic with luxurious appeal",
        "primary_color": "#C2410C",
        "accent_color": "#FBBF24",
        "background": "#FEF3C7",
        "text_color": "#92400E",
        "font_family": "'Outfit', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&display=swap",
        "font": "Outfit (warm modern)",
        "characteristics": ["Warm luxury", "Gallery aesthetic", "Golden tones", "Rich warmth", "Premium appeal"]
    },
    "azure": {
        "name": "Azure",
        "description": "Professional blue charts with analytical precision",
        "primary_color": "#1E40AF",
        "accent_color": "#60A5FA",
        "background": "#EFF6FF",
        "text_color": "#1E3A8A",
        "font_family": "'Public Sans', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Public+Sans:wght@300;400;500;600&display=swap",
        "font": "Public Sans (analytical)",
        "characteristics": ["Professional blue", "Chart optimization", "Analytical precision", "Data visualization", "Corporate analytics"]
    },
    "timber": {
        "name": "Timber",
        "description": "Rich wood magazine style with natural luxury",
        "primary_color": "#B45309",
        "accent_color": "#F59E0B",
        "background": "#451A03",
        "text_color": "#FEF3C7",
        "font_family": "'Crimson Pro', 'Georgia', serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@300;400;600&display=swap",
        "font": "Crimson Pro (rich serif)",
        "characteristics": ["Rich wood tones", "Natural luxury", "Magazine sophistication", "Warm elegance", "Organic premium"]
    },
    "orchid": {
        "name": "Orchid",
        "description": "Soft purple elegance with delicate sophistication",
        "primary_color": "#7C3AED",
        "accent_color": "#A78BFA",
        "background": "#F3E8FF",
        "text_color": "#581C87",
        "font_family": "'Comfortaa', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Comfortaa:wght@300;400;500;700&display=swap",
        "font": "Comfortaa (soft elegant)",
        "characteristics": ["Soft elegance", "Purple sophistication", "Delicate beauty", "Gentle luxury", "Refined aesthetic"]
    },
    "ocean": {
        "name": "Ocean",
        "description": "Deep blue minimalist with technical precision",
        "primary_color": "#06B6D4",
        "accent_color": "#0891B2",
        "background": "#164E63",
        "text_color": "#CFFAFE",
        "font_family": "'JetBrains Mono', 'Courier New', monospace",
        "font_import": "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&display=swap",
        "font": "JetBrains Mono (tech precise)",
        "characteristics": ["Deep blue theme", "Technical precision", "Ocean depths", "Developer focus", "Code-friendly"]
    },
    "honey": {
        "name": "Honey",
        "description": "Warm amber tones with natural sweetness",
        "primary_color": "#D97706",
        "accent_color": "#F59E0B",
        "background": "#FEF3C7",
        "text_color": "#92400E",
        "font_family": "'Epilogue', 'Arial', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Epilogue:wght@300;400;500;600&display=swap",
        "font": "Epilogue (warm modern)",
        "characteristics": ["Warm amber", "Natural sweetness", "Golden honey", "Organic warmth", "Gentle luxury"]
    },
    "crystal": {
        "name": "Crystal",
        "description": "Pure clean charts with crystal clarity",
        "primary_color": "#334155",
        "accent_color": "#64748B",
        "background": "#FFFFFF",
        "text_color": "#0F172A",
        "font_family": "'Inter', 'Helvetica', sans-serif",
        "font_import": "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap",
        "font": "Inter (crystal clear)",
        "characteristics": ["Crystal clarity", "Pure clean design", "Chart perfection", "Data precision", "Transparent elegance"]
    }
}

def get_style_config(style_name: str) -> Dict[str, Any]:
    """Get style configuration for a given style name"""
    return PRESENTATION_STYLES.get(style_name, PRESENTATION_STYLES["default"])

def get_all_styles() -> Dict[str, Dict[str, Any]]:
    """Get all available styles"""
    return PRESENTATION_STYLES

def get_style_names() -> list[str]:
    """Get list of all available style names"""
    return list(PRESENTATION_STYLES.keys())
