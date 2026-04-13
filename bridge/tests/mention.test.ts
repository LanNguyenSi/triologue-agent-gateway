import { describe, expect, it } from 'vitest';
import {
  isMentioned,
  isSelfMessage,
  shouldTrigger,
  type AgentIdentity,
  type IncomingMessage,
} from '../src/mention.js';

const agent: AgentIdentity = {
  username: 'claude-bot',
  mentionKey: 'code',
  receiveMode: 'mentions',
};

function msg(partial: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'm1',
    room: 'room-1',
    roomName: 'general',
    sender: 'alice',
    senderType: 'HUMAN',
    content: 'hello',
    timestamp: '2026-04-13T18:00:00Z',
    ...partial,
  };
}

describe('isMentioned', () => {
  it('matches @mentionKey (case-insensitive)', () => {
    expect(isMentioned(msg({ content: 'hey @CODE can you look' }), agent)).toBe(true);
  });

  it('matches @username', () => {
    expect(isMentioned(msg({ content: '@claude-bot ping' }), agent)).toBe(true);
  });

  it('returns false when neither key nor username is mentioned', () => {
    expect(isMentioned(msg({ content: 'just chatting about codes' }), agent)).toBe(false);
  });

  it('substring-matches — "code" inside another handle still counts today', () => {
    // This mirrors the gateway's substring-based mention rule. If we
    // ever tighten it to word-boundary matching, update this test and
    // the mention helper together.
    expect(isMentioned(msg({ content: 'hi @codepilot' }), agent)).toBe(true);
  });
});

describe('isSelfMessage', () => {
  it('returns true when the sender equals the agent username', () => {
    expect(isSelfMessage(msg({ sender: 'claude-bot' }), agent)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSelfMessage(msg({ sender: 'CLAUDE-BOT' }), agent)).toBe(true);
  });

  it('returns false for a different sender', () => {
    expect(isSelfMessage(msg({ sender: 'alice' }), agent)).toBe(false);
  });
});

describe('shouldTrigger', () => {
  it('skips self-messages before any other check', () => {
    const decision = shouldTrigger(
      msg({ sender: 'claude-bot', content: '@code reply' }),
      agent,
      null,
    );
    expect(decision).toEqual({ trigger: false, reason: 'self-message' });
  });

  it('skips rooms outside the allowlist', () => {
    const decision = shouldTrigger(
      msg({ room: 'room-2', content: '@code hi' }),
      agent,
      new Set(['room-1']),
    );
    expect(decision).toEqual({
      trigger: false,
      reason: 'room room-2 not in allowlist',
    });
  });

  it('allows rooms inside the allowlist', () => {
    const decision = shouldTrigger(
      msg({ room: 'room-1', content: '@code hi' }),
      agent,
      new Set(['room-1']),
    );
    expect(decision).toEqual({ trigger: true });
  });

  it('requires an explicit mention when receiveMode=mentions', () => {
    const decision = shouldTrigger(
      msg({ content: 'just chatting' }),
      agent,
      null,
    );
    expect(decision).toEqual({
      trigger: false,
      reason: 'no mention and receiveMode=mentions',
    });
  });

  it('triggers on every message when receiveMode=all', () => {
    const decision = shouldTrigger(
      msg({ content: 'just chatting' }),
      { ...agent, receiveMode: 'all' },
      null,
    );
    expect(decision).toEqual({ trigger: true });
  });

  it('self-filter takes priority over receiveMode=all', () => {
    // Self-sent messages must be filtered even when the agent is in
    // promiscuous "all" mode — otherwise a bridge could end up
    // responding to its own replies in a tight loop.
    const decision = shouldTrigger(
      msg({ sender: 'claude-bot', content: 'my own message' }),
      { ...agent, receiveMode: 'all' },
      null,
    );
    expect(decision).toEqual({ trigger: false, reason: 'self-message' });
  });

  it('self-filter takes priority over an allowlist match', () => {
    const decision = shouldTrigger(
      msg({ sender: 'claude-bot', room: 'room-1' }),
      agent,
      new Set(['room-1']),
    );
    expect(decision).toEqual({ trigger: false, reason: 'self-message' });
  });
});
