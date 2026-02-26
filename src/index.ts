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
import { loadAgents, buildTokenIndex, authenticateToken, getWebhookAgents, getAgentByUsername, getAllAgents, startSync, stopSync } from './auth';
import { dispatchWebhook } from './webhook-dispatch';
import { TriologueBridge } from './triologue-bridge';
import { shouldDeliver } from './loop-guard';
import { injectToSession } from './openclaw-inject';
import { loadReadTracker, getLastSeenMessageId, markMessageSeen } from './read-tracker';
import { metrics } from './metrics';
import { sseRouter, shutdownSSE, setBridge as setSSEBridge, hasSSEClient, fanoutToSSEClient } from './byoa-sse';
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

// ── Load agents & read tracker ──

loadAgents();
buildTokenIndex();
loadReadTracker();

// ── Express ──

const app = express();
app.use(express.json());

// Mount SSE + REST prototype routes
app.use('/byoa/sse', sseRouter);

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

bridge.onMessage(async (msg) => {
  console.log(`📨 ${msg.senderUsername} (${msg.senderType}) in ${msg.roomId}: ${msg.content.slice(0, 60)}`);
  const senderIsAgent = msg.senderType === 'ai';
  const senderAgent = getAgentByUsername(msg.senderUsername);

  // ── WebSocket agents: forward based on receiveMode + trust ──
  for (const [agentId, client] of clients) {
    // Don't send back to sender
    if (client.agent.username === msg.senderUsername) continue;
    if (client.agent.userId === msg.senderId) continue;

    // receiveMode check (before loop guard — @mentions always get through)
    const mentioned = msg.content.toLowerCase().includes(`@${client.agent.mentionKey}`) || msg.content.toLowerCase().includes(`@${client.agent.username}`);
    if (client.agent.receiveMode === 'mentions' && !mentioned) continue;

    // Loop guard (skip for direct @mentions — user explicitly wants this agent)
    if (!mentioned && !shouldDeliver(client.agent.trustLevel, senderIsAgent, msg.senderUsername, client.agent.username)) {
      continue;
    }

    // For openclaw-inject agents: use inject instead of WebSocket forwarding
    if (client.agent.delivery === 'openclaw-inject') {
      // Fetch unread messages if this is a mention
      let contextMessages: string[] = [];
      if (mentioned) {
        const lastSeenId = getLastSeenMessageId(client.agent.userId, msg.roomId);
        if (lastSeenId) {
          const token = (client as any)._token;
          if (token) {
            const unreadMessages = await bridge.fetchMessagesSince(token, msg.roomId, lastSeenId, 50);
            // Format unread messages as context (exclude the current one)
            contextMessages = unreadMessages
              .filter(m => m.id !== msg.id)
              .map(m => `[${m.sender?.username || 'unknown'}]: ${m.content}`);
          }
        }
        // Mark current message as seen
        markMessageSeen(client.agent.userId, msg.roomId, msg.id);
      }

      // Build inject message with context
      let injectMsg = '';
      if (contextMessages.length > 0) {
        injectMsg = `[Queued messages while agent was busy]\n\n---\n${contextMessages.map((m, i) => `Queued #${i + 1}\n${m}`).join('\n\n---\n')}\n`;
      }
      injectMsg += `[${new Date(msg.timestamp).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })}] [Triologue:${msg.roomId}] ${msg.senderUsername}: ${msg.content}\n\n(Reply with: /root/.openclaw/workspace/send-to-triologue.sh ${msg.roomId} "<your message>")`;

      injectToSession(injectMsg)
        .then(() => console.log(`[openclaw-inject:${client.agent.mentionKey}] ✅${contextMessages.length > 0 ? ` (+${contextMessages.length} unread)` : ''}`))
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

  // ── SSE agents: forward with same filtering as WebSocket ──
  for (const agent of getAllAgents()) {
    if (!hasSSEClient(agent.userId)) continue;
    // Don't send back to sender
    if (agent.username === msg.senderUsername) continue;
    if (agent.userId === msg.senderId) continue;
    // Don't double-deliver to WS+SSE
    if (clients.has(agent.userId)) continue;

    const mentioned = msg.content.toLowerCase().includes(`@${agent.mentionKey}`) || msg.content.toLowerCase().includes(`@${agent.username}`);
    if (agent.receiveMode === 'mentions' && !mentioned) continue;
    if (!mentioned && !shouldDeliver(agent.trustLevel, senderIsAgent, msg.senderUsername, agent.username)) continue;

    fanoutToSSEClient(agent.userId, {
      id: msg.id,
      room: msg.roomId,
      roomName: msg.roomName || '',
      sender: msg.senderUsername,
      senderType: msg.senderType === 'ai' ? 'AI' : 'HUMAN',
      content: msg.content,
      timestamp: msg.timestamp,
    });
  }

  // ── Non-WebSocket agents: dispatch on @mention via webhook or openclaw-inject ──
  for (const agent of getWebhookAgents()) {
    if (agent.username === msg.senderUsername) continue;
    if (!shouldDeliver(agent.trustLevel, senderIsAgent, msg.senderUsername, agent.username)) continue;

    const lc = msg.content.toLowerCase();
    const mentioned = lc.includes(`@${agent.mentionKey}`) || lc.includes(`@${agent.username}`);
    if (!mentioned) continue;

    // Don't dispatch if agent is connected via WebSocket (already got it)
    if (clients.has(agent.userId)) continue;

    // ── OpenClaw inject: inject directly into local OpenClaw session ──
    if (agent.delivery === 'openclaw-inject') {
      // Fetch unread messages for this agent
      let contextMessages: string[] = [];
      const lastSeenId = getLastSeenMessageId(agent.userId, msg.roomId);
      if (lastSeenId) {
        const unreadMessages = await bridge.fetchMessagesSince(GATEWAY_TOKEN, msg.roomId, lastSeenId, 50);
        // Format unread messages as context (exclude the current one)
        contextMessages = unreadMessages
          .filter(m => m.id !== msg.id)
          .map(m => `[${m.sender?.username || 'unknown'}]: ${m.content}`);
      }
      // Mark current message as seen
      markMessageSeen(agent.userId, msg.roomId, msg.id);

      // Build inject message with context
      let injectMsg = '';
      if (contextMessages.length > 0) {
        injectMsg = `[Queued messages while agent was busy]\n\n---\n${contextMessages.map((m, i) => `Queued #${i + 1}\n${m}`).join('\n\n---\n')}\n`;
      }
      injectMsg += `[${new Date(msg.timestamp).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })}] [Triologue:${msg.roomId}] ${msg.senderUsername}: ${msg.content}\n\n(Reply with: /root/.openclaw/workspace/send-to-triologue.sh ${msg.roomId} "<your message>")`;

      injectToSession(injectMsg)
        .then(() => console.log(`[openclaw-inject:${agent.mentionKey}] ✅${contextMessages.length > 0 ? ` (+${contextMessages.length} unread)` : ''}`))
        .catch(err => console.warn(`[openclaw-inject:${agent.mentionKey}] ⚠️ ${err.message}`));
      continue;
    }

    // ── Standard webhook dispatch ──
    if (!agent.webhookUrl) continue;

    // Fetch unread messages for webhook agents too
    let contextMessages: any[] = [];
    const lastSeenId = getLastSeenMessageId(agent.userId, msg.roomId);
    if (lastSeenId) {
      const unreadMessages = await bridge.fetchMessagesSince(GATEWAY_TOKEN, msg.roomId, lastSeenId, 50);
      // Include all unread messages except the current one
      contextMessages = unreadMessages
        .filter(m => m.id !== msg.id)
        .map(m => ({
          sender: m.sender?.username || 'unknown',
          senderType: m.sender?.userType || 'unknown',
          content: m.content,
          timestamp: m.createdAt,
        }));
    }
    // Mark current message as seen
    markMessageSeen(agent.userId, msg.roomId, msg.id);

    const payload = JSON.stringify({
      messageId: msg.id,
      sender: msg.senderUsername,
      senderType: msg.senderType,
      content: msg.content,
      room: msg.roomId,
      timestamp: msg.timestamp,
      context: contextMessages, // NEW: Include unread messages
    });

    dispatchWebhook({
      url: agent.webhookUrl,
      headers: {
        'Content-Type': 'application/json',
        'X-Triologue-Secret': agent.webhookSecret ?? '',
        'X-Triologue-Agent': agent.mentionKey,
      },
      body: payload,
      agentKey: agent.mentionKey,
      agentId: agent.userId,
      roomId: msg.roomId,
    });
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

// ── REST: BYOA Info Page (for users to get their connection details) ──

app.get('/byoa', (req, res) => {
  const token = req.query.token as string;
  
  if (!token) {
    return res.status(400).send(`
      <h1>BYOA — Bring Your Own Agent</h1>
      <p>Missing <code>?token=byoa_xxx</code> parameter.</p>
      <p>Get your token from Settings → My Agents in OpenTriologue.</p>
    `);
  }

  const agent = authenticateToken(token);
  
  if (!agent) {
    return res.status(401).send(`
      <h1>BYOA — Invalid Token</h1>
      <p>Token not found or inactive.</p>
      <p>Check your token in Settings → My Agents.</p>
    `);
  }

  // Determine protocol (check X-Forwarded-Proto or host)
  const forwardedProto = req.headers['x-forwarded-proto'] as string;
  const isProductionHost = req.headers.host?.includes('opentriologue.ai');
  const protocol = forwardedProto === 'https' || isProductionHost ? 'https' : (req.protocol || 'http');
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
  
  const wsUrl = `${wsProtocol}://${req.headers.host}/byoa/ws`;
  const sseUrl = `${protocol}://${req.headers.host}/byoa/sse/stream`;
  const restUrl = `${protocol}://${req.headers.host}/byoa/sse/messages`;

  res.send(`
    <html>
    <head>
      <title>BYOA — ${agent.name}</title>
      <style>
        body { font-family: system-ui; max-width: 800px; margin: 40px auto; padding: 20px; }
        h1 { color: #333; }
        code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
        pre { background: #f5f5f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
        .section { margin: 30px 0; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
        .token { background: #ffe; padding: 10px; border-left: 4px solid #fa0; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f5f5f5; }
      </style>
    </head>
    <body>
      <h1>🤖 BYOA — ${agent.emoji} ${agent.name}</h1>
      
      <div class="section">
        <h2>Agent Info</h2>
        <table>
          <tr><th>Name</th><td>${agent.name}</td></tr>
          <tr><th>Username</th><td>@${agent.username}</td></tr>
          <tr><th>Mention Key</th><td>${agent.mentionKey}</td></tr>
          <tr><th>Trust Level</th><td>${agent.trustLevel}</td></tr>
          <tr><th>Status</th><td>${agent.status}</td></tr>
        </table>
      </div>

      <div class="section token">
        <h2>⚠️ Your Token (keep secret!)</h2>
        <pre><code>${token}</code></pre>
        <p><strong>Never share this publicly!</strong> Anyone with this token can act as your agent.</p>
      </div>

      <div class="section">
        <h2>Connection Options</h2>
        
        <h3>Option 1: WebSocket (existing)</h3>
        <pre><code>ws.connect('${wsUrl}')
ws.send({ type: 'auth', token: '${token}' })</code></pre>
        
        <h3>Option 2: SSE + REST (new, recommended)</h3>
        <p><strong>Receive (SSE):</strong></p>
        <pre><code>GET ${sseUrl}
Authorization: Bearer ${token}</code></pre>
        
        <p><strong>Send (REST):</strong></p>
        <pre><code>POST ${restUrl}
Authorization: Bearer ${token}
Content-Type: application/json

{ "roomId": "...", "content": "..." }</code></pre>

        <p>✅ Benefits: Per-request auth, instant token revocation, proxy-friendly</p>
      </div>

      <div class="section">
        <h2>Quick Test</h2>
        <p>Test SSE stream (will open in new tab):</p>
        <pre><code>curl -N -H "Authorization: Bearer ${token}" \\
  ${sseUrl}</code></pre>
      </div>

      <div class="section">
        <h2>Documentation</h2>
        <ul>
          <li><a href="https://github.com/LanNguyenSi/triologue-agent-gateway/blob/master/BYOA.md">BYOA Guide</a></li>
          <li><a href="https://github.com/LanNguyenSi/triologue/blob/master/docs/BYOA_SSE_ARCHITECTURE.md">SSE Architecture</a></li>
          <li><a href="https://github.com/LanNguyenSi/triologue-agent-gateway/blob/master/examples/sse-client.ts">SSE Client Example</a></li>
        </ul>
      </div>
    </body>
    </html>
  `);
});

// ── REST: Metrics (for migration decision) ──

app.get('/metrics', (_, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(metrics.generateReport());
});

app.get('/metrics/json', (_, res) => {
  res.json(metrics.getSnapshot());
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
        metrics.recordAuthFailure('Invalid or inactive token');
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
      
      // Record metrics
      metrics.recordConnection(agent.userId, agent.name);

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

  ws.on('close', (code, reason) => {
    clearTimeout(authTimeout);
    clearInterval(pingInterval);
    if (client) {
      clients.delete(client.agent.userId);
      metrics.recordDisconnect(client.agent.userId, `code ${code}: ${reason || 'unknown'}`);
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
    setSSEBridge(bridge); // Inject bridge into SSE module for message sending
  } catch (err: any) {
    console.error(`❌ Failed to connect to Triologue: ${err.message}`);
    process.exit(1);
  }

  // Start API sync (replaces static agents.json with DB-driven config)
  await startSync();

  server.listen(PORT, () => {
    console.log(`🤖 Agent Gateway running on port ${PORT}`);
    console.log(`   WebSocket: ws://localhost:${PORT}/byoa/ws`);
    console.log(`   REST:      http://localhost:${PORT}/send`);
    console.log(`   Health:    http://localhost:${PORT}/health`);
  });

  // Update agent counts every 30s
  setInterval(() => {
    const webhookAgents = getWebhookAgents().length;
    const wsAgents = clients.size;
    metrics.updateAgentCounts(wsAgents, webhookAgents);
  }, 30_000);

  // Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down...');
    stopSync();
    bridge.disconnect();
    metrics.shutdown();
    shutdownSSE();
    for (const [, c] of clients) c.ws.close(1001, 'Server shutting down');
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
