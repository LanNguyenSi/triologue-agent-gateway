/**
 * Triologue Agent Gateway
 *
 * Public service that lets any BYOA agent connect via:
 *   - WebSocket (persistent agents, terminal agents)
 *   - REST POST /send (webhook bots)
 *
 * Bridges agents ↔ Triologue server (Socket.io).
 * When Matrix migration happens, swap TriologueBridge → MatrixBridge.
 */

import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { loadAgents, buildTokenIndex, authenticateToken, getWebhookAgents, getAgentByUsername } from './auth';
import { TriologueBridge } from './triologue-bridge';
import { shouldDeliver } from './loop-guard';
import { injectToSession } from './openclaw-inject';
import type { AgentInfo, WsClient } from './types';

// ── Config ──

const PORT = Number(process.env.PORT ?? 9500);
const TRIOLOGUE_URL = process.env.TRIOLOGUE_URL ?? 'http://localhost:4001';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN!;
const GATEWAY_USERNAME = process.env.GATEWAY_USERNAME ?? 'gateway';

if (!GATEWAY_TOKEN) {
  console.error('❌ GATEWAY_TOKEN required (BYOA token for the gateway agent)');
  process.exit(1);
}

// ── Load agents ──

loadAgents();
buildTokenIndex();

// ── Express ──

const app = express();
app.use(express.json());
const server = createServer(app);

// ── Active WebSocket clients ──

const clients = new Map<string, WsClient>(); // agentId → client

// ── Triologue Bridge ──

const bridge = new TriologueBridge({
  trioUrl: TRIOLOGUE_URL,
  username: GATEWAY_USERNAME,
  aiToken: GATEWAY_TOKEN,
  userType: 'AI_AGENT',
});

// ── Message routing: Triologue → Agents ──

bridge.onMessage((msg) => {
  console.log(`📨 ${msg.senderUsername} (${msg.senderType}) in ${msg.roomId}: ${msg.content.slice(0, 60)}`);
  const senderIsAgent = msg.senderType === 'ai';
  const senderAgent = getAgentByUsername(msg.senderUsername);

  // ── WebSocket agents: forward based on receiveMode + trust ──
  for (const [agentId, client] of clients) {
    // Don't send back to sender
    if (client.agent.username === msg.senderUsername) continue;
    if (client.agent.userId === msg.senderId) continue;

    // receiveMode check (before loop guard — @mentions always get through)
    const mentioned = msg.content.toLowerCase().includes(`@${client.agent.mentionKey}`);
    if (client.agent.receiveMode === 'mentions' && !mentioned) continue;

    // Loop guard (skip for direct @mentions — user explicitly wants this agent)
    if (!mentioned && !shouldDeliver(client.agent.trustLevel, senderIsAgent, msg.senderUsername, client.agent.username)) {
      continue;
    }

    // For openclaw-inject agents: use inject instead of WebSocket forwarding
    if (client.agent.delivery === 'openclaw-inject') {
      const injectMsg = `[Triologue:${msg.roomId}] ${msg.senderUsername}: ${msg.content}\n\n(Reply with: /root/.openclaw/workspace/send-to-triologue.sh ${msg.roomId} "<your message>")`;
      injectToSession(injectMsg)
        .then(() => console.log(`[openclaw-inject:${client.agent.mentionKey}] ✅`))
        .catch(err => console.warn(`[openclaw-inject:${client.agent.mentionKey}] ⚠️ ${err.message}`));
      continue;
    }

    // Send via WebSocket for other agents
    safeSend(client.ws, {
      type: 'message',
      id: msg.id,
      room: msg.roomId,
      roomName: msg.roomName,
      sender: msg.senderUsername,
      senderDisplayName: msg.senderUsername,
      senderType: msg.senderType,
      content: msg.content,
      timestamp: msg.timestamp,
    });
  }

  // ── Non-WebSocket agents: dispatch on @mention via webhook or openclaw-inject ──
  for (const agent of getWebhookAgents()) {
    if (agent.username === msg.senderUsername) continue;
    if (!shouldDeliver(agent.trustLevel, senderIsAgent, msg.senderUsername, agent.username)) continue;

    const mentioned = msg.content.toLowerCase().includes(`@${agent.mentionKey}`);
    if (!mentioned) continue;

    // Don't dispatch if agent is connected via WebSocket (already got it)
    if (clients.has(agent.userId)) continue;

    // ── OpenClaw inject: inject directly into local OpenClaw session ──
    if (agent.delivery === 'openclaw-inject') {
      const injectMsg = `[Triologue:${msg.roomId}] ${msg.senderUsername}: ${msg.content}\n\n(Reply to this room: ROOM_ID=${msg.roomId})`;
      injectToSession(injectMsg)
        .then(() => console.log(`[openclaw-inject:${agent.mentionKey}] ✅`))
        .catch(err => console.warn(`[openclaw-inject:${agent.mentionKey}] ⚠️ ${err.message}`));
      continue;
    }

    // ── Standard webhook dispatch ──
    if (!agent.webhookUrl) continue;

    const payload = JSON.stringify({
      messageId: msg.id,
      sender: msg.senderUsername,
      senderType: msg.senderType,
      content: msg.content,
      room: msg.roomId,
      timestamp: msg.timestamp,
    });

    fetch(agent.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Triologue-Secret': agent.webhookSecret ?? '',
        'X-Triologue-Agent': agent.mentionKey,
      },
      body: payload,
    })
      .then(() => console.log(`[webhook:${agent.mentionKey}] ✅`))
      .catch(err => console.warn(`[webhook:${agent.mentionKey}] ⚠️ ${err.message}`));
  }
});

