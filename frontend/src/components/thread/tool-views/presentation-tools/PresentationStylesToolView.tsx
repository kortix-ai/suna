// import React from 'react';
// import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
// import { Badge } from '@/components/ui/badge';
// import { Palette, CheckCircle, AlertTriangle, Loader2, Info } from 'lucide-react';
// import { ToolViewProps } from '../types';
// import { extractToolData, getToolTitle, formatTimestamp } from '../utils';
// import { ScrollArea } from "@/components/ui/scroll-area";
// import { LoadingState } from '../shared/LoadingState';

// interface StyleInfo {
//   name: string;
//   description: string;
//   primary_color: string;
//   accent_color: string;
//   background: string;
//   text_color: string;
//   font: string;
//   characteristics: string[];
// }

// interface PresentationStylesData {
//   styles: Record<string, StyleInfo>;
//   message: string;
//   usage_tip?: string;
// }

// // Style preview component that renders a display-only slide preview
// const StylePreview: React.FC<{ style: StyleInfo; styleName: string }> = ({ style, styleName }) => {
//   const isDark = style.background.startsWith('#0') || style.background.startsWith('#1') || 
//                 style.background.includes('gradient') || style.background === '#164E63' || 
//                 style.background === '#451A03' || style.background === '#78350F' || 
//                 style.background === '#064E3B';

//   return (
//     <div className="group rounded-lg cursor-pointer transition-all duration-200 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-sm hover:shadow-lg hover:scale-[1.01]">
//       {/* Style Preview */}
//       <div className="relative h-48 rounded-t-lg overflow-hidden">
//         <div 
//           className="w-full h-full relative"
//           style={{
//             background: style.background,
//             color: style.text_color
//           }}
//         >
//           {/* Slide content */}
//           <div className="absolute inset-0 p-4 flex flex-col justify-center">
//             <div 
//               className="text-lg font-bold mb-2 truncate"
//               style={{ color: style.primary_color }}
//             >
//               {style.name}
//             </div>
//             <div 
//               className="w-8 h-1 mb-3 rounded"
//               style={{ backgroundColor: style.accent_color }}
//             />
//             <div 
//               className="text-sm opacity-80 mb-2"
//               style={{ color: style.text_color }}
//             >
//               Sample Content
//             </div>
            
//             {/* Visual elements based on style characteristics */}
//             {style.characteristics.includes('Charts') || style.characteristics.includes('data') ? (
//               <div className="flex items-center gap-2 mt-auto">
//                 <div 
//                   className="w-4 h-4 rounded"
//                   style={{ backgroundColor: style.primary_color }}
//                 />
//                 <div 
//                   className="w-5 h-4 rounded"
//                   style={{ backgroundColor: style.accent_color }}
//                 />
//                 <div 
//                   className="w-3 h-4 rounded opacity-60"
//                   style={{ backgroundColor: style.primary_color }}
//                 />
//               </div>
//             ) : style.characteristics.includes('Magazine') || style.characteristics.includes('editorial') ? (
//               <div className="flex items-center justify-between mt-auto">
//                 <div className="flex flex-col">
//                   <div 
//                     className="text-xs font-medium"
//                     style={{ color: style.primary_color }}
//                   >
//                     Feature
//                   </div>
//                   <div className="text-xs opacity-60">Detail</div>
//                 </div>
//                 <div 
//                   className="w-6 h-6 rounded-full flex items-center justify-center text-xs"
//                   style={{ 
//                     backgroundColor: style.accent_color,
//                     color: isDark ? '#FFFFFF' : style.text_color
//                   }}
//                 >
//                   📖
//                 </div>
//               </div>
//             ) : style.characteristics.includes('Embedded image') || style.characteristics.includes('image') ? (
//               <div 
//                 className="absolute inset-0 bg-center bg-cover opacity-20"
//                 style={{
//                   backgroundImage: `linear-gradient(45deg, ${style.primary_color}33, ${style.accent_color}33)`
//                 }}
//               />
//             ) : (
//               <div className="flex items-center gap-2 mt-auto">
//                 <div 
//                   className="w-2 h-2 rounded-full"
//                   style={{ backgroundColor: style.accent_color }}
//                 />
//                 <div className="text-xs opacity-70">Key Point</div>
//               </div>
//             )}
//           </div>
//         </div>
//       </div>
      
