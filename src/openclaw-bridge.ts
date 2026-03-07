/**
 * openclaw-bridge.ts — Bidirectional OpenClaw ↔ Triologue Bridge
 *
 * Injects a message into an OpenClaw agent session and captures the response
 * by listening for streaming assistant events on the Gateway WebSocket.
 *
 * Protocol:
 *  1. Connect to OpenClaw Gateway via WebSocket
 *  2. Authenticate with Ed25519 device keypair (operator.write scope)
 *  3. Inject message via "agent" method
 *  4. Listen for "agent" stream events (assistant text + lifecycle)
 *  5. Return collected response text on lifecycle:end
 *
 * The assistant stream events are CUMULATIVE — each event contains the full
 * response text so far, not just the new delta. We always take the latest value.
 *
 * Built by Ice 🧊 + Lava 🌋 (2026-03-07)
 */

import WebSocket from 'ws';
import { randomUUID, createPrivateKey, createPublicKey, sign as cryptoSign } from 'crypto';
import * as fs from 'fs';

// ── Types ──

export interface OpenClawBridgeConfig {
  /** OpenClaw Gateway WebSocket URL (default: ws://127.0.0.1:18789) */
  gatewayUrl?: string;
  /** Gateway auth token (auto-read from openclaw.json if not provided) */
  gatewayToken?: string;
  /** Path to openclaw.json (default: /root/.openclaw/openclaw.json) */
  configPath?: string;
  /** Path to device identity (default: /root/.openclaw/identity/device.json) */
  devicePath?: string;
  /** Session key to inject into (default: agent:main:main) */
  sessionKey?: string;
  /** Max wait for agent response in ms (default: 120000) */
  responseTimeoutMs?: number;
  /** Scopes to request (default: operator.read,write,admin) */
  scopes?: string[];
}

export interface InjectResult {
  /** The agent's response text (empty string if no response) */
  text: string;
  /** The agent run ID */
  runId: string | null;
  /** Whether the run completed successfully */
  completed: boolean;
  /** Error message if the run failed */
  error?: string;
}

// ── Crypto helpers ──

function pubKeyRawBase64url(pem: string): string {
  const key = createPublicKey(pem);
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer;
  return der.slice(-32).toString('base64url');
}

function signPayload(payload: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const sig = cryptoSign(null, Buffer.from(payload), key);
  return sig.toString('base64url');
}

// ── Bridge ──

export class OpenClawBridge {
  private config: Required<OpenClawBridgeConfig>;
  private gatewayToken: string;
  private device: any;

  constructor(config: OpenClawBridgeConfig = {}) {
    this.config = {
      gatewayUrl: config.gatewayUrl ?? 'ws://127.0.0.1:18789',
      gatewayToken: config.gatewayToken ?? '',
      configPath: config.configPath ?? '/root/.openclaw/openclaw.json',
      devicePath: config.devicePath ?? '/root/.openclaw/identity/device.json',
      sessionKey: config.sessionKey ?? 'agent:main:main',
      responseTimeoutMs: config.responseTimeoutMs ?? 120_000,
      scopes: config.scopes ?? ['operator.read', 'operator.write', 'operator.admin'],
    };

    // Load gateway token
    this.gatewayToken = this.config.gatewayToken;
    if (!this.gatewayToken) {
      try {
        const cfg = JSON.parse(fs.readFileSync(this.config.configPath, 'utf-8'));
        this.gatewayToken = cfg.gateway?.auth?.token ?? '';
      } catch {
        this.gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
      }
    }

    // Load device identity
    try {
      this.device = JSON.parse(fs.readFileSync(this.config.devicePath, 'utf-8'));
    } catch {
      throw new Error(`Device identity not found at ${this.config.devicePath}`);
    }

    if (!this.gatewayToken) {
      throw new Error('No gateway token found (config, env, or parameter)');
    }
  }

