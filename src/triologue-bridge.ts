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

  constructor(config: BridgeConfig) {
    this.config = config;
    this.cachePath = path.join(__dirname, '../.jwt-cache-gateway.json');
  }

  onMessage(cb: MessageCallback): void {
    this.onMessageCb = cb;
  }

  async connect(): Promise<void> {
    await this.authenticate();

    return new Promise((resolve, reject) => {
      this.socket = SocketIOClient(this.config.trioUrl, {
        auth: { token: this.jwtToken },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30000,
      });

      this.socket.on('connect', () => {
        console.log('🔌 Connected to Triologue server');
        setTimeout(resolve, 500);
      });

      this.socket.on('disconnect', (reason) => {
        console.warn(`⚠️ Disconnected from Triologue: ${reason}`);
        if (reason === 'io server disconnect') {
          this.jwtToken = null;
          try { fs.unlinkSync(this.cachePath); } catch {}
          setTimeout(() => this.reconnect(), 3000);
        }
      });

      this.socket.on('connect_error', (err) => {
        console.error(`❌ Connection error: ${err.message}`);
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

      setTimeout(() => reject(new Error('Connection timeout')), 15000);
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
    this.socket?.disconnect();
  }

  // ── Internals ──

  private async authenticate(): Promise<void> {
    // Try cached JWT
    try {
      if (fs.existsSync(this.cachePath)) {
        const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
        if (data.expiresAt && Date.now() < data.expiresAt - 3600000) {
          this.jwtToken = data.token;
          return;
        }
      }
    } catch {}

    const { data } = await axios.post(`${this.config.trioUrl}/api/auth/login`, {
      username: this.config.username,
      aiToken: this.config.aiToken,
      userType: this.config.userType,
    });

    this.jwtToken = data.token;

    // Cache
    try {
      const payload = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64').toString());
      fs.writeFileSync(this.cachePath, JSON.stringify({ token: data.token, expiresAt: payload.exp * 1000 }));
    } catch {}
  }

  private async reconnect(): Promise<void> {
    try {
      await this.authenticate();
      if (this.socket) {
        this.socket.auth = { token: this.jwtToken };
        this.socket.connect();
      }
    } catch (err: any) {
      console.error(`Reconnect failed: ${err.message}`);
      setTimeout(() => this.reconnect(), 10000);
    }
  }
}
