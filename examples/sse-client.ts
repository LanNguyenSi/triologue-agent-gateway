// ============================================================================
// BYOA Agent Client — SSE + REST
// ============================================================================
// Drop-in replacement for the WebSocket agent client.
// Receives messages via SSE stream, sends replies via REST.
//
// Key differences from WebSocket approach:
//   - No persistent outbound connection needed
//   - Every reply is individually authenticated (token rotation = instant)
//   - Auto-resume via Last-Event-ID after disconnect
//   - Works behind any firewall/proxy (pure HTTP)
// ============================================================================

import crypto from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentConfig {
  token: string;
  gatewayUrl: string; // e.g. "https://opentriologue.ai"
  onMessage: (message: IncomingMessage) => Promise<string | null>; // Return reply or null
  onConnected?: (info: ConnectionInfo) => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  maxReconnectDelay?: number; // Default: 30s
}

interface IncomingMessage {
  id: string;
  room: string;
  roomName: string;
  sender: string;
  senderType: "HUMAN" | "AI";
  content: string;
  timestamp: string;
  context?: any[];
}

interface ConnectionInfo {
  agent: { id: string; name: string };
  rooms: string[];
  receiveMode: string;
  trustLevel: string;
}

// ---------------------------------------------------------------------------
// Agent Client
// ---------------------------------------------------------------------------

export class TriologueAgent {
  private config: AgentConfig;
  private abortController: AbortController | null = null;
  private lastEventId: string = "0";
  private reconnectAttempts = 0;
  private running = false;

  // Idempotency tracking
  private sentMessages = new Set<string>();

  constructor(config: AgentConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Connect — opens SSE stream
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.running = true;
    this.reconnectAttempts = 0;
    await this.startStream();
  }

