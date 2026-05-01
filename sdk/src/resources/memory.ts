// ============================================================================
// Triologue SDK — Memory Resource
// ============================================================================

import type { HttpClient } from '../http';
import type { MemoryEntry } from '../types';

export class MemoryResource {
  constructor(private http: HttpClient) {}

  /** List memory entries */
  async list(options?: {
    projectId?: string;
    scope?: string;
    memoryType?: string;
  }): Promise<MemoryEntry[]> {
    const params = new URLSearchParams();
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.scope) params.set('scope', options.scope);
    if (options?.memoryType) params.set('memoryType', options.memoryType);
    const qs = params.toString();
    return this.http.get(`/api/memory${qs ? `?${qs}` : ''}`);
  }

  /** Get a memory entry */
  async get(id: string): Promise<MemoryEntry> {
    return this.http.get<MemoryEntry>(`/api/memory/${id}`);
  }

  /** Create a memory entry */
  async create(data: {
    projectId?: string;
    roomId?: string;
    scope?: string;
    pluginId: string;
    moduleKey?: string;
    memoryType: string;
    title?: string;
    tags?: string[];
    payload: Record<string, unknown>;
    confidence?: number;
  }): Promise<MemoryEntry> {
    return this.http.post<MemoryEntry>('/api/memory', data);
  }

  /** Update a memory entry */
  async update(id: string, data: Partial<{
    title: string;
    tags: string[];
    payload: Record<string, unknown>;
    isPinned: boolean;
    confidence: number;
  }>): Promise<MemoryEntry> {
    return this.http.patch<MemoryEntry>(`/api/memory/${id}`, data);
  }

  /** Soft-delete a memory entry */
  async delete(id: string): Promise<void> {
    return this.http.delete(`/api/memory/${id}`);
  }

  /** Permanently delete a memory entry */
  async deletePermanent(id: string): Promise<void> {
    return this.http.delete(`/api/memory/${id}/permanent`);
  }
}
