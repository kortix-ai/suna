'use client';

import React from 'react';
import { KnowledgeBasePageHeader } from './knowledge-base-header';
import { KnowledgeBaseManager } from './knowledge-base-manager';

export function KnowledgeBasePage() {
    return (
        <div>
            <div className="min-h-screen">
                <div className="container mx-auto max-w-7xl px-4 py-8">
                    <KnowledgeBasePageHeader />
                </div>
                <div className="container mx-auto max-w-7xl px-4 py-2">
                    <div className="w-full min-h-[calc(100vh-300px)]">
                        <KnowledgeBaseManager
                            showHeader={true}
                            showRecentFiles={true}
                            enableAssignments={false}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}