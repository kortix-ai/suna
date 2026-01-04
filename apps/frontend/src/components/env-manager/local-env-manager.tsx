"use client";

import { Eye, EyeOff, Plus, Trash } from "lucide-react";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { isLocalMode } from "@/lib/config";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backendApi } from "@/lib/api-client";
import { toast } from "sonner";
import { useForm } from "react-hook-form";

interface APIKeyForm {
    [key: string]: string;
}

export function LocalEnvManager() {
  const queryClient = useQueryClient();
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [newApiKeys, setNewApiKeys] = useState<{key: string, value: string, id: string}[]>([]);

  const {data: apiKeys, isLoading} = useQuery({
    queryKey: ['api-keys'],
    queryFn: async() => {
      const response = await backendApi.get('/admin/env-vars');
      return response.data;
    },
    enabled: isLocalMode()
  });

  const { register, handleSubmit, formState: { errors, isDirty }, reset } = useForm<APIKeyForm>({
    defaultValues: apiKeys || {}
  });

  const handleSave = async (data: APIKeyForm) => {
    const duplicate_key = newApiKeys.find(entry => data[entry.key.trim()]);
    if (duplicate_key) {
      toast.error(`Key ${duplicate_key.key} already exists`);
      return;
    }
    const submitData = {
      ...data,
      ...Object.fromEntries(newApiKeys.map(entry => [entry.key.trim(), entry.value.trim()]))
    }
    
    updateApiKeys.mutate(submitData);
  }

  const handleAddNewKey = () => {
    setNewApiKeys([...newApiKeys, {key: "", value: "", id: crypto.randomUUID()}]);
  }

  const checkKeyIsDuplicate = (key: string) => {
    const trimmedKey = key.trim();
    const keyIsDuplicate =
      trimmedKey &&
      (
        (apiKeys && Object.keys(apiKeys).includes(trimmedKey)) ||
        newApiKeys.filter(e => e.key.trim() === trimmedKey).length > 1
      );
    return keyIsDuplicate;
  }

  const handleNewKeyChange = (id: string, field: string, value: string) => {
    setNewApiKeys(prev => 
      prev.map(entry => entry.id === id ? {...entry, [field]: value} : entry)
    );
  }

  const handleDeleteKey = (id: string) => {
    setNewApiKeys(prev => prev.filter(entry => entry.id !== id));
  }

  const hasEmptyKeyValues = newApiKeys.some(entry => entry.key.trim() === "" || entry.value.trim() === "");
  const hasDuplicateKeys = (): boolean => {
    const allKeys = [...Object.keys(apiKeys || {}), ...newApiKeys.map(entry => entry.key.trim())];
    const uniqueKeys = new Set(allKeys);
    return uniqueKeys.size !== allKeys.length;
  }

  const updateApiKeys = useMutation({
    mutationFn: async (data: APIKeyForm) => {
      const response = await backendApi.post('/admin/env-vars', data);
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      return response.data;
    },
    onSuccess: (data) => {
      toast.success(data.message);
      setNewApiKeys([]);
    },
    onError: () => {
      toast.error('Failed to update API keys');
    }
  });

  const keysArray = apiKeys ? Object.entries(apiKeys).map(([key, value]) => ({
    id: key,
    name: key,
    value: value
  })) : [];

  useEffect(() => {
      if (apiKeys) {
        reset(apiKeys);
      }
  }, [apiKeys, reset]);

  const toggleKeyVisibility = (keyId: string) => {
    setVisibleKeys(prev => ({
      ...prev,
      [keyId]: !prev[keyId]
    }));
  }

  if (isLoading) {
    return <Card>
      <CardHeader>
        <CardTitle>Local .Env Manager</CardTitle>
        <CardDescription>Loading...</CardDescription>
      </CardHeader>
    </Card>;
  }

  return <Card>
    <CardHeader>
      <CardTitle>Local .Env Manager</CardTitle>
      <CardDescription>
        {isLocalMode() ? (
          <>
            Manage your local environment variables
          </>
        ) : (
          <>
            Local .Env Manager is only available in local mode.
          </>
        )}
      </CardDescription>
    </CardHeader>

    {isLocalMode() && (
        <CardContent>
            <form onSubmit={handleSubmit(handleSave)} className="space-y-4">
                {keysArray && keysArray?.map(key => (
                  
                    <div key={key.id} className="space-y-2">
                        <Label htmlFor={key.id}>{key.name}</Label>
                        <div className="relative">  
                            <Input 
                              id={key.id} 
                              type={visibleKeys[key.id] ? 'text' : 'password'}
                              placeholder={key.name}
                              {...register(key.id)}
                            />
                            <Button 
                              type="button" 
                              variant="ghost" 
                              className="absolute right-0 top-0 h-full px-3"
                              onClick={() => toggleKeyVisibility(key.id)}>
                                {visibleKeys[key.id] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </Button>
                        </div>
                        {errors[key.id] && <p className="text-red-500">{errors[key.id]?.message}</p>}
                    </div>
                    
                ))}

                <div className="space-y-4">  
                  {newApiKeys.map(entry => {
                    const keyIsDuplicate = checkKeyIsDuplicate(entry.key);
                    return (
                    
                    <div key={entry.id} className="space-y-2">
                      <Label htmlFor={entry.id}>{entry.key || "New API Key"}</Label>
                      <div className="space-x-2 flex">
                      <Input 
                        id={`${entry.id}-key`} 
                        type="text" 
                        placeholder="KEY" 
                        value={entry.key}
                        onChange={(e) => handleNewKeyChange(entry.id, 'key', e.target.value)}
                      />
                      <Input 
                        id={`${entry.id}-value`} 
                        type="text" 
                        placeholder="VALUE" 
                        value={entry.value} 
                        onChange={(e) => handleNewKeyChange(entry.id, 'value', e.target.value)}
                      />
                      <Button 
                        type="button" 
                        variant="outline" 
                        size="icon"
                        onClick={() => handleDeleteKey(entry.id)}
                      >
                        <Trash className="h-4 w-4" />
                      </Button>
                      </div>
                      {keyIsDuplicate && <p className="text-red-400 font-light">Key already exists</p>}
                    </div>
                  )})}
                </div>

                <div className="flex justify-between">
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={handleAddNewKey}
                  >
                    <Plus className="h-4 w-4" />
                    Add New Key
                  </Button>
                    <Button 
                      type="submit" 
                      variant="default"
                      disabled={(!isDirty && newApiKeys.length === 0) || hasEmptyKeyValues || hasDuplicateKeys()}
                    >Save</Button>
                </div>
            </form>
        </CardContent>
    )}
  </Card>
}