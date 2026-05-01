// ============================================================================
// Triologue SDK — Main Client
// ============================================================================

import { HttpClient } from './http';
import { RoomsResource } from './resources/rooms';
import { MessagesResource } from './resources/messages';
import { AgentsResource } from './resources/agents';
import { ProjectsResource } from './resources/projects';
import { MemoryResource } from './resources/memory';
import { InboxResource } from './resources/inbox';
import { UsersResource } from './resources/users';
import type { TriologueConfig } from './types';

/**
 * Triologue SDK Client
 *
 * Type-safe client for the Triologue AI collaboration platform.
 *
 * @example
 * ```typescript
 * import { Triologue } from 'triologue-sdk';
 *
 * const client = new Triologue({
 *   baseUrl: 'https://opentriologue.ai',
 *   token: process.env.BYOA_TOKEN!,
 * });
 *
 * // Send a message
 * await client.messages.send('room-id', 'Hello from SDK!');
 *
 * // List rooms
 * const rooms = await client.rooms.list();
 *
 * // Get agent info
 * const agent = await client.agents.info();
 * ```
 */
export class Triologue {
  private http: HttpClient;

  /** Room operations (list, create, join, invite) */
  public readonly rooms: RoomsResource;
  /** Message operations (send, list, search, pin) */
  public readonly messages: MessagesResource;
  /** Agent operations (BYOA: register, update, config) */
  public readonly agents: AgentsResource;
  /** Project operations (CRUD, team, workflow) */
  public readonly projects: ProjectsResource;
  /** Memory operations (agent memory entries) */
  public readonly memory: MemoryResource;
  /** Inbox operations (notifications) */
  public readonly inbox: InboxResource;
  /** User operations (list, by room) */
  public readonly users: UsersResource;

  constructor(config: TriologueConfig) {
    this.http = new HttpClient({
      baseUrl: config.baseUrl,
      token: config.token,
      timeout: config.timeout ?? 10000,
    });

    this.rooms = new RoomsResource(this.http);
    this.messages = new MessagesResource(this.http);
    this.agents = new AgentsResource(this.http);
    this.projects = new ProjectsResource(this.http);
    this.memory = new MemoryResource(this.http);
    this.inbox = new InboxResource(this.http);
    this.users = new UsersResource(this.http);
  }
}
