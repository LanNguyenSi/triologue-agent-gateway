import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import {
  createAgentTasksBridgeRouter,
  verifyAgentTasksSignature,
  formatSignalMessage,
  type AgentTasksBridgeConfig,
  type AgentTasksBridgeDeps,
  type AgentTasksSignalPayload,
  type AgentTasksSignalType,
} from '../agent-tasks-bridge.js';

const SECRET = 'shhh-test-secret';

function buildPayload(overrides: Partial<AgentTasksSignalPayload> = {}): AgentTasksSignalPayload {
  return {
    signalId: 'sig-abc',
    type: 'review_needed',
    taskId: 'task-1',
    projectId: 'proj-1',
    projectSlug: 'agent-tasks',
    recipientAgentId: 'agent-reviewer',
    recipientUserId: null,
    context: {
      taskTitle: 'Fix the thing',
      taskStatus: 'review',
      projectSlug: 'agent-tasks',
      projectName: 'agent-tasks',
      branchName: 'feat/x',
      prUrl: 'https://github.com/owner/repo/pull/42',
      prNumber: 42,
      actor: { type: 'human', name: 'Lan' },
    },
    createdAt: '2026-05-27T12:00:00.000Z',
    ...overrides,
  };
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

interface TestServer {
  url: string;
  close: () => Promise<void>;
  sendAsAgent: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

interface StartOptions {
  config?: Partial<AgentTasksBridgeConfig>;
  /**
   * Production-shape harness: mounts `express.json()` AFTER the bridge,
   * mirroring `src/index.ts`. Use this to catch body-parser ordering
   * regressions (the bridge MUST be mounted before the global JSON
   * parser, otherwise the body is consumed and HMAC verification sees
   * an empty buffer).
   */
  withGlobalJsonParser?: 'before' | 'after' | 'none';
}

async function startServer(opts: StartOptions = {}): Promise<TestServer> {
  const { config = {}, withGlobalJsonParser = 'none' } = opts;
  const sendAsAgent = vi.fn<AgentTasksBridgeDeps['sendAsAgent']>().mockResolvedValue(undefined);
  const warn = vi.fn();
  const info = vi.fn();
  const error = vi.fn();
  const app = express();
  if (withGlobalJsonParser === 'before') {
    // Demonstrates the production wiring bug: body parsed away before
    // the bridge handler can read it. Used in one regression test.
    app.use(express.json());
  }
  app.use(
    '/agent-tasks',
    createAgentTasksBridgeRouter(
      {
        webhookSecret: SECRET,
        botToken: 'bot-token',
        inboxRoomId: 'room-1',
        agentTasksBaseUrl: 'https://agent-tasks.example',
        ...config,
      },
      {
        sendAsAgent,
        logger: { warn, info, error },
      },
    ),
  );
  if (withGlobalJsonParser === 'after') {
    // Production layout: bridge first, then the global json parser for
    // every other route on the gateway.
    app.use(express.json());
  }
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        sendAsAgent,
        warn,
        info,
        error,
      });
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verifyAgentTasksSignature', () => {
  it('accepts a correctly signed body', () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyAgentTasksSignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it('rejects a mismatched signature', () => {
    const body = JSON.stringify({ a: 1 });
    const wrong = sign('{"a":2}', SECRET);
    expect(verifyAgentTasksSignature(body, wrong, SECRET)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyAgentTasksSignature(JSON.stringify({}), undefined, SECRET)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const body = JSON.stringify({});
    const noPrefix = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    expect(verifyAgentTasksSignature(body, noPrefix, SECRET)).toBe(false);
  });

  it('rejects when computed with a different secret', () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyAgentTasksSignature(body, sign(body, 'other'), SECRET)).toBe(false);
  });
});

