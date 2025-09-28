import React from 'react';
import { useAuth } from '@/components/AuthProvider';
import { fetchFileContent } from '@/hooks/react-query/files/use-file-queries';

declare global {
  interface Window {
    XLSX?: any;
    luckysheet?: any;
    $?: any;
    jQuery?: any;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(s);
  });
}

function loadStyle(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

function argbToHex(argb?: string | number): string | undefined {
  if (!argb) return undefined;
  
  if (typeof argb === 'number') {
    const indexColors: Record<number, string> = {
      0: '#000000', 1: '#FFFFFF', 2: '#FF0000', 3: '#00FF00',
      4: '#0000FF', 5: '#FFFF00', 6: '#FF00FF', 7: '#00FFFF',
      8: '#000000', 9: '#FFFFFF', 10: '#FF0000', 11: '#00FF00',
      12: '#0000FF', 13: '#FFFF00', 14: '#FF00FF', 15: '#00FFFF',
      16: '#800000', 17: '#008000', 18: '#000080', 19: '#808000',
      20: '#800080', 21: '#008080', 22: '#C0C0C0', 23: '#808080',
      24: '#9999FF', 25: '#993366', 26: '#FFFFCC', 27: '#CCFFFF',
      28: '#660066', 29: '#FF8080', 30: '#0066CC', 31: '#CCCCFF',
      32: '#000080', 33: '#FF00FF', 34: '#FFFF00', 35: '#00FFFF',
      36: '#800080', 37: '#800000', 38: '#008080', 39: '#0000FF',
      40: '#00CCFF', 41: '#CCFFFF', 42: '#CCFFCC', 43: '#FFFF99',
      44: '#99CCFF', 45: '#FF99CC', 46: '#CC99FF', 47: '#FFCC99',
      48: '#3366FF', 49: '#33CCCC', 50: '#99CC00', 51: '#FFCC00',
      52: '#FF9900', 53: '#FF6600', 54: '#666699', 55: '#969696',
      56: '#003366', 57: '#339966', 58: '#003300', 59: '#333300',
      60: '#993300', 61: '#993366', 62: '#333399', 63: '#333333',
      64: '#000000', 65: '#FFFFFF'
    };
    return indexColors[argb] || undefined;
  }
  
  const v = String(argb).replace(/^#/, '').toUpperCase();
  if (v.length === 8) {
    return `#${v.slice(2)}`;
  }
  if (v.length === 6) {
    return `#${v}`;
  }
  if (v.startsWith('FF')) {
    return `#${v.slice(2)}`;
  }
  return undefined;
}

function mapType(t: string | undefined): string {
  switch (t) {
    case 'n': 
    case 'd': 
    case 'b': 
    case 's': 
    case 'str':
    case 'e': 
      return t;
    default:
      return 'g'; 
  }
}

function convertNumberFormat(fmt?: string): string {
  if (!fmt) return 'General';
  const formatMap: Record<string, string> = {
    '0': '#,##0',
    '0.00': '#,##0.00',
    '#,##0': '#,##0',
    '#,##0.00': '#,##0.00',
    '$#,##0.00': '$#,##0.00',
    '0%': '0%',
    '0.00%': '0.00%',
    'mm/dd/yyyy': 'MM/DD/YYYY',
    'dd/mm/yyyy': 'DD/MM/YYYY',
    'yyyy-mm-dd': 'YYYY-MM-DD',
  };
  return formatMap[fmt] || fmt;
}

function extractBorders(borders: any): any {
  if (!borders) return null;
  const borderConfig: any = {};
  
  if (borders.top) {
    borderConfig.t = {
      style: borders.top.style === 'thin' ? 1 : 2,
      color: argbToHex(borders.top.color?.rgb) || '#000000'
    };
  }
  if (borders.bottom) {
    borderConfig.b = {
      style: borders.bottom.style === 'thin' ? 1 : 2,
      color: argbToHex(borders.bottom.color?.rgb) || '#000000'
    };
  }
  if (borders.left) {
    borderConfig.l = {
      style: borders.left.style === 'thin' ? 1 : 2,
      color: argbToHex(borders.left.color?.rgb) || '#000000'
    };
  }
  if (borders.right) {
    borderConfig.r = {
      style: borders.right.style === 'thin' ? 1 : 2,
      color: argbToHex(borders.right.color?.rgb) || '#000000'
    };
  }
  
  return Object.keys(borderConfig).length > 0 ? borderConfig : null;
}

export interface LuckysheetViewerProps {
  xlsxPath: string;
  sandboxId?: string;
  className?: string;
  height?: number | string;
}

export function LuckysheetViewer({ xlsxPath, sandboxId, className, height }: LuckysheetViewerProps) {
  const { session } = useAuth();
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const containerIdRef = React.useRef<string>(`luckysheet-${Math.random().toString(36).slice(2)}`);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [measuredHeight, setMeasuredHeight] = React.useState<number>(0);

  React.useEffect(() => {
    const el = wrapperRef.current;
    if (!el || height) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setMeasuredHeight(Math.max(0, rect.height));
      try { window.luckysheet?.resize?.(); } catch {}
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    setMeasuredHeight(Math.max(0, rect.height));
    return () => ro.disconnect();
  }, [height]);

  React.useEffect(() => {
    let disposed = false;
    async function init() {
      try {
        setLoading(true);
        setError(null);
        
        loadStyle('https://cdn.jsdelivr.net/npm/luckysheet@latest/dist/plugins/css/pluginsCss.css');
        loadStyle('https://cdn.jsdelivr.net/npm/luckysheet@latest/dist/plugins/plugins.css');
        loadStyle('https://cdn.jsdelivr.net/npm/luckysheet@latest/dist/css/luckysheet.css');
        loadStyle('https://cdn.jsdelivr.net/npm/luckysheet@latest/dist/fonts/iconfont.css');

        await loadScript('https://cdn.jsdelivr.net/npm/jquery@3.6.4/dist/jquery.min.js');
        if (!window.$ && (window as any).jQuery) window.$ = (window as any).jQuery;
        await loadScript('https://cdn.jsdelivr.net/npm/jquery-mousewheel@3.1.13/jquery.mousewheel.min.js');
        await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
        await loadScript('https://cdn.jsdelivr.net/npm/luckysheet@latest/dist/plugins/js/plugin.js');
        await loadScript('https://cdn.jsdelivr.net/npm/luckysheet@latest/dist/luckysheet.umd.js');
        if (disposed) return;

        let ab: ArrayBuffer;
        if (sandboxId && session?.access_token) {
          const blob = (await fetchFileContent(
            sandboxId,
            xlsxPath,
            'blob',
            session.access_token
          )) as Blob;
          ab = await blob.arrayBuffer();
        } else {
          const resp = await fetch(xlsxPath);
          if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
          ab = await resp.arrayBuffer();
        }

        const XLSX = window.XLSX;
        const wb = XLSX.read(ab, { 
          type: 'array', 
          cellStyles: true,  
          cellDates: true,   
          cellNF: true,      
          sheetStubs: true,  
          raw: false         
        });

        const sheetsForLucky: any[] = [];

        wb.SheetNames.forEach((name: string, idx: number) => {
          const ws = wb.Sheets[name];
          const ref = ws['!ref'] || 'A1:A1';
          const range = XLSX.utils.decode_range(ref);

          const celldata: any[] = [];
          for (let r = range.s.r; r <= range.e.r; r++) {
            for (let c = range.s.c; c <= range.e.c; c++) {
              const addr = XLSX.utils.encode_cell({ r, c });
              const cell = ws[addr];
              if (!cell) continue;
              
              const v: any = {
                v: cell.v,
                m: (cell.w ?? String(cell.v ?? '')),
                ct: { 
                  t: mapType(cell.t), 
                  fa: convertNumberFormat(cell.z) || 'General' 
                },
              };
              
              const cellStyle = cell.s || {};
              const isHeader = r === 0;
              
              if (cellStyle && typeof cellStyle === 'object') {
                if (cellStyle.fgColor || cellStyle.bgColor || cellStyle.patternType) {
                  let bgColor = null;
                  if (cellStyle.fgColor?.rgb) {
                    bgColor = cellStyle.fgColor.rgb;
                  } else if (cellStyle.bgColor?.rgb) {
                    bgColor = cellStyle.bgColor.rgb;
                  }
                  
                  if (bgColor) {
                    bgColor = bgColor.replace(/^#/, '').toUpperCase();
                    if (bgColor.length === 8) {
                      bgColor = '#' + bgColor.slice(2);
                    } else if (bgColor.length === 6) {
                      bgColor = '#' + bgColor;
                    }
                    if (bgColor.startsWith('#') && bgColor.length === 7) {
                      v.bg = bgColor;
                    }
                  }
                }
                
                if (cellStyle.font) {
                  if (cellStyle.font.bold) v.bl = 1;
                  if (cellStyle.font.italic) v.it = 1;
                  if (cellStyle.font.underline) v.un = 1;
                  if (cellStyle.font.strike) v.cl = 1;
                  if (cellStyle.font.sz) v.fs = Math.round(Number(cellStyle.font.sz));
                  if (cellStyle.font.name) v.ff = cellStyle.font.name;
                  if (cellStyle.font.color?.rgb) {
                    let fc = cellStyle.font.color.rgb;
                    fc = fc.replace(/^#/, '').toUpperCase();
                    if (fc.length === 8) {
                      fc = '#' + fc.slice(2);
                    } else if (fc.length === 6) {
                      fc = '#' + fc;
                    }
                    if (fc.startsWith('#') && fc.length === 7) {
                      v.fc = fc;
                    }
                  }
                }
                
                if (cellStyle.alignment) {
                  const htMap: Record<string, number> = {
                    'left': 1,
                    'center': 0,
                    'right': 2,
                  };
                  const vtMap: Record<string, number> = {
                    'top': 0,
                    'middle': 1,
                    'center': 1,
                    'bottom': 2,
                  };
                  if (cellStyle.alignment.horizontal) {
                    v.ht = htMap[cellStyle.alignment.horizontal] ?? 0;
                  }
                  if (cellStyle.alignment.vertical) {
                    v.vt = vtMap[cellStyle.alignment.vertical] ?? 1;
                  }
                  if (cellStyle.alignment.wrapText) v.tb = 2;
                }
              }
              if (typeof cellStyle === 'number' && wb.Styles) {
                const xfIndex = cellStyle;
                if (wb.Styles.CellXf && wb.Styles.CellXf[xfIndex]) {
                  const xf = wb.Styles.CellXf[xfIndex];
                  
                  if (xf.fontId !== undefined && wb.Styles.Fonts && wb.Styles.Fonts[xf.fontId]) {
                    const font = wb.Styles.Fonts[xf.fontId];
                    if (font.bold) v.bl = 1;
                    if (font.italic) v.it = 1;
                    if (font.underline) v.un = 1;
                    if (font.strike) v.cl = 1;
                    if (font.sz) v.fs = Math.round(Number(font.sz));
                    if (font.name) v.ff = font.name;
                    if (font.color?.rgb) {
                      let fc = font.color.rgb;
                      fc = fc.replace(/^#/, '').toUpperCase();
                      if (fc.length === 8) {
                        fc = '#' + fc.slice(2);
                      } else if (fc.length === 6) {
                        fc = '#' + fc;
                      }
                      if (fc.startsWith('#') && fc.length === 7) {
                        v.fc = fc;
                      }
                    }
                  }
                  
                  if (xf.fillId !== undefined && xf.fillId > 0 && wb.Styles.Fills && wb.Styles.Fills[xf.fillId]) {
                    const fill = wb.Styles.Fills[xf.fillId];
                    if (fill.fgColor?.rgb || fill.bgColor?.rgb) {
                      let bg = fill.fgColor?.rgb || fill.bgColor?.rgb;
                      bg = bg.replace(/^#/, '').toUpperCase();
                      if (bg.length === 8) {
                        bg = '#' + bg.slice(2);
                      } else if (bg.length === 6) {
                        bg = '#' + bg;
                      }
                      if (bg.startsWith('#') && bg.length === 7) {
                        v.bg = bg;
                      }
                    }
                  }
                  
                  if (xf.alignment) {
                    const htMap: Record<string, number> = {
                      'left': 1,
                      'center': 0,
                      'right': 2,
                    };
                    const vtMap: Record<string, number> = {
                      'top': 0,
                      'middle': 1,
                      'center': 1,
                      'bottom': 2,
                    };
                    if (xf.alignment.horizontal) {
                      v.ht = htMap[xf.alignment.horizontal] ?? 0;
                    }
                    if (xf.alignment.vertical) {
                      v.vt = vtMap[xf.alignment.vertical] ?? 1;
                    }
                    if (xf.alignment.wrapText) v.tb = 2;
                  }
                }
              }
              
              if (isHeader) {
                v.bl = 1; 
              }
              celldata.push({ r, c, v });
            }
          }

          const mergeConfig: Record<string, any> = {};
          const merges = ws['!merges'] || [];
          merges.forEach((m: any) => {
            const rs = m.e.r - m.s.r + 1;
            const cs = m.e.c - m.s.c + 1;
            mergeConfig[`${m.s.r}_${m.s.c}`] = { r: m.s.r, c: m.s.c, rs, cs };
          });

          const columnlen: Record<number, number> = {};
          const cols = ws['!cols'] || [];
          cols.forEach((col: any, i: number) => {
            const wpx = col.wpx || (col.wch ? Math.round(col.wch * 7.5) : col.width ? col.width * 7 : undefined);
            if (wpx) columnlen[i] = wpx;
          });

          const rowlen: Record<number, number> = {};
          const rows = ws['!rows'] || [];
          rows.forEach((row: any, i: number) => {
            const hpx = row.hpx || (row.hpt ? Math.round(row.hpt * 1.33) : row.h ? row.h : undefined);
            if (hpx) rowlen[i] = hpx;
          });

          const config: any = {};
          if (Object.keys(mergeConfig).length) config.merge = mergeConfig;
          if (Object.keys(columnlen).length) config.columnlen = columnlen;
          if (Object.keys(rowlen).length) config.rowlen = rowlen;

          sheetsForLucky.push({
            name,
            index: idx,
            status: 1,
            order: idx,
            celldata,
            config,
            row: Math.max(range.e.r + 1, 20),
            column: Math.max(range.e.c + 1, 10),
            luckysheet_select_save: [],
            calcChain: [],
            isPivotTable: false,
            pivotTable: {},
            filter_select: {},
            filter: null,
            luckysheet_alternateformat_save: [],
            luckysheet_alternateformat_save_modelCustom: [],
            luckysheet_conditionformat_save: {},
            frozen: {},
            chart: [],
            zoomRatio: 1,
            image: [],
            showGridLines: 1,
            dataVerification: {}
          });
        });

        if (!containerRef.current) return;
        containerRef.current.innerHTML = '';
        
        window.luckysheet?.create({
          container: containerIdRef.current,
          data: sheetsForLucky,
          showtoolbar: true,
          showinfobar: false,
          showsheetbar: true,
          allowCopy: true,
          showConfigWindowResize: true,
          enableAddRow: false,
          enableAddBackTop: false,
          functionButton: true,
          showRowBar: true,
          showColumnBar: true,
          sheetFormulaBar: true,
          defaultFontSize: 11,
          allowEdit: false,
          editMode: false,
          cellRightClickConfig: {
            copy: true,
            copyAs: true,
            paste: true,
            insertRow: false,
            insertColumn: false,
            deleteRow: false,
            deleteColumn: false,
            deleteCell: false,
            hideRow: false,
            hideColumn: false,
            rowHeight: false,
            columnWidth: false,
            clear: false,
            matrix: false,
            sort: false,
            filter: false,
            chart: false,
            image: false,
            link: false,
            data: false,
            cellFormat: true
          }
        });
        
        if (!disposed) setLoading(false);
      } catch (e: any) {
        if (!disposed) {
          setError(e?.message || 'Failed to load sheet');
          setLoading(false);
        }
      }
    }
    init();
    return () => { disposed = true; };
  }, [xlsxPath, sandboxId, session?.access_token]);

  const resolvedHeight = height ?? measuredHeight ?? 0;

  return (
    <div ref={wrapperRef} className={className} style={{ height: height ? (typeof height === 'number' ? `${height}px` : height) : undefined }}>
      {error ? (
        <div className="text-sm text-red-600">{error}</div>
      ) : (
        <div id={containerIdRef.current} ref={containerRef} style={{ height: resolvedHeight, width: '100%' }} />
      )}
      {loading && !error && (
        <div className="text-xs text-muted-foreground mt-2">Loading formatted viewer…</div>
      )}
    </div>
  );
} 