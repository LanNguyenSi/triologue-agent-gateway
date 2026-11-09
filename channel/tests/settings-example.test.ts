import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_NAME } from '../src/server.js';

describe('settings.example.json', () => {
  it('allows exactly the reply tool of this server, by the name Claude Code gives it', () => {
    const file = path.resolve(__dirname, '..', 'settings.example.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { permissions: { allow: string[] } };
    expect(settings).toEqual({ permissions: { allow: [`mcp__${SERVER_NAME}__send_message`] } });
  });
});
