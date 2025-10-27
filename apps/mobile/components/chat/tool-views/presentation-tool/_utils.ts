import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface Slide {
  slide_number: number;
  title: string;
  content?: string;
  description?: string;
  notes?: string;
  layout?: string;
}

export interface PresentationData {
  presentation_id?: string;
  presentation_name?: string;
  title?: string;
  subtitle?: string;
  slides?: Slide[];
  slide?: Slide;
  total_slides?: number;
  slide_count?: number;
  message?: string;
  outline?: any;
  success: boolean;
}

const parseContent = (content: any): any => {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }
  return content;
};

export function extractPresentationData(toolData: ParsedToolData): PresentationData {
  const { arguments: args, result } = toolData;
  
  console.log('🎨 [extractPresentationData] Raw data:', {
    args,
    resultOutput: result.output,
    resultOutputType: typeof result.output
  });
  
  let data: any = {};
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    console.log('🎨 [extractPresentationData] Parsed output:', output);
    
    if (output && typeof output === 'object') {
      data = output;
    } else if (typeof output === 'string') {
      data = { message: output };
      
      const slideMatch = output.match(/Slide (\d+).*?created/i);
      if (slideMatch) {
        data.slide = {
          slide_number: parseInt(slideMatch[1]),
          title: args?.title || 'Slide',
          content: args?.content || args?.description
        };
      }
    }
  }
  
  const slideData = data.slide_data || data.slide;
  const outlineData = data.outline || data;
  
  let slides = data.slides || outlineData?.slides || (slideData ? [slideData] : []);
  
  if (slides.length === 0 && data.slide_number) {
    const singleSlide: Slide = {
      slide_number: data.slide_number,
      title: data.slide_title || args?.slide_title || args?.title || 'Slide',
      content: args?.content || args?.description,
      description: args?.description,
      notes: data.notes || args?.notes
    };
    slides = [singleSlide];
  }
  
  console.log('🎨 [extractPresentationData] Final slides:', slides);
  
  return {
    presentation_id: data.presentation_id || args?.presentation_id,
    presentation_name: data.presentation_name || args?.presentation_name,
    title: data.title || outlineData?.title || args?.title || args?.presentation_title,
    subtitle: data.subtitle || outlineData?.subtitle,
    slides,
    slide: slideData,
    total_slides: data.total_slides || data.slide_count || outlineData?.slide_count || slides?.length,
    slide_count: data.slide_count || outlineData?.slide_count || slides?.length,
    message: data.message || data.status,
    outline: outlineData,
    success: result.success ?? true
  };
}