describe('formatSignalMessage', () => {
  it('includes type, project, task, PR, actor, and the deep link', () => {
    const out = formatSignalMessage(buildPayload(), 'https://agent-tasks.example');
    expect(out).toContain('📋 **review_needed** in *agent-tasks*');
    expect(out).toContain('Task: Fix the thing');
    expect(out).toContain('PR: https://github.com/owner/repo/pull/42');
    expect(out).toContain('Actor: Lan (human)');
    expect(out).toContain('agent-tasks: https://agent-tasks.example/projects/proj-1/tasks/task-1');
  });

  const types: AgentTasksSignalType[] = [
    'review_needed',
    'changes_requested',
    'task_approved',
    'task_assigned',
    'task_available',
    'task_force_transitioned',
    'self_merge_notice',
  ];
  it.each(types)('produces a message with type-specific emoji for %s', (type) => {
    const out = formatSignalMessage(buildPayload({ type }), 'https://agent-tasks.example');
    expect(out).toMatch(new RegExp(`\\*\\*${type}\\*\\*`));
  });

  it('includes reviewComment when present (changes_requested case)', () => {
    const out = formatSignalMessage(
      buildPayload({
        type: 'changes_requested',
        context: { ...buildPayload().context, reviewComment: 'Please add tests' },
      }),
      'https://agent-tasks.example',
    );
    expect(out).toContain('Comment: Please add tests');
  });

  it('includes forceTransition details when present', () => {
    const out = formatSignalMessage(
      buildPayload({
        type: 'task_force_transitioned',
        context: {
          ...buildPayload().context,
          forceTransition: {
            from: 'in_progress',
            to: 'done',
            forcedRules: ['prMerged', 'ciGreen'],
            forceReason: 'hotfix',
          },
        },
      }),
      'https://agent-tasks.example',
    );
    expect(out).toContain('Force: in_progress → done (rules: prMerged, ciGreen)');
    expect(out).toContain('Reason: hotfix');
  });

  it('omits the deep link when base URL is empty', () => {
    const out = formatSignalMessage(buildPayload(), '');
    expect(out).not.toContain('agent-tasks:');
  });
});

describe('createAgentTasksBridgeRouter — happy path', () => {
  it('verifies the signature, parses the body, posts via sendAsAgent, returns 202', async () => {
    const srv = await startServer();
    try {
      const body = JSON.stringify(buildPayload());
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AgentTasks-Signature': sign(body, SECRET),
          'X-AgentTasks-Event': 'signal.review_needed',
          'X-AgentTasks-Signal-Id': 'sig-abc',
        },
        body,
      });
      expect(res.status).toBe(202);
      expect(srv.sendAsAgent).toHaveBeenCalledTimes(1);
      const [token, roomId, content] = srv.sendAsAgent.mock.calls[0]!;
      expect(token).toBe('bot-token');
      expect(roomId).toBe('room-1');
      expect(content).toContain('review_needed');
      expect(content).toContain('Fix the thing');
    } finally {
      await srv.close();
    }
  });

  it('accepts without verification only with the explicit allowUnsigned opt-in (operator-trust mode), and warns at startup', async () => {
    const srv = await startServer({ config: { webhookSecret: null, allowUnsigned: true } });
    try {
      // Startup warning fired once.
      expect(srv.warn).toHaveBeenCalledWith(
        expect.stringContaining('accepting unsigned webhooks'),
      );
      const body = JSON.stringify(buildPayload());
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(202);
      expect(srv.sendAsAgent).toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('fails closed (503) when no secret is set and allowUnsigned is not opted in', async () => {
    // Regression for the unsigned-webhook default: a missing secret must NOT
    // silently leave the inbox open to unauthenticated POSTs.
    const srv = await startServer({ config: { webhookSecret: null } });
    try {
      const body = JSON.stringify(buildPayload());
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(503);
      const responseBody = (await res.json()) as { error: string };
      expect(responseBody.error).toBe('feature_disabled');
      expect(srv.sendAsAgent).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });
});

describe('createAgentTasksBridgeRouter — rejections', () => {
  it('returns 401 on missing signature when secret is configured', async () => {
    const srv = await startServer();
    try {
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      expect(res.status).toBe(401);
      expect(srv.sendAsAgent).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('returns 401 on wrong signature', async () => {
    const srv = await startServer();
    try {
      const body = JSON.stringify(buildPayload());
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AgentTasks-Signature': sign(body, 'other-secret'),
        },
        body,
      });
      expect(res.status).toBe(401);
      expect(srv.sendAsAgent).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('returns 400 on invalid JSON', async () => {
    const srv = await startServer();
    try {
      const raw = '{not-json';
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AgentTasks-Signature': sign(raw, SECRET),
        },
        body: raw,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_json');
    } finally {
      await srv.close();
    }
  });

  it('returns 400 with field-missing detail on missing required field', async () => {
    const srv = await startServer();
    try {
      const broken = JSON.stringify({ signalId: 'x', type: 'review_needed' }); // missing taskId, projectId, context
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AgentTasks-Signature': sign(broken, SECRET),
        },
        body: broken,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; missing: string[] };
      expect(body.error).toBe('invalid_payload');
      expect(body.missing).toEqual(expect.arrayContaining(['taskId', 'projectId', 'context']));
    } finally {
      await srv.close();
    }
  });

  it('returns 502 (not 500) when sendAsAgent throws, without echoing the payload', async () => {
    const srv = await startServer();
    srv.sendAsAgent.mockRejectedValueOnce(new Error('bridge down'));
    try {
      const body = JSON.stringify(buildPayload());
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AgentTasks-Signature': sign(body, SECRET),
        },
        body,
      });
      expect(res.status).toBe(502);
      const responseBody = (await res.json()) as { error: string; signalId: string };
      expect(responseBody.error).toBe('send_failed');
      expect(responseBody.signalId).toBe('sig-abc');
      // Make sure we don't leak task title or payload contents back.
      const raw = JSON.stringify(responseBody);
      expect(raw).not.toContain('Fix the thing');
    } finally {
      await srv.close();
    }
  });
});