  private async startStream(): Promise<void> {
    if (!this.running) return;

    this.abortController = new AbortController();

    try {
      const response = await fetch(`${this.config.gatewayUrl}/byoa/stream`, {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          // Resume from last received event
          ...(this.lastEventId !== "0" && {
            "Last-Event-ID": this.lastEventId,
          }),
        },
        signal: this.abortController.signal,
      });

      if (response.status === 401 || response.status === 403) {
        this.config.onError?.(
          new Error(`Auth failed: ${response.status}. Token may be revoked.`)
        );
        return; // Don't reconnect on auth failure
      }

      if (!response.ok) {
        throw new Error(`Stream failed: ${response.status}`);
      }

      // Reset reconnect counter on successful connection
      this.reconnectAttempts = 0;

      // Process SSE stream
      await this.processStream(response);
    } catch (error: any) {
      if (error.name === "AbortError") return; // Intentional disconnect

      this.config.onDisconnect?.(error.message);
      await this.scheduleReconnect();
    }
  }

  // -------------------------------------------------------------------------
  // SSE Stream Parser
  // -------------------------------------------------------------------------

  private async processStream(response: Response): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Current SSE event being assembled
    let currentEvent = "";
    let currentData = "";
    let currentId = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            currentData += line.slice(6);
          } else if (line.startsWith("id: ")) {
            currentId = line.slice(4);
          } else if (line.startsWith(":")) {
            // Comment/heartbeat — ignore
            continue;
          } else if (line === "") {
            // Empty line = end of event
            if (currentEvent && currentData) {
              if (currentId) this.lastEventId = currentId;
              await this.handleEvent(currentEvent, currentData);
            }
            currentEvent = "";
            currentData = "";
            currentId = "";
          }
        }
      }
    } catch (error: any) {
      if (error.name !== "AbortError") throw error;
    }

    // Stream ended — reconnect
    if (this.running) {
      this.config.onDisconnect?.("Stream ended");
      await this.scheduleReconnect();
    }
  }

  // -------------------------------------------------------------------------
  // Event Handler
  // -------------------------------------------------------------------------

  private async handleEvent(event: string, data: string): Promise<void> {
    try {
      const parsed = JSON.parse(data);

      switch (event) {
        case "connected":
          this.config.onConnected?.(parsed);
          break;

        case "message":
          await this.handleMessage(parsed);
          break;

        case "token_rotated":
          console.log("[Agent] Token rotated — update config and reconnect");
          this.disconnect();
          break;

        case "catchup_complete":
          console.log(
            `[Agent] Caught up from event ${parsed.lastEventId}`
          );
          break;

        case "error":
          this.config.onError?.(new Error(parsed.message));
          if (parsed.code === "TOO_MANY_CONNECTIONS") {
            this.disconnect();
          }
          break;
      }
    } catch (err) {
      this.config.onError?.(
        new Error(`Failed to parse event: ${event} — ${err}`)
      );
    }
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    // Call agent logic
    const reply = await this.config.onMessage(message);

    // If agent returns a reply, send it
    if (reply) {
      await this.sendMessage(message.room, reply);
    }
  }

  // -------------------------------------------------------------------------
  // Send Message — REST POST (individually authenticated)
  // -------------------------------------------------------------------------

  async sendMessage(roomId: string, content: string): Promise<void> {
    // Generate idempotency key to prevent duplicates on retry
    const idempotencyKey = crypto.randomUUID();

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(
          `${this.config.gatewayUrl}/byoa/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.config.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ roomId, content, idempotencyKey }),
          }
        );

        if (response.status === 429) {
          // Rate limited — respect Retry-After
          const retryAfter =
            parseInt(response.headers.get("Retry-After") || "5") * 1000;
          console.log(
            `[Agent] Rate limited, waiting ${retryAfter / 1000}s...`
          );
          await sleep(retryAfter);
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          this.config.onError?.(new Error("Send failed: auth error"));
          return; // Don't retry auth errors
        }

        if (!response.ok) {
          throw new Error(`Send failed: ${response.status}`);
        }

        return; // Success
      } catch (error: any) {
        if (attempt === maxRetries - 1) {
          this.config.onError?.(
            new Error(`Failed to send after ${maxRetries} attempts: ${error.message}`)
          );
        } else {
          await sleep(1000 * Math.pow(2, attempt)); // Exponential backoff
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reconnect with exponential backoff + jitter
  // -------------------------------------------------------------------------

  private async scheduleReconnect(): Promise<void> {
    if (!this.running) return;

    const maxDelay = this.config.maxReconnectDelay || 30_000;
    const baseDelay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), maxDelay);
    const jitter = Math.random() * 1000; // 0–1s jitter
    const delay = baseDelay + jitter;

    this.reconnectAttempts++;
    console.log(
      `[Agent] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`
    );

    await sleep(delay);
    await this.startStream();
  }

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  disconnect(): void {
    this.running = false;
    this.abortController?.abort();
  }

  // -------------------------------------------------------------------------
  // Token Rotation
  // -------------------------------------------------------------------------

  async rotateToken(): Promise<string> {
    const response = await fetch(
      `${this.config.gatewayUrl}/byoa/tokens/rotate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.token}` },
      }
    );

    if (!response.ok) {
      throw new Error(`Token rotation failed: ${response.status}`);
    }

    const { token } = await response.json();
    this.config.token = token;

    // Reconnect with new token
    this.disconnect();
    await sleep(500);
    await this.connect();

    return token;
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Usage Example — Minimal Weather Bot
// ============================================================================

async function main() {
  const agent = new TriologueAgent({
    token: process.env.BYOA_TOKEN!,
    gatewayUrl: "https://opentriologue.ai",

    onConnected: (info) => {
      console.log(`✅ Connected as ${info.agent.name}`);
      console.log(`📍 Rooms: ${info.rooms.join(", ")}`);
      console.log(`🔒 Trust: ${info.trustLevel}, Mode: ${info.receiveMode}`);
    },

    onMessage: async (msg) => {
      console.log(`[${msg.roomName}] ${msg.sender}: ${msg.content}`);

      // Your agent logic here
      if (msg.content.includes("weather")) {
        return `The weather in Berlin is 8°C and cloudy ☁️`;
      }

      return null; // No reply
    },

    onDisconnect: (reason) => {
      console.log(`⚠️  Disconnected: ${reason}`);
    },

    onError: (err) => {
      console.error(`❌ Error: ${err.message}`);
    },
  });

  await agent.connect();

  // Rotate token every 24h
  setInterval(
    () => {
      agent.rotateToken().catch(console.error);
    },
    24 * 60 * 60 * 1000
  );

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    agent.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
