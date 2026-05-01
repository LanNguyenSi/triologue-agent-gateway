// ============================================================================
// Triologue SDK — Rooms Resource
// ============================================================================

import type { HttpClient } from '../http';
import type { Room, Message } from '../types';

export class RoomsResource {
  constructor(private http: HttpClient) {}

  /** List all rooms the authenticated user can see */
  async list(): Promise<Room[]> {
    return this.http.get<Room[]>('/api/rooms');
  }

  /** Get a room by ID */
  async get(roomId: string): Promise<Room> {
    return this.http.get<Room>(`/api/rooms/${roomId}`);
  }

  /** Create a new room */
  async create(data: {
    name: string;
    description?: string;
    isPrivate?: boolean;
    roomType?: 'TRIOLOGUE' | 'DIRECT' | 'RESEARCH';
  }): Promise<Room> {
    return this.http.post<Room>('/api/rooms', data);
  }

  /** Delete a room */
  async delete(roomId: string): Promise<void> {
    return this.http.delete(`/api/rooms/${roomId}`);
  }

  /** Join a room */
  async join(roomId: string): Promise<void> {
    return this.http.post(`/api/rooms/${roomId}/join`);
  }

  /** Invite a user to a room */
  async invite(roomId: string, userId: string): Promise<void> {
    return this.http.post(`/api/rooms/${roomId}/invite`, { userId });
  }

  /** Get invitable users for a room */
  async invitable(roomId: string): Promise<{ id: string; username: string; displayName: string }[]> {
    return this.http.get(`/api/rooms/${roomId}/invitable`);
  }

  /** Get mentionable users in a room */
  async mentions(roomId: string): Promise<{ mentionKey: string; name: string }[]> {
    return this.http.get(`/api/rooms/${roomId}/mentions`);
  }

  /** Export room data */
  async export(roomId: string): Promise<unknown> {
    return this.http.get(`/api/rooms/${roomId}/export`);
  }
}