describe('createAgentTasksBridgeRouter — feature-disabled state', () => {
  it('returns 503 when botToken is missing', async () => {
    const srv = await startServer({ config: { botToken: null } });
    try {
      const body = JSON.stringify(buildPayload());
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AgentTasks-Signature': sign(body, SECRET),
        },
        body,
      });
      expect(res.status).toBe(503);
      const responseBody = (await res.json()) as { error: string };
      expect(responseBody.error).toBe('feature_disabled');
      expect(srv.sendAsAgent).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('returns 503 when inboxRoomId is missing', async () => {
    const srv = await startServer({ config: { inboxRoomId: null } });
    try {
      const body = JSON.stringify(buildPayload());
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AgentTasks-Signature': sign(body, SECRET),
        },
        body,
      });
      expect(res.status).toBe(503);
      expect(srv.sendAsAgent).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });
});

describe('createAgentTasksBridgeRouter, body-parser ordering regression', () => {
  it('happy path still works when express.json() is mounted AFTER the bridge (production layout)', async () => {
    const srv = await startServer({ withGlobalJsonParser: 'after' });
    try {
      const body = JSON.stringify(buildPayload());
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AgentTasks-Signature': sign(body, SECRET),
        },
        body,
      });
      expect(res.status).toBe(202);
      expect(srv.sendAsAgent).toHaveBeenCalledTimes(1);
    } finally {
      await srv.close();
    }
  });

  it('HMAC FAILS when express.json() is mounted BEFORE the bridge (anti-pattern, documents the trap)', async () => {
    // Demonstrates the regression: if someone moves the bridge mount below
    // the global JSON parser, the body is consumed and the raw buffer
    // arrives empty. Signature over an empty buffer never matches a
    // signature computed over the real body, so the route 401s on every
    // signed request and the bridge appears dead.
    const srv = await startServer({ withGlobalJsonParser: 'before' });
    try {
      const body = JSON.stringify(buildPayload());
      const res = await fetch(`${srv.url}/agent-tasks/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AgentTasks-Signature': sign(body, SECRET),
        },
        body,
      });
      expect(res.status).toBe(401);
      expect(srv.sendAsAgent).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });
});

describe('formatSignalMessage, malformed forceTransition.forcedRules guard', () => {
  it('does not crash when forcedRules is missing/non-array', () => {
    const payload = buildPayload({
      type: 'task_force_transitioned',
      context: {
        ...buildPayload().context,
        // Intentionally invalid shape: validator only requires forceTransition
        // exists, not that forcedRules is an array. Formatter must guard.
        forceTransition: { from: 'a', to: 'b' } as unknown as AgentTasksSignalPayload['context']['forceTransition'],
      },
    });
    expect(() => formatSignalMessage(payload, 'https://example')).not.toThrow();
  });
});
