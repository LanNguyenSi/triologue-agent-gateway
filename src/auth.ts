/**
 * Token authentication — validates byoa_ tokens.
 * 
 * Two modes:
 * 1. Config file (agents.json) — fallback, no DB dependency
 * 2. Triologue API — dynamic, reads from DB via /api/agents/gateway-config
 * 
 * On startup: tries API first, falls back to agents.json.
 * Periodic sync: refreshes from API every SYNC_INTERVAL_MS.
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
  delivery?: 'webhook' | 'openclaw-inject';
}

// ── Config ──

const AGENTS_FILE = process.env.AGENTS_CONFIG ?? './agents.json';
const TRIOLOGUE_URL = process.env.TRIOLOGUE_URL ?? 'http://localhost:4001';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? '';
const SYNC_INTERVAL_MS = 60_000; // Re-sync from DB every 60s

let agents: AgentConfig[] = [];
let syncInterval: ReturnType<typeof setInterval> | null = null;

// ── Load from file (fallback) ──

export function loadAgents(): void {
  try {
    agents = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
    console.log(`📋 Loaded ${agents.length} agents from ${AGENTS_FILE}`);
  } catch (err: any) {
    console.warn(`⚠️ Could not load ${AGENTS_FILE}: ${err.message} — will try API sync`);
    agents = [];
  }
}

// ── Load from Triologue API ──

export async function syncFromApi(): Promise<boolean> {
  try {
    const res = await fetch(`${TRIOLOGUE_URL}/api/agents/gateway-config`, {
      headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`⚠️ API sync failed: ${res.status} ${res.statusText}`);
      return false;
    }

    const data = await res.json();
    if (!data.agents || !Array.isArray(data.agents)) {
      console.warn('⚠️ API sync: invalid response format');
      return false;
    }

    const oldCount = agents.length;
    agents = data.agents;
    buildTokenIndex();

    if (agents.length !== oldCount) {
      console.log(`🔄 API sync: ${oldCount} → ${agents.length} agents (${data.generatedAt})`);
    }

    return true;
  } catch (err: any) {
    console.warn(`⚠️ API sync error: ${err.message}`);
    return false;
  }
}

/**
 * Start periodic sync from Triologue API.
 * First sync is immediate; falls back to agents.json if API unavailable.
 */
export async function startSync(): Promise<void> {
  const ok = await syncFromApi();
  if (!ok && agents.length === 0) {
    console.error('❌ No agents from API or file — gateway has no agents to route');
  } else if (ok) {
    console.log(`✅ Initial API sync: ${agents.length} agents`);
  } else {
    console.log(`📋 Using ${agents.length} agents from ${AGENTS_FILE} (API unavailable)`);
  }

  // Periodic refresh
  syncInterval = setInterval(async () => {
    await syncFromApi();
  }, SYNC_INTERVAL_MS);
}

export function stopSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
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
      delivery: a.delivery ?? 'webhook',
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
  ).filter(a => a.webhookUrl || a.delivery === 'openclaw-inject');
}

export function getAllAgents(): AgentInfo[] {
  return [...tokenMap.values()];
}