  /**
   * Inject a message into the agent session and wait for the response.
   * Returns the agent's response text (or empty string if no response / timeout).
   */
  async injectAndWaitForResponse(message: string): Promise<InjectResult> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.config.gatewayUrl);
      const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
      let runId: string | null = null;
      let responseText = '';
      let resolved = false;

      const finish = (result: InjectResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({
          text: responseText,
          runId,
          completed: false,
          error: `Timeout after ${this.config.responseTimeoutMs}ms`,
        });
      }, this.config.responseTimeoutMs);

      const sendReq = (method: string, params: unknown): Promise<any> => {
        return new Promise((res, rej) => {
          const id = randomUUID();
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ type: 'req', id, method, params }));
        });
      };

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // Handle connect challenge
          if (msg.event === 'connect.challenge') {
            const nonce = msg.payload?.nonce as string;
            const signedAtMs = Date.now();
            const scopeStr = this.config.scopes.join(',');

            const payloadStr = `v2|${this.device.deviceId}|cli|cli|operator|${scopeStr}|${signedAtMs}|${this.gatewayToken}|${nonce}`;
            const signature = signPayload(payloadStr, this.device.privateKeyPem);
            const publicKey = pubKeyRawBase64url(this.device.publicKeyPem);

            await sendReq('connect', {
              minProtocol: 3, maxProtocol: 3,
              client: {
                id: 'cli',
                displayName: 'Triologue Bridge',
                version: '2.0.0',
                platform: process.platform,
                mode: 'cli',
              },
              role: 'operator',
              scopes: this.config.scopes,
              auth: { token: this.gatewayToken },
              device: {
                id: this.device.deviceId,
                publicKey,
                signature,
                signedAt: signedAtMs,
                nonce,
              },
            });

            const result = await sendReq('agent', {
              sessionKey: this.config.sessionKey,
              message,
              deliver: false,
              idempotencyKey: randomUUID(),
            });

            runId = result?.runId ?? null;
            return;
          }

          // Handle request responses
          if (msg.type === 'res' && msg.id) {
            const handler = pending.get(msg.id);
            if (handler) {
              pending.delete(msg.id);
              if (msg.error) handler.reject(new Error(msg.error?.message ?? JSON.stringify(msg.error)));
              else handler.resolve(msg.result ?? msg.payload);
            }
            return;
          }

          // Handle agent stream events
          if (msg.type === 'event' && msg.event === 'agent') {
            const payload = msg.payload;
            if (runId && payload?.runId !== runId) return;

            // Assistant text — cumulative (each event = full text so far)
            if (payload?.stream === 'assistant' && typeof payload?.data?.text === 'string') {
              responseText = payload.data.text;
            }

            // Lifecycle events
            if (payload?.stream === 'lifecycle') {
              const phase = payload?.data?.phase;
              if (phase === 'end') {
                finish({ text: responseText, runId, completed: true });
              } else if (phase === 'error') {
                finish({
                  text: responseText,
                  runId,
                  completed: false,
                  error: JSON.stringify(payload?.data),
                });
              }
            }
          }
        } catch (err: any) {
          finish({ text: '', runId, completed: false, error: err.message });
        }
      });

      ws.on('error', (err) => {
        finish({ text: '', runId, completed: false, error: err.message });
      });

      ws.on('close', () => {
        if (!resolved) {
          finish({
            text: responseText,
            runId,
            completed: responseText.length > 0,
            error: 'WebSocket closed unexpectedly',
          });
        }
      });
    });
  }

  /**
   * Fire-and-forget inject (no response capture).
   * Use when you only need to deliver a message, not capture the reply.
   */
  async inject(message: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.gatewayUrl);
      const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Inject timeout'));
      }, 8000);

      const sendReq = (method: string, params: unknown): Promise<any> => {
        return new Promise((res, rej) => {
          const id = randomUUID();
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ type: 'req', id, method, params }));
        });
      };

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.event === 'connect.challenge') {
            const nonce = msg.payload?.nonce as string;
            const signedAtMs = Date.now();
            const scopeStr = this.config.scopes.join(',');

            const payloadStr = `v2|${this.device.deviceId}|cli|cli|operator|${scopeStr}|${signedAtMs}|${this.gatewayToken}|${nonce}`;
            const signature = signPayload(payloadStr, this.device.privateKeyPem);
            const publicKey = pubKeyRawBase64url(this.device.publicKeyPem);

            await sendReq('connect', {
              minProtocol: 3, maxProtocol: 3,
              client: { id: 'cli', displayName: 'Triologue Injector', version: '2.0.0', platform: process.platform, mode: 'cli' },
              role: 'operator',
              scopes: this.config.scopes,
              auth: { token: this.gatewayToken },
              device: { id: this.device.deviceId, publicKey, signature, signedAt: signedAtMs, nonce },
            });

            const result = await sendReq('agent', {
              sessionKey: this.config.sessionKey,
              message,
              deliver: false,
              idempotencyKey: randomUUID(),
            });

            clearTimeout(timer);
            ws.close();
            resolve(result?.runId ?? null);
            return;
          }

          if (msg.type === 'res' && msg.id) {
            const handler = pending.get(msg.id);
            if (handler) {
              pending.delete(msg.id);
              if (msg.error) handler.reject(new Error(msg.error?.message ?? JSON.stringify(msg.error)));
              else handler.resolve(msg.result ?? msg.payload);
            }
          }
        } catch (err: any) {
          clearTimeout(timer);
          ws.close();
          reject(err);
        }
      });

      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
}
