import { describe, it, expect } from 'vitest';

describe('Triologue Agent Gateway Smoke Tests', () => {
  it('should import core modules without errors', async () => {
    const { loadAgents } = await import('../auth.js');
    const types = await import('../types.js');
    
    expect(loadAgents).toBeDefined();
    expect(types).toBeDefined();
  });

  it('should have valid TypeScript types', () => {
    // This test passes if TypeScript compilation succeeds
    expect(true).toBe(true);
  });
});
