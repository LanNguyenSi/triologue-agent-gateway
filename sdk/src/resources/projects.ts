// ============================================================================
// Triologue SDK — Projects Resource
// ============================================================================

import type { HttpClient } from '../http';
import type { Project, Task } from '../types';

export class ProjectsResource {
  constructor(private http: HttpClient) {}

  /** List all projects */
  async list(): Promise<Project[]> {
    return this.http.get<Project[]>('/api/projects');
  }

  /** Get a project by ID */
  async get(projectId: string): Promise<Project> {
    return this.http.get<Project>(`/api/projects/${projectId}`);
  }

  /** Create a project */
  async create(data: {
    name: string;
    description?: string;
    roomId?: string;
  }): Promise<Project> {
    return this.http.post<Project>('/api/projects', data);
  }

  /** Update a project */
  async update(projectId: string, data: Partial<Pick<Project, 'name' | 'description' | 'status'>>): Promise<Project> {
    return this.http.patch<Project>(`/api/projects/${projectId}`, data);
  }

  /** Delete a project */
  async delete(projectId: string): Promise<void> {
    return this.http.delete(`/api/projects/${projectId}`);
  }

  /** Export project data */
  async export(projectId: string): Promise<unknown> {
    return this.http.get(`/api/projects/${projectId}/export`);
  }

  /** Update workflow config */
  async setWorkflow(projectId: string, config: Record<string, unknown>): Promise<void> {
    return this.http.put(`/api/projects/${projectId}/workflow`, config);
  }

  /** Update project context */
  async setContext(projectId: string, context: Record<string, unknown>): Promise<void> {
    return this.http.put(`/api/projects/${projectId}/context`, context);
  }

  /** Add team member */
  async addTeamMember(projectId: string, userId: string): Promise<void> {
    return this.http.post(`/api/projects/${projectId}/team`, { userId });
  }

  /** Invite team member */
  async inviteTeamMember(projectId: string, email: string): Promise<void> {
    return this.http.post(`/api/projects/${projectId}/team/invite`, { email });
  }
}
