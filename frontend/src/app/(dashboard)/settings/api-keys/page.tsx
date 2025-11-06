'use client';

import React, { useState, useEffect } from 'react';
import { Key, Plus, Trash2, Copy, Shield, ExternalLink, Sparkles } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  apiKeysApi,
  APIKeyCreateRequest,
  APIKeyResponse,
  APIKeyCreateResponse,
} from '@/lib/api-client';
import { copy } from '@/copy';

interface NewAPIKeyData {
  title: string;
  description: string;
  expiresInDays: string;
}

export default function APIKeysPage() {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [newKeyData, setNewKeyData] = useState<NewAPIKeyData>({
    title: '',
    description: '',
    expiresInDays: 'never',
  });
  const [createdApiKey, setCreatedApiKey] =
    useState<APIKeyCreateResponse | null>(null);
  const [showCreatedKey, setShowCreatedKey] = useState(false);
  const queryClient = useQueryClient();


  // Fetch API keys
  const {
    data: apiKeysResponse,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => apiKeysApi.list(),
  });

  const apiKeys = apiKeysResponse?.data || [];

  // Create API key mutation
  const createMutation = useMutation({
    mutationFn: (request: APIKeyCreateRequest) => apiKeysApi.create(request),
    onSuccess: (response) => {
      if (response.success && response.data) {
        setCreatedApiKey(response.data);
        setShowCreatedKey(true);
        setIsCreateDialogOpen(false);
        queryClient.invalidateQueries({ queryKey: ['api-keys'] });
        toast.success(copy.apiKeys.toastCreateSuccess);
        // Reset form
        setNewKeyData({ title: '', description: '', expiresInDays: 'never' });
      } else {
        toast.error(response.error?.message || copy.apiKeys.toastCreateFailed);
      }
    },
    onError: (error) => {
      toast.error(copy.apiKeys.toastCreateFailed);
      console.error('Error creating API key:', error);
    },
  });

  // Revoke API key mutation
  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => apiKeysApi.revoke(keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success(copy.apiKeys.toastRevokeSuccess);
    },
    onError: (error) => {
      toast.error(copy.apiKeys.toastRevokeFailed);
      console.error('Error revoking API key:', error);
    },
  });

  // Delete API key mutation
  const deleteMutation = useMutation({
    mutationFn: (keyId: string) => apiKeysApi.delete(keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success(copy.apiKeys.toastDeleteSuccess);
    },
    onError: (error) => {
      toast.error(copy.apiKeys.toastDeleteFailed);
      console.error('Error deleting API key:', error);
    },
  });

  const handleCreateAPIKey = () => {
    const request: APIKeyCreateRequest = {
      title: newKeyData.title.trim(),
      description: newKeyData.description.trim() || undefined,
      expires_in_days:
        newKeyData.expiresInDays && newKeyData.expiresInDays !== 'never'
          ? parseInt(newKeyData.expiresInDays)
          : undefined,
    };

    createMutation.mutate(request);
  };

  const handleCopyKey = async (key: string, keyType: string = 'key') => {
    try {
      await navigator.clipboard.writeText(key);
      toast.success(copy.apiKeys.toastCopied.replace('{what}', keyType));
    } catch (error) {
      toast.error(copy.apiKeys.toastCopyFailed.replace('{what}', keyType));
    }
  };

  const handleCopyFullKey = async (publicKey: string, secretKey: string) => {
    try {
      const fullKey = `${publicKey}:${secretKey}`;
      await navigator.clipboard.writeText(fullKey);
      toast.success(copy.apiKeys.toastCopiedFull);
    } catch (error) {
      toast.error(copy.apiKeys.toastCopyFullFailed);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('ru-RU', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return (
          <Badge className="bg-green-100 text-green-800 border-green-200">
            {copy.apiKeys.statusActive}
          </Badge>
        );
      case 'revoked':
        return (
          <Badge className="bg-red-100 text-red-800 border-red-200">
            {copy.apiKeys.statusRevoked}
          </Badge>
        );
      case 'expired':
        return (
          <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">
            {copy.apiKeys.statusExpired}
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const isKeyExpired = (expiresAt?: string) => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };


  return (
    <div className="container mx-auto max-w-6xl px-6 py-6">
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Key className="w-6 h-6" />
            <h1 className="text-2xl font-medium">{copy.apiKeys.title}</h1>
          </div>
          <p className="text-muted-foreground">
            {copy.apiKeys.description}
          </p>
        </div>

        {/* SDK Beta Notice */}
        <Card className="border-blue-200/60 bg-gradient-to-br from-blue-50/80 to-indigo-50/40 dark:from-blue-950/20 dark:to-indigo-950/10 dark:border-blue-800/30">
          <CardContent className="">
            <div className="flex items-start gap-4">
              <div className="relative">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500/20 to-indigo-600/10 border border-blue-500/20">
                  <Sparkles className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="absolute -top-1 -right-1">
                  <Badge variant="secondary" className="h-5 px-1.5 text-xs bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700">
                    {copy.apiKeys.betaBadge}
                  </Badge>
                </div>
              </div>
              <div className="flex-1 space-y-3">
                <div>
                  <h3 className="text-base font-semibold text-blue-900 dark:text-blue-100 mb-1">
                    {copy.apiKeys.sdkTitle}
                  </h3>
                  <p className="text-sm text-blue-700 dark:text-blue-300 leading-relaxed">
                    {copy.apiKeys.sdkDesc}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <a
                    href="https://github.com/kortix-ai/suna/tree/main/sdk"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                  >
                    <span>{copy.apiKeys.sdkDocsLink}</span>
                    <ExternalLink className="w-4 h-4" />
                  </a>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Header Actions */}
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Shield className="w-4 h-4" />
            <span>
              {copy.apiKeys.headerNote}
            </span>
          </div>

          <Dialog
            open={isCreateDialogOpen}
            onOpenChange={setIsCreateDialogOpen}
          >
            <DialogTrigger asChild>
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                {copy.apiKeys.newKey}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{copy.apiKeys.createDialogTitle}</DialogTitle>
                <DialogDescription>
                  {copy.apiKeys.createDialogDesc}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div>
                  <Label htmlFor="title" className="m-1">
                    {copy.apiKeys.fieldTitle}
                  </Label>
                  <Input
                    id="title"
                    placeholder={copy.apiKeys.fieldTitlePlaceholder}
                    value={newKeyData.title}
                    onChange={(e) =>
                      setNewKeyData((prev) => ({
                        ...prev,
                        title: e.target.value,
                      }))
                    }
                  />
                </div>

                <div>
                  <Label htmlFor="description" className="m-1">
                    {copy.apiKeys.fieldDescription}
                  </Label>
                  <Textarea
                    id="description"
                    placeholder={copy.apiKeys.fieldDescriptionPlaceholder}
                    value={newKeyData.description}
                    onChange={(e) =>
                      setNewKeyData((prev) => ({
                        ...prev,
                        description: e.target.value,
                      }))
                    }
                  />
                </div>

                <div>
                  <Label htmlFor="expires" className="m-1">
                    {copy.apiKeys.fieldExpires}
                  </Label>
                  <Select
                    value={newKeyData.expiresInDays}
                    onValueChange={(value) =>
                      setNewKeyData((prev) => ({
                        ...prev,
                        expiresInDays: value,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={copy.apiKeys.expiresNever} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="never">{copy.apiKeys.expiresNever}</SelectItem>
                      <SelectItem value="7">{copy.apiKeys.expires7d}</SelectItem>
                      <SelectItem value="30">{copy.apiKeys.expires30d}</SelectItem>
                      <SelectItem value="90">{copy.apiKeys.expires90d}</SelectItem>
                      <SelectItem value="365">{copy.apiKeys.expires365d}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4">
                <Button
                  variant="outline"
                  onClick={() => setIsCreateDialogOpen(false)}
                >
                  {copy.common.cancel}
                </Button>
                <Button
                  onClick={handleCreateAPIKey}
                  disabled={
                    !newKeyData.title.trim() || createMutation.isPending
                  }
                >
                  {createMutation.isPending ? copy.apiKeys.creating : copy.apiKeys.createButton}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* API Keys List */}
        {isLoading ? (
          <div className="grid gap-4">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader>
                  <div className="h-4 bg-muted rounded w-1/3"></div>
                  <div className="h-3 bg-muted rounded w-1/2"></div>
                </CardHeader>
                <CardContent>
                  <div className="h-3 bg-muted rounded w-3/4"></div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="p-6 text-center">
              <p className="text-muted-foreground">
                {copy.apiKeys.listLoadFailed}
              </p>
            </CardContent>
          </Card>
        ) : apiKeys.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center">
              <Key className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">{copy.apiKeys.emptyTitle}</h3>
              <p className="text-muted-foreground mb-4">
                {copy.apiKeys.emptyDesc}
              </p>
              <Button onClick={() => setIsCreateDialogOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                {copy.apiKeys.emptyCreateButton}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {apiKeys.map((apiKey: APIKeyResponse) => (
              <Card
                key={apiKey.key_id}
                className={
                  isKeyExpired(apiKey.expires_at) ? 'border-yellow-200' : ''
                }
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-lg">{apiKey.title}</CardTitle>
                      {apiKey.description && (
                        <CardDescription className="mt-1">
                          {apiKey.description}
                        </CardDescription>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {getStatusBadge(apiKey.status)}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground mb-1">{copy.apiKeys.cardCreatedLabel}</p>
                        <p className="font-medium">
                          {formatDate(apiKey.created_at)}
                        </p>
                      </div>
                      {apiKey.expires_at && (
                        <div>
                          <p className="text-muted-foreground mb-1">{copy.apiKeys.cardExpiresLabel}</p>
                          <p
                            className={`font-medium ${isKeyExpired(apiKey.expires_at) ? 'text-yellow-600' : ''}`}
                          >
                            {formatDate(apiKey.expires_at)}
                          </p>
                        </div>
                      )}
                      {apiKey.last_used_at && (
                        <div>
                          <p className="text-muted-foreground mb-1">
                            {copy.apiKeys.cardLastUsedLabel}
                          </p>
                          <p className="font-medium">
                            {formatDate(apiKey.last_used_at)}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {apiKey.status === 'active' && (
                    <div className="flex gap-2 mt-4">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm">
                            <Trash2 className="w-4 h-4 mr-2" />
                            {copy.apiKeys.revoke}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{copy.apiKeys.revokeDialogTitle}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {copy.apiKeys.revokeDialogDesc.replace('{title}', apiKey.title)}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{copy.common.cancel}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() =>
                                revokeMutation.mutate(apiKey.key_id)
                              }
                              className="bg-destructive hover:bg-destructive/90 text-white"
                            >
                              {copy.apiKeys.revokeConfirm}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}

                  {(apiKey.status === 'revoked' ||
                    apiKey.status === 'expired') && (
                      <div className="flex gap-2 mt-4">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm">
                            <Trash2 className="w-4 h-4 mr-2" />
                            {copy.apiKeys.delete}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{copy.apiKeys.deleteDialogTitle}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {copy.apiKeys.deleteDialogDesc.replace('{title}', apiKey.title)}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{copy.common.cancel}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() =>
                                deleteMutation.mutate(apiKey.key_id)
                              }
                              className="bg-destructive hover:bg-destructive/90 text-white"
                            >
                              {copy.apiKeys.deleteConfirm}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Show Created API Key Dialog */}
        <Dialog open={showCreatedKey} onOpenChange={setShowCreatedKey}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-green-600" />
                {copy.apiKeys.createdDialogTitle}
              </DialogTitle>
              <DialogDescription>
                {copy.apiKeys.createdDialogDesc}
              </DialogDescription>
            </DialogHeader>

            {createdApiKey && (
              <div className="space-y-4">
                <div>
                  <Label className="m-1">{copy.apiKeys.createdDialogLabel}</Label>
                  <div className="flex gap-2">
                    <Input
                      value={`${createdApiKey.public_key}:${createdApiKey.secret_key}`}
                      readOnly
                      className="font-mono text-sm"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        handleCopyFullKey(
                          createdApiKey.public_key,
                          createdApiKey.secret_key,
                        )
                      }
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                    <p className="text-sm text-yellow-800">
                      <strong>{copy.apiKeys.createdDialogImportant}</strong> {copy.apiKeys.createdDialogImportantText}
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={() => setShowCreatedKey(false)}>{copy.apiKeys.close}</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
