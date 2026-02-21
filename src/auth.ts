/**
 * Token authentication — validates byoa_ tokens.
 * 
 * Two modes:
 * 1. Config file (agents.json) — simple, no DB dependency
 * 2. Triologue API — dynamic, reads from DB (future)
 * 
 * Currently uses config file. Switch to API when /api/agents/validate exists.
 */

import fs from 'fs';
import type { AgentInfo } from './types';

interface AgentConfig {
  token: string;
  name: string;
  username: string;
  userId: string;
  mentionKey: string;
  webhookUrl?: string;
  webhookSecret?: string;
  trustLevel: 'standard' | 'elevated';
  emoji: string;
  color?: string;
  connectionType?: 'webhook' | 'websocket' | 'both';
  receiveMode?: 'mentions' | 'all';
}

// ── Load agent registry ──

const AGENTS_FILE = process.env.AGENTS_CONFIG ?? './agents.json';
let agents: AgentConfig[] = [];

export function loadAgents(): void {
  try {
    agents = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
    console.log(`📋 Loaded ${agents.length} agents from ${AGENTS_FILE}`);
  } catch (err: any) {
    console.error(`❌ Could not load ${AGENTS_FILE}: ${err.message}`);
    console.error('   Create agents.json with agent configs (see BYOA_V2.md)');
    process.exit(1);
  }
}

// ── Token lookup ──

const tokenMap = new Map<string, AgentInfo>();

export function buildTokenIndex(): void {
  tokenMap.clear();
  for (const a of agents) {
    tokenMap.set(a.token, {
      id: a.userId,
      name: a.name,
      userId: a.userId,
      username: a.username,
      mentionKey: a.mentionKey,
      webhookUrl: a.webhookUrl ?? null,
      webhookSecret: a.webhookSecret ?? null,
      trustLevel: a.trustLevel,
      emoji: a.emoji,
      color: a.color ?? null,
      connectionType: a.connectionType ?? 'both',
      receiveMode: a.receiveMode ?? 'mentions',
    });
  }
}

export function authenticateToken(token: string): AgentInfo | null {
  return tokenMap.get(token) ?? null;
}

export function getAgentByUsername(username: string): AgentInfo | null {
  for (const agent of tokenMap.values()) {
    if (agent.username === username) return agent;
  }
  return null;
}

export function getWebhookAgents(): AgentInfo[] {
  return [...tokenMap.values()].filter(
    a => a.connectionType === 'webhook' || a.connectionType === 'both'
  ).filter(a => a.webhookUrl);
}

export function getAllAgents(): AgentInfo[] {
  return [...tokenMap.values()];
}
