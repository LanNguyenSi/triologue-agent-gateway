/**
 * Tests for sdk/src/resources/projects.ts - see rooms.test.ts for the
 * shared rationale (thin HttpClient-forwarding wrapper).
 */

import { describe, expect, it, vi } from 'vitest';
import { ProjectsResource } from './projects.js';
import type { HttpClient } from '../http.js';

function makeHttp() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as HttpClient & Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>>;
}

describe('ProjectsResource', () => {
  it('list() → GET /api/projects', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([{ id: 'p1' }]);
    const projects = new ProjectsResource(http);

    const result = await projects.list();

    expect(http.get).toHaveBeenCalledWith('/api/projects');
    expect(result).toEqual([{ id: 'p1' }]);
  });

  it('get(projectId) → GET /api/projects/:id', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ id: 'p1', name: 'Proj' });
    const projects = new ProjectsResource(http);

    const result = await projects.get('p1');

    expect(http.get).toHaveBeenCalledWith('/api/projects/p1');
    expect(result).toEqual({ id: 'p1', name: 'Proj' });
  });

  it('create(data) → POST /api/projects with the body', async () => {
    const http = makeHttp();
    http.post.mockResolvedValue({ id: 'p2', name: 'New' });
    const projects = new ProjectsResource(http);
    const data = { name: 'New', roomId: 'r1' };

    const result = await projects.create(data);

    expect(http.post).toHaveBeenCalledWith('/api/projects', data);
    expect(result).toEqual({ id: 'p2', name: 'New' });
  });

  it('update(projectId, data) → PATCH /api/projects/:id with the body', async () => {
    const http = makeHttp();
    http.patch.mockResolvedValue({ id: 'p1', name: 'Renamed' });
    const projects = new ProjectsResource(http);
    const data = { name: 'Renamed' };

    const result = await projects.update('p1', data);

    expect(http.patch).toHaveBeenCalledWith('/api/projects/p1', data);
    expect(result).toEqual({ id: 'p1', name: 'Renamed' });
  });

  it('delete(projectId) → DELETE /api/projects/:id', async () => {
    const http = makeHttp();
    http.delete.mockResolvedValue(undefined);
    const projects = new ProjectsResource(http);

    await projects.delete('p1');

    expect(http.delete).toHaveBeenCalledWith('/api/projects/p1');
  });

  it('export(projectId) → GET /api/projects/:id/export', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ dump: true });
    const projects = new ProjectsResource(http);

    const result = await projects.export('p1');

    expect(http.get).toHaveBeenCalledWith('/api/projects/p1/export');
    expect(result).toEqual({ dump: true });
  });

  it('setWorkflow(projectId, config) → PUT /api/projects/:id/workflow with the body', async () => {
    const http = makeHttp();
    http.put.mockResolvedValue(undefined);
    const projects = new ProjectsResource(http);
    const config = { stage: 'review' };

    await projects.setWorkflow('p1', config);

    expect(http.put).toHaveBeenCalledWith('/api/projects/p1/workflow', config);
  });

  it('setContext(projectId, context) → PUT /api/projects/:id/context with the body', async () => {
    const http = makeHttp();
    http.put.mockResolvedValue(undefined);
    const projects = new ProjectsResource(http);
    const context = { notes: 'x' };

    await projects.setContext('p1', context);

    expect(http.put).toHaveBeenCalledWith('/api/projects/p1/context', context);
  });

  it('addTeamMember(projectId, userId) → POST /api/projects/:id/team with { userId }', async () => {
    const http = makeHttp();
    http.post.mockResolvedValue(undefined);
    const projects = new ProjectsResource(http);

    await projects.addTeamMember('p1', 'u1');

    expect(http.post).toHaveBeenCalledWith('/api/projects/p1/team', { userId: 'u1' });
  });

  it('inviteTeamMember(projectId, email) → POST /api/projects/:id/team/invite with { email }', async () => {
    const http = makeHttp();
    http.post.mockResolvedValue(undefined);
    const projects = new ProjectsResource(http);

    await projects.inviteTeamMember('p1', 'a@example.com');

    expect(http.post).toHaveBeenCalledWith('/api/projects/p1/team/invite', { email: 'a@example.com' });
  });

  it('propagates a rejection from the underlying HttpClient', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(new Error('not found'));
    const projects = new ProjectsResource(http);

    await expect(projects.get('missing')).rejects.toThrow('not found');
  });
});
