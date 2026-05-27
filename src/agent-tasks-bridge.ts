/**
 * agent-tasks → Triologue bridge
 *
 * Receives outbound Signal webhooks from agent-tasks (PR #272) and
 * posts them as messages into a dedicated Triologue inbox room.
 *
 * Wire contract (sender side):
 *   docs:    agent-tasks/docs/notification-webhooks.md
 *   header:  X-AgentTasks-Signature: sha256=<hmac-hex>
 *            X-AgentTasks-Event:     signal.<type>
 *            X-AgentTasks-Signal-Id: <signalId>
 *   body:    JSON { signalId, type, taskId, projectId, projectSlug,
 *                   recipientAgentId, recipientUserId, context, createdAt }
 *
 * The signature is HMAC-SHA256 of the raw POST body using the project's
 * notificationWebhookSecret. We compare in constant time. If
 * AGENT_TASKS_WEBHOOK_SECRET is unset we accept without verification
 * (operator-trust mode) and log a warning once at startup.
 *
 * The formatted message is posted via the existing
 * `bridge.sendAsAgent(token, roomId, content)` helper using a dedicated
 * "agent-tasks-bot" BYOA identity. Signal types are documented in the
 * agent-tasks events.md catalog.
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Re-declared here rather than imported across the package boundary:
// the wire format is the contract, not the sender's TS types.
export type AgentTasksSignalType =
  | 'review_needed'
  | 'changes_requested'
  | 'task_approved'
  | 'task_assigned'
  | 'task_available'
  | 'task_force_transitioned'
  | 'self_merge_notice';

export interface AgentTasksSignalActor {
  type: 'human' | 'agent' | 'webhook';
  name: string;
}

export interface AgentTasksSignalContext {
  taskTitle: string;
  taskStatus: string;
  projectSlug: string;
  projectName: string;
  branchName?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  actor: AgentTasksSignalActor;
  reviewComment?: string;
  assigneeName?: string;
  forceTransition?: {
    from: string;
    to: string;
    forcedRules: string[];
    forceReason?: string | null;
  };
}

export interface AgentTasksSignalPayload {
  signalId: string;
  type: AgentTasksSignalType;
  taskId: string;
  projectId: string;
  projectSlug: string;
  recipientAgentId: string | null;
  recipientUserId: string | null;
  context: AgentTasksSignalContext;
  createdAt: string; // ISO-8601
}

export interface AgentTasksBridgeConfig {
  /** Shared HMAC secret matching the project's notificationWebhookSecret. Optional. */
  webhookSecret: string | null;
  /** BYOA token for the dedicated "agent-tasks-bot" identity. Required. */
  botToken: string | null;
  /** Triologue room where formatted messages get posted. Required. */
  inboxRoomId: string | null;
  /** Base URL of the agent-tasks UI for "open task" deep-links. Optional. */
  agentTasksBaseUrl: string;
}

export interface AgentTasksBridgeDeps {
  /** Adapter to the Triologue bridge's sendAsAgent helper. */
  sendAsAgent: (token: string, roomId: string, content: string) => Promise<void>;
  /** Structured logger surface; we accept the minimal shape so any logger fits. */
  logger?: {
    info?: (msg: string, ...rest: unknown[]) => void;
    warn?: (msg: string, ...rest: unknown[]) => void;
    error?: (msg: string, ...rest: unknown[]) => void;
  };
}

/**
 * Constant-time HMAC verification. `header` is the raw value of
 * `X-AgentTasks-Signature` (the `sha256=<hex>` prefix is expected).
 * Returns true iff the signature matches.
 */
