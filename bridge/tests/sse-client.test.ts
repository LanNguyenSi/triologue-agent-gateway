import { describe, expect, it } from 'vitest';
import { parseSseFrame } from '../src/sse-client.js';

describe('parseSseFrame', () => {
  it('parses a single event + data line', () => {
    expect(parseSseFrame('event: message\ndata: {"hello":"world"}')).toEqual({
      event: 'message',
      data: '{"hello":"world"}',
    });
  });

  it('defaults event to "message" when no event: line is present', () => {
    expect(parseSseFrame('data: {"a":1}')).toEqual({
      event: 'message',
      data: '{"a":1}',
    });
  });

  it('ignores comment / heartbeat lines starting with ":"', () => {
    expect(parseSseFrame(': heartbeat 123\ndata: {"a":1}')).toEqual({
      event: 'message',
      data: '{"a":1}',
    });
  });

  it('joins multi-line data with newlines', () => {
    expect(parseSseFrame('event: x\ndata: line 1\ndata: line 2')).toEqual({
      event: 'x',
      data: 'line 1\nline 2',
    });
  });

  it('returns null when the frame carries no data', () => {
    expect(parseSseFrame(': only-heartbeat')).toBeNull();
    expect(parseSseFrame('event: ping')).toBeNull();
  });
});