// ── REST: Agent sends a message ──

app.post('/send', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const agent = authenticateToken(token);
  if (!agent) return res.status(403).json({ error: 'Invalid token' });

  const { room, content, replyTo } = req.body;
  if (!room || !content) return res.status(400).json({ error: 'room and content required' });

  try {
    await bridge.sendAsAgent(token, room, content);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── REST: Health ──

app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    connectedAgents: clients.size,
    agents: [...clients.values()].map(c => ({
      name: c.agent.name,
      emoji: c.agent.emoji,
      connectedSince: new Date(c.connectedAt).toISOString(),
    })),
    uptime: Math.floor(process.uptime()),
  });
});

// ── WebSocket Server ──

const wss = new WebSocketServer({ server, path: '/byoa/ws' });

wss.on('connection', (ws) => {
  let client: WsClient | null = null;

  // Auth timeout: 10s
  const authTimeout = setTimeout(() => {
    safeSend(ws, { type: 'auth_error', error: 'Auth timeout (10s)' });
    ws.close(4001, 'Auth timeout');
  }, 10_000);

  ws.on('message', async (data) => {
    let event: any;
    try {
      event = JSON.parse(data.toString());
    } catch {
      safeSend(ws, { type: 'error', code: 'INVALID_JSON', message: 'Invalid JSON' });
      return;
    }

    // ── Auth ──
    if (event.type === 'auth' && !client) {
      clearTimeout(authTimeout);

      const agent = authenticateToken(event.token);
      if (!agent) {
        safeSend(ws, { type: 'auth_error', error: 'Invalid or inactive token' });
        ws.close(4003, 'Auth failed');
        return;
      }

      // Disconnect existing connection for same agent (replace)
      const existing = clients.get(agent.userId);
      if (existing) {
        safeSend(existing.ws, { type: 'error', code: 'REPLACED', message: 'New connection replaced this one' });
        existing.ws.close(4000, 'Replaced');
      }

      client = { ws, agent, connectedAt: Date.now() };
      clients.set(agent.userId, client);

      // Store token on client for sendAsAgent
      (client as any)._token = event.token;

      // Fetch agent's rooms
      const agentRooms = await bridge.getAgentRooms(event.token, agent.username);

      safeSend(ws, {
        type: 'auth_ok',
        agent: {
          name: agent.name,
          username: agent.username,
          mentionKey: agent.mentionKey,
          emoji: agent.emoji,
          trustLevel: agent.trustLevel,
        },
        rooms: agentRooms,
      });

      console.log(`✅ ${agent.emoji} ${agent.name} connected (WebSocket)`);
      return;
    }

    // ── All other events need auth ──
    if (!client) {
      safeSend(ws, { type: 'error', code: 'NOT_AUTHENTICATED', message: 'Send auth first' });
      return;
    }

    // ── Message ──
    if (event.type === 'message') {
      if (!event.room || !event.content) {
        safeSend(ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'room and content required' });
        return;
      }

      try {
        const token = (client as any)._token;
        await bridge.sendAsAgent(token, event.room, event.content);
        safeSend(ws, { type: 'message_sent', room: event.room });
      } catch (err: any) {
        safeSend(ws, { type: 'error', code: 'SEND_FAILED', message: err.message });
      }
      return;
    }

    // ── Pong ──
    if (event.type === 'pong') return;

    // ── Unknown ──
    safeSend(ws, { type: 'error', code: 'UNKNOWN_EVENT', message: `Unknown: ${event.type}` });
  });

  // Ping every 30s
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) safeSend(ws, { type: 'ping' });
  }, 30_000);

  ws.on('close', () => {
    clearTimeout(authTimeout);
    clearInterval(pingInterval);
    if (client) {
      clients.delete(client.agent.userId);
      console.log(`❌ ${client.agent.emoji} ${client.agent.name} disconnected`);
    }
  });

  ws.on('error', (err) => {
    console.error(`WS error: ${err.message}`);
  });
});

// ── Helper ──

function safeSend(ws: WebSocket, data: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ── Start ──

async function start(): Promise<void> {
  try {
    await bridge.connect();
  } catch (err: any) {
    console.error(`❌ Failed to connect to Triologue: ${err.message}`);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`🤖 Agent Gateway running on port ${PORT}`);
    console.log(`   WebSocket: ws://localhost:${PORT}/byoa/ws`);
    console.log(`   REST:      http://localhost:${PORT}/send`);
    console.log(`   Health:    http://localhost:${PORT}/health`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down...');
    bridge.disconnect();
    for (const [, c] of clients) c.ws.close(1001, 'Server shutting down');
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