export function verifyAgentTasksSignature(rawBody: Buffer | string, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expectedHex = createHmac('sha256', secret).update(bodyBuf).digest('hex');
  const expected = Buffer.from(`sha256=${expectedHex}`, 'utf8');
  const received = Buffer.from(header, 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

const TYPE_EMOJI: Record<AgentTasksSignalType, string> = {
  review_needed: '📋',
  changes_requested: '✏️',
  task_approved: '✅',
  task_assigned: '🎯',
  task_available: '🆕',
  task_force_transitioned: '⚡',
  self_merge_notice: '🔀',
};

/**
 * Render the Signal payload as a Markdown message suitable for posting
 * into a Triologue room. Format is intentionally compact: one block per
 * signal, all relevant context inline so no follow-up clicks are needed
 * to triage the event.
 */
export function formatSignalMessage(payload: AgentTasksSignalPayload, agentTasksBaseUrl: string): string {
  const emoji = TYPE_EMOJI[payload.type] ?? '🔔';
  const ctx = payload.context;
  const lines: string[] = [];

  lines.push(`${emoji} **${payload.type}** in *${ctx.projectSlug ?? payload.projectSlug}*`);
  lines.push(`Task: ${ctx.taskTitle}`);
  if (ctx.prUrl) lines.push(`PR: ${ctx.prUrl}`);
  if (ctx.actor) lines.push(`Actor: ${ctx.actor.name} (${ctx.actor.type})`);
  if (ctx.reviewComment) lines.push(`Comment: ${ctx.reviewComment}`);
  if (ctx.assigneeName && payload.type === 'review_needed') {
    lines.push(`Assignee: ${ctx.assigneeName}`);
  }
  if (ctx.forceTransition) {
    const ft = ctx.forceTransition;
    // Validator only guarantees `forceTransition` is present; individual
    // fields can be malformed. Guard the array access so a non-list
    // `forcedRules` cannot crash the handler.
    const rules = Array.isArray(ft.forcedRules) ? ft.forcedRules.join(', ') : '';
    lines.push(`Force: ${ft.from} → ${ft.to} (rules: ${rules})`);
    if (ft.forceReason) lines.push(`Reason: ${ft.forceReason}`);
  }

  const link = buildTaskLink(agentTasksBaseUrl, payload.projectId, payload.taskId);
  if (link) lines.push(`agent-tasks: ${link}`);

  return lines.join('\n');
}

function buildTaskLink(baseUrl: string, projectId: string, taskId: string): string | null {
  if (!baseUrl) return null;
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/projects/${projectId}/tasks/${taskId}`;
}

/**
 * Sanity-check the parsed JSON payload. We don't run a full Zod schema
 * here , the source of truth is the agent-tasks payload contract, and
 * over-strict validation would reject legitimate future fields. We only
 * require the small set we actually read.
 */
function validatePayload(value: unknown): { ok: true; payload: AgentTasksSignalPayload } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (typeof value !== 'object' || value === null) return { ok: false, missing: ['<root not an object>'] };
  const v = value as Record<string, unknown>;
  if (typeof v.signalId !== 'string') missing.push('signalId');
  if (typeof v.type !== 'string') missing.push('type');
  if (typeof v.taskId !== 'string') missing.push('taskId');
  if (typeof v.projectId !== 'string') missing.push('projectId');
  if (typeof v.context !== 'object' || v.context === null) {
    missing.push('context');
  } else {
    const ctx = v.context as Record<string, unknown>;
    if (typeof ctx.taskTitle !== 'string') missing.push('context.taskTitle');
    if (typeof ctx.projectSlug !== 'string') missing.push('context.projectSlug');
    if (typeof ctx.actor !== 'object' || ctx.actor === null) missing.push('context.actor');
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, payload: value as AgentTasksSignalPayload };
}

/**
 * Build the Express router that hosts the bridge route. The router uses
 * `express.raw` so we can compute HMAC over the exact bytes received
 * (re-serializing post-JSON-parse would silently break signature checks
 * on whitespace and key ordering).
 */
export function createAgentTasksBridgeRouter(config: AgentTasksBridgeConfig, deps: AgentTasksBridgeDeps): Router {
  const router = Router();
  const log = deps.logger ?? { info: console.log, warn: console.warn, error: console.error };

  const featureEnabled = !!(config.botToken && config.inboxRoomId);
  if (!featureEnabled) {
    log.warn?.('[agent-tasks-bridge] disabled: AGENT_TASKS_BOT_TOKEN and AGENT_TASKS_INBOX_ROOM_ID are both required');
  } else if (!config.webhookSecret) {
    log.warn?.('[agent-tasks-bridge] AGENT_TASKS_WEBHOOK_SECRET unset , accepting unsigned webhooks (operator-trust mode)');
  }

  router.post(
    '/webhook',
    // 256kb is far above any realistic Signal payload; reject anything bigger
    // to avoid memory-pressure attacks via a misconfigured/malicious sender.
    express.raw({ type: 'application/json', limit: '256kb' }),
    async (req: Request, res: Response) => {
      if (!featureEnabled) {
        return res.status(503).json({ error: 'feature_disabled', message: 'agent-tasks bridge is not configured on this gateway' });
      }

      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('', 'utf8');

      if (config.webhookSecret) {
        const sigHeader = req.header('X-AgentTasks-Signature');
        if (!verifyAgentTasksSignature(rawBody, sigHeader, config.webhookSecret)) {
          log.warn?.('[agent-tasks-bridge] signature verification failed');
          return res.status(401).json({ error: 'invalid_signature' });
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'invalid_json' });
      }

      const validation = validatePayload(parsed);
      if (!validation.ok) {
        return res.status(400).json({ error: 'invalid_payload', missing: validation.missing });
      }

      const payload = validation.payload;
      const message = formatSignalMessage(payload, config.agentTasksBaseUrl);

      try {
        await deps.sendAsAgent(config.botToken!, config.inboxRoomId!, message);
        log.info?.(`[agent-tasks-bridge] posted ${payload.type} signalId=${payload.signalId}`);
        return res.status(202).json({ ok: true, signalId: payload.signalId });
      } catch (err) {
        log.error?.('[agent-tasks-bridge] sendAsAgent failed', (err as Error).message);
        // Do NOT echo the raw payload back; an upstream proxy might log it.
        return res.status(502).json({ error: 'send_failed', signalId: payload.signalId });
      }
    },
  );

  return router;
}
