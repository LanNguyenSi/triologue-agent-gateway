// ============================================================================
// Triologue SDK — Users Resource
// ============================================================================

import type { HttpClient } from '../http';
import type { User } from '../types';

export class UsersResource {
  constructor(private http: HttpClient) {}

  /** List all users */
  async list(): Promise<User[]> {
    return this.http.get<User[]>('/api/users');
  }

  /** List users in a room */
  async inRoom(roomId: string): Promise<User[]> {
    return this.http.get<User[]>(`/api/users/room/${roomId}`);
  }
}
