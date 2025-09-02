import { ViewStyle } from 'react-native';

// Common style patterns used across components
export const commonStyles = {
    flexCenter: {
        flex: 1,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
    } as ViewStyle,
    
    fullWidth: {
        width: '100%',
    } as ViewStyle,
    
    absoluteFill: {
        position: 'absolute' as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    } as ViewStyle,

    centerContainer: {
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
    } as ViewStyle,

    flexRow: {
        flexDirection: 'row' as const,
    } as ViewStyle,

    flexColumn: {
        flexDirection: 'column' as const,
    } as ViewStyle,

    shadow: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 1,
    } as ViewStyle,
}; 