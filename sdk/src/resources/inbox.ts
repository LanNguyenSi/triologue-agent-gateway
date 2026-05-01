// ============================================================================
// Triologue SDK — Inbox Resource
// ============================================================================

import type { HttpClient } from '../http';
import type { InboxItem } from '../types';

export class InboxResource {
  constructor(private http: HttpClient) {}

  /** List inbox items */
  async list(): Promise<InboxItem[]> {
    return this.http.get<InboxItem[]>('/api/inbox');
  }

  /** Mark an item as read */
  async markRead(id: string): Promise<void> {
    return this.http.patch(`/api/inbox/${id}/read`);
  }

  /** Mark all items as read */
  async markAllRead(): Promise<void> {
    return this.http.patch('/api/inbox/read-all');
  }

  /** Delete an inbox item */
  async delete(id: string): Promise<void> {
    return this.http.delete(`/api/inbox/${id}`);
  }

  /** Delete all inbox items */
  async deleteAll(): Promise<void> {
    return this.http.delete('/api/inbox');
  }
}
