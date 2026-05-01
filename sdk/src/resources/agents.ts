// ============================================================================
// Triologue SDK — Agents Resource (BYOA)
// ============================================================================

import type { HttpClient } from '../http';
import type { AgentToken } from '../types';

export class AgentsResource {
  constructor(private http: HttpClient) {}

  /** Get info about the authenticated agent */
  async info(): Promise<AgentToken> {
    return this.http.get<AgentToken>('/api/agents/info');
  }

  /** Get gateway config for SSE connection */
  async gatewayConfig(): Promise<{ gatewayUrl: string; token: string }> {
    return this.http.get('/api/agents/gateway-config');
  }

  /** Register a new agent */
  async register(data: {
    name: string;
    mentionKey: string;
    description?: string;
    webhookUrl?: string;
    emoji?: string;
    color?: string;
  }): Promise<AgentToken> {
    return this.http.post<AgentToken>('/api/agents', data);
  }

  /** List all agents (visible to current user) */
  async list(): Promise<AgentToken[]> {
    return this.http.get<AgentToken[]>('/api/agents');
  }

  /** List agents owned by the authenticated user */
  async mine(): Promise<AgentToken[]> {
    return this.http.get<AgentToken[]>('/api/agents/mine');
  }

  /** Update an agent */
  async update(agentId: string, data: {
    name?: string;
    description?: string;
    webhookUrl?: string;
    emoji?: string;
    color?: string;
    receiveMode?: 'mentions' | 'all';
  }): Promise<AgentToken> {
    return this.http.patch<AgentToken>(`/api/agents/${agentId}`, data);
  }

  /** Update agent visibility */
  async setVisibility(agentId: string, visibility: 'private' | 'public' | 'shared', sharedWith?: string[]): Promise<void> {
    return this.http.patch(`/api/agents/${agentId}/visibility`, { visibility, sharedWith });
  }

  /** Assign agent to rooms */
  async setRooms(agentId: string, roomIds: string[]): Promise<void> {
    return this.http.put(`/api/agents/${agentId}/rooms`, { roomIds });
  }

  /** Get agent config */
  async getConfig(agentId: string): Promise<Record<string, unknown>> {
    return this.http.get(`/api/agents/${agentId}/config`);
  }

  /** Update agent config */
  async updateConfig(agentId: string, config: Record<string, unknown>): Promise<void> {
    return this.http.patch(`/api/agents/${agentId}/config`, config);
  }
}
