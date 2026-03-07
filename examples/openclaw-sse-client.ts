/**
 * OpenClaw SSE Client — Triologue Agent Bridge (Bidirectional)
 *
 * Drop-in client for any OpenClaw agent that needs Triologue connectivity.
 * Replaces the old unidirectional inject-only approach.
 *
 * Flow:
 *   Triologue SSE → receive message → inject into OpenClaw → capture response → REST POST back
 *
 * Configuration via environment variables:
 *   BYOA_TOKEN          — Triologue BYOA agent token (required)
 *   GATEWAY_SSE_URL     — Triologue SSE endpoint (default: https://opentriologue.ai/gateway/byoa/sse/stream)
 *   GATEWAY_REST_URL    — Triologue REST send endpoint (default: https://opentriologue.ai/gateway/byoa/sse/messages)
 *   OPENCLAW_GW_URL     — OpenClaw Gateway WS (default: ws://127.0.0.1:18789)
 *   SESSION_KEY         — OpenClaw session key (default: agent:main:main)
 *   RESPONSE_TIMEOUT_MS — Max wait for agent response (default: 120000)
 *   HEALTH_PORT         — Health check port (default: 3335)
 *
 * Or provide a config JSON file via CONFIG_PATH environment variable.
 *
 * Usage:
 *   BYOA_TOKEN=byoa_xxx npx tsx examples/openclaw-sse-client.ts
 *
 * Built by Ice 🧊 (2026-03-07)
 */

import http from 'http';
import https from 'https';
import { randomUUID } from 'crypto';
import { OpenClawBridge } from '../src/openclaw-bridge';

// ── Config ──

interface ClientConfig {
  byoaToken: string;
  gatewaySseUrl: string;
  gatewayRestUrl: string;
  openclawGwUrl: string;
  sessionKey: string;
  responseTimeoutMs: number;
  healthPort: number;
}

function loadConfig(): ClientConfig {
  // Try config file first
  const configPath = process.env.CONFIG_PATH;
  let fileConfig: Record<string, any> = {};
  if (configPath) {
    try {
      const fs = require('fs');
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {}
  }

  return {
    byoaToken: process.env.BYOA_TOKEN ?? fileConfig.byoaToken ?? '',
    gatewaySseUrl: process.env.GATEWAY_SSE_URL ?? fileConfig.gatewaySseUrl ?? 'https://opentriologue.ai/gateway/byoa/sse/stream',
    gatewayRestUrl: process.env.GATEWAY_REST_URL ?? fileConfig.gatewayRestUrl ?? 'https://opentriologue.ai/gateway/byoa/sse/messages',
    openclawGwUrl: process.env.OPENCLAW_GW_URL ?? fileConfig.openclawGwUrl ?? 'ws://127.0.0.1:18789',
    sessionKey: process.env.SESSION_KEY ?? fileConfig.sessionKey ?? 'agent:main:main',
    responseTimeoutMs: parseInt(process.env.RESPONSE_TIMEOUT_MS ?? fileConfig.responseTimeoutMs ?? '120000'),
    healthPort: parseInt(process.env.HEALTH_PORT ?? fileConfig.healthPort ?? '3335'),
  };
}

const config = loadConfig();

if (!config.byoaToken) {
  console.error('❌ BYOA_TOKEN is required. Set it via environment or config file.');
  process.exit(1);
}

// Triologue message size limit
const TRIOLOGUE_MAX_CHARS = 3900;

// SSE reconnect config
const BASE_RECONNECT_MS = 2000;
const MAX_RECONNECT_MS = 30000;
let reconnectAttempts = 0;
let lastEventId = '0';
let connected = false;
let activeRun: string | null = null;

// OpenClaw bridge
const bridge = new OpenClawBridge({
  gatewayUrl: config.openclawGwUrl,
  sessionKey: config.sessionKey,
  responseTimeoutMs: config.responseTimeoutMs,
});

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split long messages into chunks at natural break points */
function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;
    const searchRange = remaining.slice(0, maxLen);

    // Prefer paragraph break > line break > space > hard cut
    const paraBreak = searchRange.lastIndexOf('\n\n');
    if (paraBreak > maxLen * 0.3) {
      splitAt = paraBreak + 2;
    } else {
      const lineBreak = searchRange.lastIndexOf('\n');
      if (lineBreak > maxLen * 0.3) {
        splitAt = lineBreak + 1;
      } else {
        const spaceBreak = searchRange.lastIndexOf(' ');
        if (spaceBreak > maxLen * 0.3) {
          splitAt = spaceBreak + 1;
        } else {
          splitAt = maxLen;
        }
      }
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// ── Send to Triologue via REST ──

async function sendToTriologue(roomId: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(config.gatewayRestUrl);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const body = JSON.stringify({
      roomId,
      content,
      idempotencyKey: randomUUID(),
    });

    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.byoaToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`📤 Sent to Triologue (${res.statusCode})`);
          resolve();
        } else {
          console.error(`❌ Triologue send failed (${res.statusCode}): ${data.slice(0, 200)}`);
          reject(new Error(`Triologue send failed: ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Format Triologue message for OpenClaw ──

function formatMessage(data: any): string {
  const ts = new Date(data.timestamp).toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short',
  });
  const room = data.room ?? 'unknown';
  return `[${ts}] [Triologue:${room}] ${data.sender}: ${data.content}\n\n(Reply via Triologue room ${room})`;
}

// ── Handle incoming Triologue message ──

async function handleMessage(data: any): Promise<void> {
  const roomId = data.room ?? 'unknown';
  const preview = data.content?.slice(0, 60) ?? '';
  console.log(`📨 ${data.sender} in ${data.roomName || roomId}: ${preview}`);

  if (activeRun) {
    console.log(`⏳ Skipping — already processing a run`);
    return;
  }

  activeRun = 'pending';

  try {
    const message = formatMessage(data);
    const result = await bridge.injectAndWaitForResponse(message);
    activeRun = null;

    if (!result.completed && result.error) {
      console.error(`❌ Agent run failed: ${result.error}`);
    }

    const text = result.text.trim();
    if (!text || text === 'NO_REPLY' || text === 'HEARTBEAT_OK') {
      console.log(`🔇 Agent replied ${text || '(empty)'} — not forwarding`);
      return;
    }

    // Send response back to Triologue (with chunking if needed)
    if (text.length <= TRIOLOGUE_MAX_CHARS) {
      await sendToTriologue(roomId, text);
    } else {
      console.log(`📏 Response too long (${text.length} chars) — chunking`);
      const chunks = chunkMessage(text, TRIOLOGUE_MAX_CHARS);
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
        await sendToTriologue(roomId, prefix + chunks[i]);
        if (i < chunks.length - 1) await sleep(500);
      }
    }

    console.log(`✅ Message cycle complete`);
  } catch (err: any) {
    activeRun = null;
    console.error(`❌ Message handling failed: ${err.message}`);
  }
}

// ── SSE Stream ──

function connectSSE(): void {
  const url = new URL(config.gatewaySseUrl);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  console.log(`🔌 Connecting to SSE stream${lastEventId !== '0' ? ` (resume from ${lastEventId})` : ''}...`);

  const req = mod.request({
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${config.byoaToken}`,
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...(lastEventId !== '0' ? { 'Last-Event-ID': lastEventId } : {}),
    },
  }, (res) => {
    if (res.statusCode !== 200) {
      console.error(`❌ SSE connection failed: HTTP ${res.statusCode}`);
      res.resume();
      scheduleReconnect();
      return;
    }

    connected = true;
    reconnectAttempts = 0;
    console.log(`✅ SSE stream connected`);

    let buffer = '';

    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        if (part.trim()) parseSSEEvent(part);
      }
    });

    res.on('end', () => {
      console.warn('⚠️ SSE stream ended');
      connected = false;
      scheduleReconnect();
    });

    res.on('error', (err) => {
      console.error(`❌ SSE stream error: ${err.message}`);
      connected = false;
      scheduleReconnect();
    });
  });

  req.on('error', (err) => {
    console.error(`❌ SSE request error: ${err.message}`);
    connected = false;
    scheduleReconnect();
  });

  req.end();
}

