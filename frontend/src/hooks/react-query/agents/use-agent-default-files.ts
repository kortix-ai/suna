import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { supabase } from "@/lib/supabase/client"
import { toast } from "sonner"

export interface AgentDefaultFile {
  id: string
  name: string
  storage_path: string
  size: number
  mime_type: string | null
  uploaded_at: string
}

interface UploadResponse {
  success: boolean
  file: AgentDefaultFile
}

interface DeleteResponse {
  success: boolean
  message: string
}

interface ListResponse {
  success: boolean
  files: AgentDefaultFile[]
}

// List agent default files
export function useListAgentDefaultFiles(agentId: string | undefined) {
  return useQuery({
    queryKey: ["agent-default-files", agentId],
    queryFn: async () => {
      if (!agentId) throw new Error("Agent ID is required")
      
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error("Not authenticated")

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/agents/${agentId}/default-files`,
        {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      )

      if (!response.ok) {
        const error = await response.text()
        throw new Error(error || "Failed to fetch files")
      }

      const data: ListResponse = await response.json()
      return data.files
    },
    enabled: !!agentId,
  })
}

// Upload agent default file
export function useUploadAgentDefaultFile(agentId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (file: File) => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error("Not authenticated")

      const formData = new FormData()
      formData.append("file", file)

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/agents/${agentId}/default-files`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
          body: formData,
        }
      )

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || "Failed to upload file")
      }

      const data: UploadResponse = await response.json()
      return data.file
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-default-files", agentId] })
      toast.success("File uploaded successfully")
    },
    onError: (error: Error) => {
      if (error.message.includes("already exists")) {
        toast.error("A file with this name already exists")
      } else if (error.message.includes("exceeds maximum")) {
        toast.error("File size exceeds 500MB limit")
      } else {
        toast.error(error.message || "Failed to upload file")
      }
    },
  })
}

// Delete agent default file
export function useDeleteAgentDefaultFile(agentId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (filename: string) => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error("Not authenticated")

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/agents/${agentId}/default-files/${encodeURIComponent(filename)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      )

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || "Failed to delete file")
      }

      const data: DeleteResponse = await response.json()
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-default-files", agentId] })
      toast.success("File deleted successfully")
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to delete file")
    },
  })
}
