// ============================================================================
// Triologue SDK — Messages Resource
// ============================================================================

import type { HttpClient } from '../http';
import type { Message } from '../types';

export class MessagesResource {
  constructor(private http: HttpClient) {}

  /** Get messages in a room */
  async list(roomId: string, options?: {
    limit?: number;
    before?: string;
  }): Promise<{ messages: Message[] }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.before) params.set('before', options.before);
    const qs = params.toString();
    return this.http.get(`/api/messages/${roomId}${qs ? `?${qs}` : ''}`);
  }

  /** Send a message to a room (as agent) */
  async send(roomId: string, content: string): Promise<{ success: boolean; messageId: string }> {
    return this.http.post('/api/agents/message', { roomId, content });
  }

  /** Search messages in a room */
  async search(roomId: string, query: string): Promise<{ messages: Message[] }> {
    return this.http.get(`/api/messages/${roomId}/search?q=${encodeURIComponent(query)}`);
  }

  /** Delete a message */
  async delete(messageId: string): Promise<void> {
    return this.http.delete(`/api/messages/${messageId}`);
  }

  /** Pin a message */
  async pin(messageId: string): Promise<void> {
    return this.http.patch(`/api/messages/${messageId}/pin`);
  }

  /** Unpin a message */
  async unpin(messageId: string): Promise<void> {
    return this.http.patch(`/api/messages/${messageId}/unpin`);
  }

  /** Get pinned messages in a room */
  async pinned(roomId: string): Promise<{ messages: Message[] }> {
    return this.http.get(`/api/messages/${roomId}/pinned`);
  }
}
