export const FolderIcon = () => (
    <svg viewBox="0 0 64 64" className="w-full h-full">
      <defs>
        <linearGradient id="folderMainBrowser" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#60A5FA" />
          <stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
        <linearGradient id="folderTopBrowser" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#93C5FD" />
          <stop offset="100%" stopColor="#60A5FA" />
        </linearGradient>
      </defs>
      <rect x="4" y="18" width="56" height="40" rx="6" fill="url(#folderMainBrowser)"/>
      <path d="M4 24 Q4 18 10 18 L24 18 L28 14 Q30 12 34 12 L54 12 Q60 12 60 18 L60 22 L4 22 Z" fill="url(#folderTopBrowser)"/>
      <rect x="4" y="22" width="56" height="4" fill="rgba(255,255,255,0.15)"/>
    </svg>
  );
  
export const CodeFileIcon = () => (
    <svg viewBox="0 0 64 64" className="w-full h-full">
      <defs>
        <linearGradient id="codeModernBrowser" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#22D3EE" />
          <stop offset="50%" stopColor="#818CF8" />
          <stop offset="100%" stopColor="#C084FC" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="52" height="52" rx="12" fill="url(#codeModernBrowser)"/>
      <path d="M22 22 L12 32 L22 42" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <path d="M42 22 L52 32 L42 42" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <line x1="36" y1="18" x2="28" y2="46" stroke="rgba(255,255,255,0.6)" strokeWidth="3" strokeLinecap="round"/>
    </svg>
  );
  
export const ImageFileIcon = () => (
    <svg viewBox="0 0 64 64" className="w-full h-full">
      <defs>
        <linearGradient id="imgModernBrowser" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F472B6" />
          <stop offset="50%" stopColor="#A855F7" />
          <stop offset="100%" stopColor="#6366F1" />
        </linearGradient>
      </defs>
      <rect x="6" y="10" width="52" height="44" rx="8" fill="url(#imgModernBrowser)"/>
      <circle cx="22" cy="26" r="7" fill="rgba(255,255,255,0.85)"/>
      <path d="M10 46 L22 32 L32 42 L42 30 L54 46 Q54 52 50 54 L14 54 Q10 54 10 50 Z" fill="rgba(255,255,255,0.25)"/>
    </svg>
  );
  
export const DocumentFileIcon = () => (
    <svg viewBox="0 0 64 64" className="w-full h-full">
      <defs>
        <linearGradient id="docModernBrowser" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#F8FAFC" />
          <stop offset="100%" stopColor="#E2E8F0" />
        </linearGradient>
      </defs>
      <rect x="10" y="4" width="44" height="56" rx="6" fill="url(#docModernBrowser)" stroke="#CBD5E1" strokeWidth="1"/>
      <rect x="18" y="16" width="28" height="2.5" rx="1" fill="#64748B"/>
      <rect x="18" y="23" width="22" height="2.5" rx="1" fill="#94A3B8"/>
      <rect x="18" y="30" width="26" height="2.5" rx="1" fill="#94A3B8"/>
      <rect x="18" y="37" width="20" height="2.5" rx="1" fill="#94A3B8"/>
      <rect x="18" y="44" width="24" height="2.5" rx="1" fill="#94A3B8"/>
    </svg>
  );
  
export const GenericFileIcon = () => (
    <svg viewBox="0 0 64 64" className="w-full h-full">
      <defs>
        <linearGradient id="genModernBrowser" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#E2E8F0" />
          <stop offset="100%" stopColor="#CBD5E1" />
        </linearGradient>
      </defs>
      <rect x="10" y="4" width="44" height="56" rx="6" fill="url(#genModernBrowser)"/>
      <rect x="18" y="20" width="28" height="3" rx="1.5" fill="#94A3B8"/>
      <rect x="18" y="28" width="22" height="3" rx="1.5" fill="#94A3B8"/>
      <rect x="18" y="36" width="26" height="3" rx="1.5" fill="#94A3B8"/>
      <rect x="18" y="44" width="18" height="3" rx="1.5" fill="#94A3B8"/>
    </svg>
  );