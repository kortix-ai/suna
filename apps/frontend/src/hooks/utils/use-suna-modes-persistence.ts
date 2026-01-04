import { useState, useEffect } from 'react';

// localStorage keys
const SELECTED_MODE_KEY = 'selectedSunaMode';
const SELECTED_CHARTS_KEY = 'selectedCharts';
const SELECTED_OUTPUT_FORMAT_KEY = 'selectedOutputFormat';
const SELECTED_TEMPLATE_KEY = 'selectedTemplate';

interface SunaModesState {
  selectedMode: string | null;
  selectedCharts: string[];
  selectedOutputFormat: string | null;
  selectedTemplate: string | null;
}

interface SunaModesActions {
  setSelectedMode: (mode: string | null) => void;
  setSelectedCharts: (charts: string[]) => void;
  setSelectedOutputFormat: (format: string | null) => void;
  setSelectedTemplate: (template: string | null) => void;
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

  // Reset data-specific selections when mode changes
  useEffect(() => {
    if (selectedMode !== 'data') {
      setSelectedChartsState([]);
      setSelectedOutputFormatState(null);
    }
    if (selectedMode !== 'slides') {
      setSelectedTemplateState(null);
    }
  }, [selectedMode]);

  return {
    selectedMode,
    selectedCharts,
    selectedOutputFormat,
    selectedTemplate,
    setSelectedMode: setSelectedModeState,
    setSelectedCharts: setSelectedChartsState,
    setSelectedOutputFormat: setSelectedOutputFormatState,
    setSelectedTemplate: setSelectedTemplateState,
  };
}

