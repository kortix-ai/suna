import { Message } from '@/api/chat-api';
import { useThemedStyles } from '@/hooks/useThemeColor';
import { useSelectedProject } from '@/stores/ui-store';
import React, { useRef } from 'react';
import { Dimensions, View } from 'react-native';
import { DrawerLayout } from 'react-native-gesture-handler';
import { LeftPanel } from './LeftPanel';
import { RightPanel } from './RightPanel';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface PanelContainerProps {
    leftPanelVisible: boolean;
    rightPanelVisible: boolean;
    onCloseLeft: () => void;
    onCloseRight: () => void;
    onOpenLeft: () => void;
    children: React.ReactNode;
    messages?: Message[];
}

export const PanelContainer: React.FC<PanelContainerProps> = ({
    leftPanelVisible,
    rightPanelVisible,
    onCloseLeft,
    onCloseRight,
    onOpenLeft,
    children,
    messages = [],
}) => {
    const leftDrawerRef = useRef<DrawerLayout>(null);
    const rightDrawerRef = useRef<DrawerLayout>(null);
    const selectedProject = useSelectedProject();

    const styles = useThemedStyles((theme) => ({
        container: {
            flex: 1,
            backgroundColor: theme.background,
        },
        mainContent: {
            flex: 1,
        },
    }));

    // Handle drawer state changes
    React.useEffect(() => {
        if (leftPanelVisible) {
            leftDrawerRef.current?.openDrawer();
        } else {
            leftDrawerRef.current?.closeDrawer();
        }
    }, [leftPanelVisible]);

    React.useEffect(() => {
        if (rightPanelVisible) {
            rightDrawerRef.current?.openDrawer();
        } else {
            rightDrawerRef.current?.closeDrawer();
        }
    }, [rightPanelVisible]);

    const leftDrawerContent = (
        <LeftPanel isVisible={true} onClose={() => {
            leftDrawerRef.current?.closeDrawer();
            onCloseLeft();
        }} />
    );

    const rightDrawerContent = (
        <RightPanel
            isVisible={true}
            onClose={onCloseRight}
            messages={messages}
            sandboxId={selectedProject?.sandbox?.id}
        />
    );

    const mainContent = (
        <View style={styles.mainContent}>
            {children}
        </View>
    );

    return (
        <View style={styles.container}>
            <DrawerLayout
                ref={leftDrawerRef}
                drawerWidth={300}
                drawerPosition="left"
                drawerType="slide"
                drawerBackgroundColor="transparent"
                edgeWidth={75}
                renderNavigationView={() => leftDrawerContent}
                onDrawerSlide={(position) => {
                    // Tiny overlay effect on main content
                    if (position > 0 && !leftPanelVisible) {
                        onOpenLeft();
                    }
                }}
                onDrawerClose={() => {
                    if (leftPanelVisible) {
                        onCloseLeft();
                    }
                }}
            >
                <DrawerLayout
                    ref={rightDrawerRef}
                    drawerWidth={SCREEN_WIDTH}
                    drawerPosition="right"
                    drawerType="slide"
                    drawerBackgroundColor="transparent"
                    renderNavigationView={() => rightDrawerContent}
                    onDrawerClose={() => {
                        if (rightPanelVisible) {
                            onCloseRight();
                        }
                    }}
                >
                    {mainContent}
                </DrawerLayout>
            </DrawerLayout>
        </View>
    );
}; 