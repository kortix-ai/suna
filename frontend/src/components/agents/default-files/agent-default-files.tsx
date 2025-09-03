"use client"

import React, { useCallback, useState } from "react"
import { Upload, FileText, Trash2, Loader2 } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
// import { useDropzone } from "react-dropzone"
import { cn } from "@/lib/utils"
import {
  useListAgentDefaultFiles,
  useUploadAgentDefaultFile,
  useDeleteAgentDefaultFile,
} from "@/hooks/react-query/agents/use-agent-default-files"

interface AgentDefaultFilesProps {
  agentId: string
  isOwner: boolean
}

export function AgentDefaultFiles({ agentId, isOwner }: AgentDefaultFilesProps) {
  const [deleteFileName, setDeleteFileName] = useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  
  const { data: files = [], isLoading } = useListAgentDefaultFiles(agentId)
  const uploadMutation = useUploadAgentDefaultFile(agentId)
  const deleteMutation = useDeleteAgentDefaultFile(agentId)

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (files) {
      Array.from(files).forEach((file) => {
        uploadMutation.mutate(file)
      })
    }
    // Reset the input
    if (event.target) {
      event.target.value = ''
    }
  }

  const handleDelete = async () => {
    if (deleteFileName) {
      await deleteMutation.mutateAsync(deleteFileName)
      setDeleteFileName(null)
    }
  }

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes"
    const k = 1024
    const sizes = ["Bytes", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default Files</CardTitle>
        <CardDescription>
          Files that will be automatically available in the /workspace/agent-defaults/ directory for every chat session
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isOwner && (
          <div className="space-y-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              className="hidden"
              disabled={uploadMutation.isPending}
              accept="*/*"
            />
            <div
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors",
                "border-muted-foreground/25 hover:border-muted-foreground/50",
                uploadMutation.isPending && "opacity-50 cursor-not-allowed"
              )}
            >
              <Upload className="mx-auto h-12 w-12 text-muted-foreground mb-2" />
              <div>
                <p className="text-sm text-muted-foreground">
                  Click to select files to upload
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Maximum file size: 500MB
                </p>
              </div>
            </div>
          </div>
        )}

        {files.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No default files uploaded yet
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File Name</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Uploaded</TableHead>
                {isOwner && <TableHead className="w-[100px]">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((file) => (
                <TableRow key={file.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      {file.name}
                    </div>
                  </TableCell>
                  <TableCell>{formatFileSize(file.size)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {file.mime_type || "Unknown"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDistanceToNow(new Date(file.uploaded_at), {
                      addSuffix: true,
                    })}
                  </TableCell>
                  {isOwner && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteFileName(file.name)}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <AlertDialog open={!!deleteFileName} onOpenChange={() => setDeleteFileName(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete File</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteFileName}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
