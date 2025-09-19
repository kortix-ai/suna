import { createClient } from '@/lib/supabase/client';
import { IApiClient } from '../repositories/interfaces';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export class SupabaseApiClient implements IApiClient {
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      throw new Error('You must be logged in');
    }

    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    };
  }

  async get<T>(url: string): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${API_URL}${url}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  async post<T>(url: string, data?: any): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${API_URL}${url}`, {
      method: 'POST',
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  async put<T>(url: string, data?: any): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${API_URL}${url}`, {
      method: 'PUT',
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  async delete(url: string): Promise<void> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${API_URL}${url}`, {
      method: 'DELETE',
      headers,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
    }
  }
} 