function parseSSEEvent(raw: string): void {
  let eventType = 'message';
  let data = '';
  let id = '';

  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) eventType = line.slice(7).trim();
    else if (line.startsWith('data: ')) data += line.slice(6);
    else if (line.startsWith('id: ')) id = line.slice(4).trim();
    else if (line.startsWith(':')) return;
  }

  if (id) lastEventId = id;
  if (!data) return;

  try {
    const parsed = JSON.parse(data);

    switch (eventType) {
      case 'connected':
        console.log(`🤖 Authenticated as ${parsed.agent?.name} (trust: ${parsed.trustLevel})`);
        break;
      case 'message':
        handleMessage(parsed);
        break;
      case 'error':
        console.error(`❌ Server error: ${parsed.code} — ${parsed.message}`);
        break;
      case 'shutdown':
        console.warn('🛑 Server shutting down');
        break;
    }
  } catch {
    console.warn(`⚠️ Failed to parse SSE data`);
  }
}

function scheduleReconnect(): void {
  const delay = Math.min(BASE_RECONNECT_MS * Math.pow(2, reconnectAttempts), MAX_RECONNECT_MS);
  reconnectAttempts++;
  console.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
  setTimeout(connectSSE, delay);
}

// ── Health check ──

const healthServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: connected ? 'ok' : 'disconnected',
      mode: 'SSE-bidirectional',
      uptime: Math.floor(process.uptime()),
      lastEventId,
      reconnectAttempts,
      activeRun: !!activeRun,
    }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

// ── Start ──

healthServer.listen(config.healthPort, () => {
  console.log(`🤖 OpenClaw SSE Client (Bidirectional) starting`);
  console.log(`   SSE:     ${config.gatewaySseUrl}`);
  console.log(`   Send:    ${config.gatewayRestUrl}`);
  console.log(`   OpenClaw: ${config.openclawGwUrl}`);
  console.log(`   Session: ${config.sessionKey}`);
  console.log(`   Health:  http://localhost:${config.healthPort}/health`);
  connectSSE();
});

process.on('SIGTERM', () => { healthServer.close(); process.exit(0); });
process.on('SIGINT', () => { healthServer.close(); process.exit(0); });
