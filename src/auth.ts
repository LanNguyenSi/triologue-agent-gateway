/**
 * Token authentication — validates byoa_ tokens.
 *
 * Two modes:
 * 1. Config file (agents.json) — fallback, no DB dependency
 * 2. Triologue API — dynamic, reads from DB via /api/agents/gateway-config
 *
 * On startup: tries API first, falls back to agents.json.
 * Periodic sync: refreshes from API every SYNC_INTERVAL_MS.
 *
 * Token rotation (see rotateToken below) is layered on top of this store,
 * entirely in-memory and independent of the periodic API/file sync. See the
 * comment above rotateToken for why, and BYOA.md's Token Rotation section
 * for the operator-facing limitation this implies.
 */

import fs from 'fs';
import crypto from 'crypto';
import type { AgentInfo } from './types.js';

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

/**
 * How long a rotated-away token keeps authenticating after POST
 * /byoa/sse/tokens/rotate mints its replacement. Keep this short (Risk note
 * on the rotation task: "keep the grace window short and log rotations").
 * Falls back to the 5-minute default on an unset, non-numeric, or
 * non-positive value.
 */
function parseGraceMs(): number {
  const raw = process.env.TOKEN_ROTATE_GRACE_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60_000;
}
export const TOKEN_ROTATE_GRACE_MS = parseGraceMs();

let agents: AgentConfig[] = [];
let syncInterval: ReturnType<typeof setInterval> | null = null;

// ── Load from file (fallback) ──

/**
 * @param filePath Defaults to the module-level AGENTS_FILE constant. Exposed
 *   as a parameter (rather than hard-coded) so tests can point this at a
 *   real temp file, including a corrupt one, and exercise the JSON.parse
 *   failure branch directly instead of relying on AGENTS_FILE happening to
 *   be unreadable in CI.
 */
export function loadAgents(filePath: string = AGENTS_FILE): void {
  try {
    agents = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    console.log(`📋 Loaded ${agents.length} agents from ${filePath}`);
  } catch (err: any) {
    console.warn(`⚠️ Could not load ${filePath}: ${err.message} - will try API sync`);
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

// ── Token rotation (in-memory, layered on top of tokenMap) ──
//
// tokenMap above is a read-through mirror of an upstream source (the
// Triologue DB via syncFromApi, or agents.json) that this gateway does not
// own — buildTokenIndex() rebuilds it wholesale on every sync and has no
// notion of "this token was rotated". A real rotation would need the
// upstream source to also forget the old token and learn the new one, which
// requires a Triologue API this gateway does not have (see byoa-sse.ts's
// POST /tokens/rotate handler and BYOA.md's Token Rotation section).
//
// Until that exists, rotation state lives only here, in this process's
// memory, layered in front of tokenMap:
//   - activeRotatedTokens: newest token in an agent's rotation chain -> agent
//   - graceTokens: a token that was just rotated away -> {newToken, agent,
//     expiresAt}; still authenticates until expiresAt
//   - rotatedAwayTokens: tokens whose grace has fully elapsed; rejected even
//     if tokenMap (from the next upstream sync) still reports them as valid,
//     since the upstream source doesn't know this token was ever rotated
//
// Limitation (documented, not silently swallowed): none of this survives a
// process restart, and a periodic upstream resync cannot be told about a
// rotation performed here — see BYOA.md.

interface GraceTokenEntry {
  newToken: string;
  agent: AgentInfo;
  expiresAt: number; // epoch ms
}

const activeRotatedTokens = new Map<string, AgentInfo>();
const graceTokens = new Map<string, GraceTokenEntry>();
const rotatedAwayTokens = new Set<string>();

export function authenticateToken(token: string): AgentInfo | null {
  // MUTATION GUARD: dropping this check would let a fully-expired rotated
  // token authenticate again once the next upstream sync re-adds the
  // original token to tokenMap below.
  if (rotatedAwayTokens.has(token)) return null;

  const rotated = activeRotatedTokens.get(token);
  if (rotated) return rotated;

  const grace = graceTokens.get(token);
  if (grace) {
    if (Date.now() < grace.expiresAt) return grace.agent;
    // Grace window elapsed: stop honoring it, and make sure it can never
    // authenticate again via tokenMap either.
    graceTokens.delete(token);
    rotatedAwayTokens.add(token);
    return null;
  }

  return tokenMap.get(token) ?? null;
}

export interface RotateTokenResult {
  token: string;
  agent: AgentInfo;
  oldTokenExpiresAt: number; // epoch ms
}

/**
 * Rotate the token used to authenticate this request. The presented token
 * must already be valid (checked via authenticateToken); the caller
 * (byoa-sse.ts's authenticateSSE middleware) already enforces this before
 * the route handler runs, so only the token's own owner can ever rotate it.
 *
 * Idempotent within the grace window: if `presentedToken` is itself a token
 * that was already rotated away (and is still inside its grace window),
 * this returns the same {token, oldTokenExpiresAt} as the original
 * rotation instead of minting another link in the chain — a retried
 * rotate() call is safe. Rotating the current (non-grace) token always
 * mints a fresh token and starts a fresh, independent grace window for
 * whichever token was just used; an earlier "old-old" token already in
 * grace keeps its own original expiry untouched by later rotations.
 */
export function rotateToken(presentedToken: string): RotateTokenResult | null {
  const agent = authenticateToken(presentedToken);
  if (!agent) return null;

  const existingGrace = graceTokens.get(presentedToken);
  if (existingGrace) {
    return {
      token: existingGrace.newToken,
      agent: existingGrace.agent,
      oldTokenExpiresAt: existingGrace.expiresAt,
    };
  }

  const newToken = `byoa_${crypto.randomBytes(24).toString('hex')}`;
  const expiresAt = Date.now() + TOKEN_ROTATE_GRACE_MS;

  activeRotatedTokens.delete(presentedToken);
  graceTokens.set(presentedToken, { newToken, agent, expiresAt });
  activeRotatedTokens.set(newToken, agent);

  return { token: newToken, agent, oldTokenExpiresAt: expiresAt };
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
