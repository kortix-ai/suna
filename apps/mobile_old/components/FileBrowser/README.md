# File Browser System

A minimal file browser modal for React Native that integrates with your sandbox file system using Zustand and React Query.

## Features

- **Directory Navigation**: Browse folders and files in your sandbox workspace
- **File Viewing**: Preview text files and images inline
- **File Downloads**: Download files to device (basic functionality)
- **Breadcrumb Navigation**: Easy navigation with breadcrumbs
- **Cache Integration**: Uses React Query for efficient caching
- **Theme Support**: Follows your app's theme system

## Usage

### Opening the File Browser

```tsx
import { useFileBrowser } from '@/hooks/useFileBrowser';

const MyComponent = () => {
  const { openFileBrowser } = useFileBrowser();

  const handleOpenFiles = () => {
    // Open file browser for a sandbox
    openFileBrowser('sandbox-id-123');
    
    // Or open to a specific file/path
    openFileBrowser('sandbox-id-123', '/workspace/src/main.py');
  };

  return (
    <TouchableOpacity onPress={handleOpenFiles}>
      <Text>Browse Files</Text>
    </TouchableOpacity>
  );
};
```

### Integration with Existing File System

The file browser is already integrated with the MessageThread component, so clicking on file attachments will open the browser.

## Components

### FileBrowserModal
Main modal component that handles the entire file browsing experience.

### FileItem
Individual file/folder list item component.

### FileViewer
Component for displaying file content (text and images).

## API Integration

The system uses the following API endpoints:
- `GET /sandboxes/{id}/files?path={path}` - List directory contents
- `GET /sandboxes/{id}/files/content?path={path}` - Get file content

## Store Management

Uses Zustand for state management with the following key state:
- `isVisible`: Modal visibility
- `sandboxId`: Current sandbox ID
- `currentPath`: Current directory path
- `selectedFile`: Currently selected file

## Caching Strategy

- Directory listings cached for 30 seconds
- File content cached for 2 minutes
- Images cached as blobs for offline viewing
- Automatic cache invalidation on refresh

## Minimal Dependencies

The system uses only packages already in your project:
- React Query for data fetching and caching
- Zustand for state management
- expo-image for image display
- lucide-react-native for icons

## Future Enhancements

- File upload functionality
- File sharing with expo-sharing
- File system operations (rename, delete)
- Better download handling with expo-file-system
- Bulk operations 