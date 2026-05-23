'use client';

import { useTranslations } from 'next-intl';

import { useEffect, useMemo, useRef } from 'react';
import { useFileContent } from '@/features/files/hooks/use-file-content';
import { ImagePreview } from '@/components/session/image-preview';
import { cn } from '@/lib/utils';

/**
 * Detect whether a URL string is a local sandbox filesystem path
 * (e.g. /workspace/uploads/...) rather than a valid HTTP/data/blob URL.
 * Matches the pattern used in tool-renderers.tsx.
 */
function isLocalSandboxFilePath(value: string): boolean {
	if (!value) return false;
	if (/^(https?:|data:|blob:)/i.test(value)) return false;
	return value.startsWith('/');
}

interface SandboxImageProps {
	/** Raw src — may be a sandbox filesystem path or a valid URL */
	src: string;
	alt?: string;
	className?: string;
	/** When true, wraps the image in an ImagePreview dialog for full-size viewing */
	preview?: boolean;
}

/**
 * SandboxImage — renders an image that may reference a sandbox filesystem path.
 *
 * If `src` is a local sandbox path (e.g. /workspace/uploads/...), fetches the
 * file content via the OpenCode SDK (useFileContent), converts base64 to a blob
 * URL, and renders that. If `src` is already a valid HTTP/data/blob URL, renders
 * it directly.
 *
 * Follows the same pattern as tool-renderers.tsx ImageGenTool (lines 3660-3685).
 */
export function SandboxImage({ src, alt = 'Image', className, preview }: SandboxImageProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
	const isLocalPath = isLocalSandboxFilePath(src);

	// Strip /workspace/ prefix since the SDK expects paths relative to project root
	const fileContentPath = useMemo(() => {
		if (!isLocalPath) return null;
		return src.replace(/^\/workspace\//, '');
	}, [isLocalPath, src]);

	const { data: fileContentData, isLoading } = useFileContent(
		fileContentPath,
		{ enabled: !!fileContentPath },
	);

	// Convert base64 to blob URL (same pattern as tool-renderers.tsx)
	const blobUrlRef = useRef<string | null>(null);
	const blobUrl = useMemo(() => {
		// Revoke previous blob URL when data changes
		if (blobUrlRef.current) {
			URL.revokeObjectURL(blobUrlRef.current);
			blobUrlRef.current = null;
		}
		if (fileContentData?.encoding === 'base64' && fileContentData?.content) {
			const binary = atob(fileContentData.content);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			const blob = new Blob([bytes], { type: fileContentData.mimeType || 'image/png' });
			const url = URL.createObjectURL(blob);
			blobUrlRef.current = url;
			return url;
		}
		return null;
	}, [fileContentData]);

	// Cleanup blob URL on unmount
	useEffect(() => {
		return () => {
			if (blobUrlRef.current) {
				URL.revokeObjectURL(blobUrlRef.current);
				blobUrlRef.current = null;
			}
		};
	}, []);

	// Priority: blob URL from sandbox fetch > original src (if already a valid URL)
	const resolvedSrc = isLocalPath ? blobUrl : src;

	// Loading state — show skeleton while fetching from sandbox
	if (isLocalPath && isLoading) {
		return (
			<div className={cn('animate-pulse bg-muted/40 rounded', className)} style={{ minHeight: 80, minWidth: 80 }} />
		);
	}

	// Error state — fetch completed but no blob URL (file not found, etc.)
	if (isLocalPath && !isLoading && !resolvedSrc) {
		return (
			<div className={cn('flex items-center justify-center bg-muted/20 rounded text-muted-foreground text-xs', className)} style={{ minHeight: 80, minWidth: 80 }}>{tHardcodedUi.raw('componentsSessionSandboxImage.line96JsxTextImageUnavailable')}</div>
		);
	}

	if (!resolvedSrc) return null;

	const img = (
		/* eslint-disable-next-line @next/next/no-img-element */
		<img
			src={resolvedSrc}
			alt={alt}
			className={className}
		/>
	);

	if (preview) {
		return (
			<ImagePreview src={resolvedSrc} alt={alt}>
				{img}
			</ImagePreview>
		);
	}

	return img;
}
