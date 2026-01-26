import { useState, useEffect } from 'react';

// localStorage keys
const SELECTED_MODE_KEY = 'selectedSunaMode';
const SELECTED_CHARTS_KEY = 'selectedCharts';
const SELECTED_OUTPUT_FORMAT_KEY = 'selectedOutputFormat';
const SELECTED_TEMPLATE_KEY = 'selectedTemplate';
const SELECTED_DOCS_TYPE_KEY = 'selectedDocsType';
const SELECTED_IMAGE_STYLE_KEY = 'selectedImageStyle';
const SELECTED_CANVAS_ACTION_KEY = 'selectedCanvasAction';
const SELECTED_VIDEO_STYLE_KEY = 'selectedVideoStyle';

interface SunaModesState {
  selectedMode: string | null;
  selectedCharts: string[];
  selectedOutputFormat: string | null;
  selectedTemplate: string | null;
  selectedDocsType: string | null;
  selectedImageStyle: string | null;
  selectedCanvasAction: string | null;
  selectedVideoStyle: string | null;
}

interface SunaModesActions {
  setSelectedMode: (mode: string | null) => void;
  setSelectedCharts: (charts: string[]) => void;
  setSelectedOutputFormat: (format: string | null) => void;
  setSelectedTemplate: (template: string | null) => void;
  setSelectedDocsType: (type: string | null) => void;
  setSelectedImageStyle: (style: string | null) => void;
  setSelectedCanvasAction: (action: string | null) => void;
  setSelectedVideoStyle: (style: string | null) => void;
}

export function useSunaModePersistence(): SunaModesState & SunaModesActions {
  // Initialize mode from localStorage
  const [selectedMode, setSelectedModeState] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(SELECTED_MODE_KEY);
    }
    return null;
  });

  // Initialize charts from localStorage
  const [selectedCharts, setSelectedChartsState] = useState<string[]>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(SELECTED_CHARTS_KEY);
      return stored ? JSON.parse(stored) : [];
    }
    return [];
  });

  // Initialize output format from localStorage
  const [selectedOutputFormat, setSelectedOutputFormatState] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(SELECTED_OUTPUT_FORMAT_KEY);
    }
    return null;
  });

  // Initialize template from localStorage
  const [selectedTemplate, setSelectedTemplateState] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(SELECTED_TEMPLATE_KEY);
    }
    return null;
  });

  // Initialize docs type from localStorage
  const [selectedDocsType, setSelectedDocsTypeState] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(SELECTED_DOCS_TYPE_KEY);
    }
    return null;
  });

  // Initialize image style from localStorage
  const [selectedImageStyle, setSelectedImageStyleState] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(SELECTED_IMAGE_STYLE_KEY);
    }
    return null;
  });

  // Initialize canvas action from localStorage
  const [selectedCanvasAction, setSelectedCanvasActionState] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(SELECTED_CANVAS_ACTION_KEY);
    }
    return null;
  });

  // Initialize video style from localStorage
  const [selectedVideoStyle, setSelectedVideoStyleState] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(SELECTED_VIDEO_STYLE_KEY);
    }
    return null;
  });

  // Persist mode to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (selectedMode) {
        localStorage.setItem(SELECTED_MODE_KEY, selectedMode);
      } else {
        localStorage.removeItem(SELECTED_MODE_KEY);
      }
    }
  }, [selectedMode]);

  // Persist charts to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (selectedCharts.length > 0) {
        localStorage.setItem(SELECTED_CHARTS_KEY, JSON.stringify(selectedCharts));
      } else {
        localStorage.removeItem(SELECTED_CHARTS_KEY);
      }
    }
  }, [selectedCharts]);

  // Persist output format to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (selectedOutputFormat) {
        localStorage.setItem(SELECTED_OUTPUT_FORMAT_KEY, selectedOutputFormat);
      } else {
        localStorage.removeItem(SELECTED_OUTPUT_FORMAT_KEY);
      }
    }
  }, [selectedOutputFormat]);

  // Persist template to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (selectedTemplate) {
        localStorage.setItem(SELECTED_TEMPLATE_KEY, selectedTemplate);
      } else {
        localStorage.removeItem(SELECTED_TEMPLATE_KEY);
      }
    }
  }, [selectedTemplate]);

  // Persist docs type to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (selectedDocsType) {
        localStorage.setItem(SELECTED_DOCS_TYPE_KEY, selectedDocsType);
      } else {
        localStorage.removeItem(SELECTED_DOCS_TYPE_KEY);
      }
    }
  }, [selectedDocsType]);

  // Persist image style to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (selectedImageStyle) {
        localStorage.setItem(SELECTED_IMAGE_STYLE_KEY, selectedImageStyle);
      } else {
        localStorage.removeItem(SELECTED_IMAGE_STYLE_KEY);
      }
    }
  }, [selectedImageStyle]);

  // Persist canvas action to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (selectedCanvasAction) {
        localStorage.setItem(SELECTED_CANVAS_ACTION_KEY, selectedCanvasAction);
      } else {
        localStorage.removeItem(SELECTED_CANVAS_ACTION_KEY);
      }
    }
  }, [selectedCanvasAction]);

  // Persist video style to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (selectedVideoStyle) {
        localStorage.setItem(SELECTED_VIDEO_STYLE_KEY, selectedVideoStyle);
      } else {
        localStorage.removeItem(SELECTED_VIDEO_STYLE_KEY);
      }
    }
  }, [selectedVideoStyle]);

  // Reset mode-specific selections when mode changes
  useEffect(() => {
    if (selectedMode !== 'data') {
      setSelectedChartsState([]);
      setSelectedOutputFormatState(null);
    }
    if (selectedMode !== 'slides') {
      setSelectedTemplateState(null);
    }
    if (selectedMode !== 'docs') {
      setSelectedDocsTypeState(null);
    }
    if (selectedMode !== 'image') {
      setSelectedImageStyleState(null);
    }
    if (selectedMode !== 'canvas') {
      setSelectedCanvasActionState(null);
    }
    if (selectedMode !== 'video') {
      setSelectedVideoStyleState(null);
    }
  }, [selectedMode]);

  return {
    selectedMode,
    selectedCharts,
    selectedOutputFormat,
    selectedTemplate,
    selectedDocsType,
    selectedImageStyle,
    selectedCanvasAction,
    selectedVideoStyle,
    setSelectedMode: setSelectedModeState,
    setSelectedCharts: setSelectedChartsState,
    setSelectedOutputFormat: setSelectedOutputFormatState,
    setSelectedTemplate: setSelectedTemplateState,
    setSelectedDocsType: setSelectedDocsTypeState,
    setSelectedImageStyle: setSelectedImageStyleState,
    setSelectedCanvasAction: setSelectedCanvasActionState,
    setSelectedVideoStyle: setSelectedVideoStyleState,
  };
}

