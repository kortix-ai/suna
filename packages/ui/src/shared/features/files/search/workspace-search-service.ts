import { createWorkspaceSearchClient } from '@kortix/sdk/workspace-search';
import { getRuntimeCacheKey } from '@kortix/sdk/react';
import { findFiles, listFiles } from '../api/runtime-files';

const search = createWorkspaceSearchClient({ listFiles, findFiles }, getRuntimeCacheKey);

export const searchWorkspaceFileEntries = search.searchWorkspaceFileEntries;
export const searchWorkspaceFilePaths = search.searchWorkspaceFilePaths;
export const searchWorkspaceFiles = search.searchWorkspaceFiles;
