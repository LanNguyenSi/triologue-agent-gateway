/**
 * 🌋 openclaw-inject.ts
 *
 * Injects a message directly into the OpenClaw main session via Gateway WebSocket.
 * Uses Ed25519 device keypair for operator.write scope (required for session inject).
 *
 * Protocol (reverse-engineered + completed by Ice 🧊 + Lava 🌋):
 *  1. Connect to ws://127.0.0.1:18789
 *  2. Server: {type:"event", event:"connect.challenge", payload:{nonce, ts}}
 *  3. Client: {type:"req", method:"connect", params:{auth:{token}, device:{id, publicKey, signature, signedAt, nonce}}}
 *     - publicKey: raw 32 Ed25519 bytes, base64url encoded (not PEM!)
 *     - signature: Ed25519 sign of "v2|deviceId|cli|cli|operator|scopes|signedAtMs|token|nonce"
 *  4. Server: {type:"res", result:{type:"hello-ok"}} → operator.write scope granted
 *  5. Client: {type:"req", method:"agent", params:{sessionKey, message, deliver:false}}
 *  6. Server: {type:"res", result:{runId, status:"accepted"}}
 */

import WebSocket from 'ws';
import { randomUUID, createPrivateKey, createPublicKey, sign as cryptoSign } from 'crypto';
import * as fs from 'fs';

const GATEWAY_TOKEN = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf-8'));
    return cfg.gateway?.auth?.token as string;
  } catch {
    return process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
  }
})();

const DEVICE = (() => {
  try {
    return JSON.parse(fs.readFileSync('/root/.openclaw/identity/device.json', 'utf-8'));
  } catch {
    return null;
  }
})();

const GATEWAY_URL = 'ws://127.0.0.1:18789';
const SESSION_KEY = 'agent:main:main';
const TIMEOUT_MS  = 8000;
const SCOPES      = ['operator.read', 'operator.write', 'operator.admin'];

/** Extract raw 32-byte Ed25519 public key from PEM → base64url */
function pubKeyRawBase64url(pem: string): string {
  const key = createPublicKey(pem);
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer;
  return der.slice(-32).toString('base64url'); // last 32 bytes = raw Ed25519 key
}

/** Sign payload string with Ed25519 private key → base64url */
function signPayload(payload: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const sig = cryptoSign(null, Buffer.from(payload), key);
  return sig.toString('base64url');
}

export async function injectToSession(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL);
    const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('OpenClaw inject timeout'));
    }, TIMEOUT_MS);

    function sendReq(method: string, params: unknown): Promise<any> {
      return new Promise((res, rej) => {
        const id = randomUUID();
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ type: 'req', id, method, params }));
      });
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.event === 'connect.challenge') {
          const nonce = msg.payload?.nonce as string;
          const signedAtMs = Date.now();
          const scopeStr = SCOPES.join(',');

          // Build signed auth payload (Ice's format)
          const payloadStr = `v2|${DEVICE.deviceId}|cli|cli|operator|${scopeStr}|${signedAtMs}|${GATEWAY_TOKEN}|${nonce}`;
          const signature = signPayload(payloadStr, DEVICE.privateKeyPem);
          const publicKey = pubKeyRawBase64url(DEVICE.publicKeyPem);

          await sendReq('connect', {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'cli', displayName: 'Lava Triologue Injector', version: '1.0.0', platform: process.platform, mode: 'cli' },
            role: 'operator',
            scopes: SCOPES,
            auth: { token: GATEWAY_TOKEN },
            device: {
              id: DEVICE.deviceId,
              publicKey,
              signature,
              signedAt: signedAtMs,
              nonce,
            },
          });

          await sendReq('agent', {
            sessionKey: SESSION_KEY,
            message,
            deliver: false,
            idempotencyKey: randomUUID(),
          });

          clearTimeout(timer);
          ws.close();
          resolve();
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
    ws.on('close', () => { clearTimeout(timer); });
  });
}

// CLI test: npx tsx src/openclaw-inject.ts "test message"
if (process.argv[2]) {
  injectToSession(process.argv[2])
    .then(() => { console.log('✅ Injected!'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}
