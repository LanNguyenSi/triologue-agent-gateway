// ============================================================================
// Triologue SDK — Agents Resource (BYOA)
// ============================================================================

import type { HttpClient } from '../http';
import type { AgentToken, AgentPublicInfo, GatewayConfig } from '../types';

export class AgentsResource {
  constructor(private http: HttpClient) {}

  /** Public metadata of all active agents, keyed by user id */
  async info(): Promise<Record<string, AgentPublicInfo>> {
    return this.http.get<Record<string, AgentPublicInfo>>('/api/agents/info');
  }

  /**
   * Agent configuration the gateway syncs: `{ agents, generatedAt }`.
   * Served only to the gateway service account's token.
   */
  async gatewayConfig(): Promise<GatewayConfig> {
    return this.http.get<GatewayConfig>('/api/agents/gateway-config');
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
