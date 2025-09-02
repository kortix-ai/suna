import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Reduced safe area padding - 80% of actual insets
const SAFE_AREA_REDUCTION_FACTOR = 0.8;

// Header height calculation: safeArea.top + paddingTop(12) + paddingVertical(12) + border(1)
export const HEADER_BASE_HEIGHT = 12 + 24 + 1; // 37px base height

export const useHeaderHeight = () => {
    const insets = useSafeAreaInsets();
    return insets.top + HEADER_BASE_HEIGHT;
};

// Panel content should align with header content level
export const usePanelTopOffset = () => {
    const insets = useSafeAreaInsets();
    return insets.top + 12; // Same as header's paddingTop
};

export const useSafeAreaPadding = () => {
    const insets = useSafeAreaInsets();
    
    return {
        top: Math.max(insets.top * SAFE_AREA_REDUCTION_FACTOR, 8), // Minimum 8px padding
        bottom: insets.bottom,
        left: insets.left,
        right: insets.right,
    };
};

// Alternative: Direct padding object generator
export const getSafeAreaStyle = (edges: ('top' | 'bottom' | 'left' | 'right')[] = ['top']) => {
    const insets = useSafeAreaInsets();
    const style: any = {};
    
    if (edges.includes('top')) {
        style.paddingTop = Math.max(insets.top * SAFE_AREA_REDUCTION_FACTOR, 8);
    }
    if (edges.includes('bottom')) {
        style.paddingBottom = insets.bottom;
    }
    if (edges.includes('left')) {
        style.paddingLeft = insets.left;
    }
    if (edges.includes('right')) {
        style.paddingRight = insets.right;
    }
    
    return style;
}; 