//       {/* Style info footer */}
//       <div className="px-4 py-3 border-t border-zinc-100 dark:border-zinc-800">
//         <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 capitalize">
//           {style.name}
//         </span>
//       </div>
//     </div>
//   );
// };

// export const PresentationStylesToolView: React.FC<ToolViewProps> = ({
//   name = 'presentation-styles',
//   assistantContent,
//   toolContent,
//   assistantTimestamp,
//   toolTimestamp,
//   isSuccess = true,
//   isStreaming = false,
// }) => {
//   const toolTitle = getToolTitle(name);
//   const extractedData = extractToolData(toolContent);
  
//   // Parse the tool result to get our specific data
//   let data: PresentationStylesData | null = null;
//   if (extractedData.toolResult?.toolOutput && extractedData.toolResult.toolOutput !== 'STREAMING') {
//     try {
//       data = typeof extractedData.toolResult.toolOutput === 'string' 
//         ? JSON.parse(extractedData.toolResult.toolOutput)
//         : extractedData.toolResult.toolOutput;
//     } catch (e) {
//       console.error('Failed to parse presentation styles data:', e);
//     }
//   }

//   const styles = data?.styles ? Object.entries(data.styles) as Array<[string, StyleInfo]> : [];

//   return (
//     <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
//       <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
//         <div className="flex flex-row items-center justify-between">
//           <div className="flex items-center gap-2">
//             <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
//               <Palette className="w-5 h-5 text-blue-500 dark:text-blue-400" />
//             </div>
//             <div>
//               <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
//                 {toolTitle}
//               </CardTitle>
//             </div>
//           </div>

//           <div className="flex items-center gap-2">
//             {!isStreaming && (
//               <Badge
//                 variant="secondary"
//                 className="bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
//               >
//                 <CheckCircle className="h-3.5 w-3.5 mr-1" />
//                 Success
//               </Badge>
//             )}

//             {isStreaming && (
//               <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
//                 <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
//                 Loading
//               </Badge>
//             )}
//           </div>
//         </div>
//       </CardHeader>

//       <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
//         {isStreaming ? (
//           <LoadingState
//             icon={Palette}
//             iconColor="text-blue-500 dark:text-blue-400"
//             bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
//             title="Loading presentation styles"
//             filePath="Fetching available styles..."
//             showProgress={true}
//           />
//         ) : !data || !data.styles ? (
//           <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
//             <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-rose-100 to-rose-50 shadow-inner dark:from-rose-800/40 dark:to-rose-900/60">
//               <AlertTriangle className="h-10 w-10 text-rose-400 dark:text-rose-600" />
//             </div>
//             <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
//               No styles available
//             </h3>
//             <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
//               No presentation styles were found. Please try again.
//             </p>
//           </div>
//         ) : (
//           <ScrollArea className="h-full w-full">
//             <div className="p-6">
//               {/* Styles Grid - 2 per row */}
//               <div className="grid grid-cols-2 gap-6">
//                 {styles.map(([styleName, styleInfo]) => (
//                   <StylePreview 
//                     key={styleName} 
//                     style={styleInfo} 
//                     styleName={styleName}
//                   />
//                 ))}
//               </div>
//             </div>
//           </ScrollArea>
//         )}
//       </CardContent>

//       <div className="px-4 py-2 h-9 bg-zinc-50/30 dark:bg-zinc-900/30 border-t border-zinc-200/30 dark:border-zinc-800/30 flex justify-between items-center">
//         <div className="text-xs text-zinc-400 dark:text-zinc-500">
//           {styles.length > 0 && !isStreaming && (
//             <span className="font-mono">
//               {styles.length} styles
//             </span>
//           )}
//         </div>
//         <div className="text-xs text-zinc-400 dark:text-zinc-500">
//           {formatTimestamp(toolTimestamp)}
//         </div>
//       </div>
//     </Card>
//   );
// };
