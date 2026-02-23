/**
 * Triologue Bridge — connects to Triologue server via Socket.io.
 * 
 * Receives all room messages and dispatches them to:
 *   1. Connected WebSocket agents
 *   2. Webhook agents (on @mention)
 * 
 * Sends agent messages back to Triologue rooms.
 * 
 * This is the "backend adapter". When we migrate to Matrix,
 * this file gets replaced with matrix-bridge.ts — nothing else changes.
 */

import { io as SocketIOClient, Socket } from 'socket.io-client';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import type { AgentInfo } from './types';

export interface BridgeConfig {
  trioUrl: string;        // http://localhost:4001
  username: string;       // Gateway's own username (e.g. "gateway-bot")
  aiToken: string;        // BYOA token for the gateway itself
  userType: string;       // AI_AGENT
}

type MessageCallback = (msg: {
  id: string;
  content: string;
  senderUsername: string;
  senderType: 'human' | 'ai';
  senderId: string;
  roomId: string;
  roomName?: string;
  timestamp: string;
}) => void;

export class TriologueBridge {
  private config: BridgeConfig;
  private socket: Socket | null = null;
  private jwtToken: string | null = null;
  private onMessageCb: MessageCallback | null = null;
  private cachePath: string;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000; // max 30s between retries
  private baseReconnectDelay = 2_000; // start at 2s
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.cachePath = path.join(__dirname, '../.jwt-cache-gateway.json');
  }

  onMessage(cb: MessageCallback): void {
    this.onMessageCb = cb;
  }

  async connect(): Promise<void> {
    await this.authenticate();
    await this.createSocket();
  }

  private async createSocket(): Promise<void> {
    // Clean up old socket completely
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    this.stopHeartbeat();

    return new Promise((resolve, reject) => {
      this.socket = SocketIOClient(this.config.trioUrl, {
        auth: { token: this.jwtToken },
        transports: ['websocket', 'polling'],
        reconnection: false, // We handle reconnection ourselves
        timeout: 10_000,
        forceNew: true, // Always create a fresh connection
      });

      let settled = false;

      this.socket.on('connect', () => {
        console.log('🔌 Connected to Triologue server');
        this.reconnectAttempts = 0;
        this.reconnecting = false;
        this.lastPong = Date.now();
        this.startHeartbeat();
        if (!settled) { settled = true; resolve(); }
      });

      this.socket.on('disconnect', (reason) => {
        console.warn(`⚠️ Disconnected from Triologue: ${reason}`);
        this.stopHeartbeat();
        this.scheduleReconnect(reason === 'io server disconnect');
      });

      this.socket.on('connect_error', (err) => {
        console.error(`❌ Connection error: ${err.message}`);
        if (!settled) {
          // First connect failed — still reject so start() can handle it
          settled = true;
          reject(err);
        } else {
          // Subsequent connect_error (during runtime) — trigger reconnect
          this.stopHeartbeat();
          this.scheduleReconnect(true);
        }
      });

      this.socket.on('message:new', (raw: any) => {
        if (!this.onMessageCb) return;

        const senderObj = typeof raw.sender === 'object' ? raw.sender : null;
        const senderUsername = raw.senderUsername ?? senderObj?.username ?? raw.sender ?? 'unknown';
        const senderUType = raw.senderUserType ?? senderObj?.userType ?? '';
        const isAgent = senderUType.startsWith('AI') || senderUType === 'AI_AGENT';

        this.onMessageCb({
          id: raw.id,
          content: raw.content,
          senderUsername,
          senderType: isAgent ? 'ai' : 'human',
          senderId: raw.senderId ?? senderObj?.id ?? '',
          roomId: raw.roomId,
          roomName: raw.roomName,
          timestamp: raw.createdAt ?? new Date().toISOString(),
        });
      });

      // Timeout for initial connect
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Connection timeout (10s)'));
        }
      }, 10_000);
    });
  }

  /**
   * Send a message as a specific agent.
   * Uses Triologue's /api/agents/message endpoint.
   */
  async sendAsAgent(agentToken: string, roomId: string, content: string): Promise<void> {
    await axios.post(`${this.config.trioUrl}/api/agents/message`, {
      roomId,
      content,
    }, {
      headers: { 'Authorization': `Bearer ${agentToken}` },
    });
  }

  /**
   * Get rooms for an agent by logging in with their token and fetching /api/rooms.
   */
  async getAgentRooms(agentToken: string, username: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const { data: loginData } = await axios.post(`${this.config.trioUrl}/api/auth/login`, {
        username,
        aiToken: agentToken,
        userType: 'AI_AGENT',
      });

      const { data: rooms } = await axios.get(`${this.config.trioUrl}/api/rooms`, {
        headers: { Authorization: `Bearer ${loginData.token}` },
      });

      return (rooms as any[]).map(r => ({ id: r.id, name: r.name }));
    } catch {
      return [];
    }
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.reconnecting = false;
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
  }

  // ── Heartbeat ──
  // Detect silent disconnects (TCP half-open, zombie connections)

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPong = Date.now();

    this.heartbeatInterval = setInterval(() => {
      if (!this.socket?.connected) {
        console.warn('💓 Heartbeat: socket not connected, triggering reconnect');
        this.stopHeartbeat();
        this.scheduleReconnect(true);
        return;
      }

      // Check if we've received any data recently (Socket.io pong)
      const silentMs = Date.now() - this.lastPong;
      if (silentMs > 60_000) {
        console.warn(`💓 Heartbeat: no pong for ${Math.round(silentMs / 1000)}s, reconnecting`);
        this.stopHeartbeat();
        this.socket.disconnect();
        this.scheduleReconnect(true);
        return;
      }

      // Emit a ping to keep the connection alive and verify it works
      this.socket.volatile.emit('ping');
      this.lastPong = Date.now(); // Reset on successful emit
    }, 25_000); // Check every 25s
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ── Reconnection ──

  private scheduleReconnect(clearJwt: boolean): void {
    if (this.reconnecting) return; // Already reconnecting
    this.reconnecting = true;

    if (clearJwt) {
      this.jwtToken = null;
      try { fs.unlinkSync(this.cachePath); } catch {}
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;

    console.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`);
    setTimeout(() => this.doReconnect(), delay);
  }

  private async doReconnect(): Promise<void> {
    try {
      console.log(`🔄 Reconnect attempt ${this.reconnectAttempts}...`);
      await this.authenticate();
      await this.createSocket();
      console.log(`✅ Reconnected successfully after ${this.reconnectAttempts} attempt(s)`);
    } catch (err: any) {
      console.error(`❌ Reconnect attempt ${this.reconnectAttempts} failed: ${err.message}`);
      this.reconnecting = false; // Allow scheduleReconnect to fire again
      this.scheduleReconnect(true);
    }
  }

  // ── Auth ──

  private async authenticate(): Promise<void> {
    // Try cached JWT
    try {
      if (this.jwtToken) {
        // Already have a token in memory, check if it's still valid
        const payload = JSON.parse(Buffer.from(this.jwtToken.split('.')[1], 'base64').toString());
        if (Date.now() < (payload.exp * 1000) - 60_000) { // 1min buffer
          return;
        }
        this.jwtToken = null;
      }

      if (fs.existsSync(this.cachePath)) {
        const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
        if (data.expiresAt && Date.now() < data.expiresAt - 60_000) {
          this.jwtToken = data.token;
          return;
        }
      }
    } catch {}

    // Fresh login
    const { data } = await axios.post(`${this.config.trioUrl}/api/auth/login`, {
      username: this.config.username,
      aiToken: this.config.aiToken,
      userType: this.config.userType,
    });

    this.jwtToken = data.token;

    // Cache
    try {
      const payload = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64').toString());
      fs.writeFileSync(this.cachePath, JSON.stringify({
        token: data.token,
        expiresAt: payload.exp * 1000,
      }));
    } catch {}
  }
}
