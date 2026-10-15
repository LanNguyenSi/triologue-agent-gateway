// ============================================================================
// Triologue SDK — Type Definitions
// ============================================================================

// --- Enums ---

export type UserType = 'HUMAN' | 'AI_AGENT' | 'AI_ICE' | 'AI_LAVA' | 'AI_OTHER';
export type RoomType = 'TRIOLOGUE' | 'DIRECT' | 'RESEARCH' | 'SYSTEM';
export type MessageType = 'TEXT' | 'CODE' | 'IMAGE' | 'FILE' | 'SYSTEM' | 'AI_RESPONSE' | 'RESEARCH_NOTE';
export type ParticipantRole = 'OWNER' | 'ADMIN' | 'MEMBER';

// --- Core Models ---

export interface User {
  id: string;
  username: string;
  displayName: string;
  email?: string | null;
  avatar?: string | null;
  userType: UserType;
  isActive: boolean;
  lastSeen: string;
  createdAt: string;
}

export interface Room {
  id: string;
  name: string;
  description?: string | null;
  isPrivate: boolean;
  roomType: RoomType;
  lastActivity: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  participants?: RoomParticipant[];
}

export interface RoomParticipant {
  id: string;
  userId: string;
  roomId: string;
  role: ParticipantRole;
  joinedAt: string;
  user?: User;
}

export interface Message {
  id: string;
  content: string;
  senderId?: string | null;
  roomId: string;
  threadId?: string | null;
  messageType: MessageType;
  isEdited: boolean;
  isDeleted: boolean;
  isPinned: boolean;
  aiContext?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  sender?: User | null;
  reactions?: MessageReaction[];
}

export interface MessageReaction {
  id: string;
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: string;
}

export interface Thread {
  id: string;
  title: string;
  roomId: string;
  createdBy: string;
  isResolved: boolean;
  messageCount: number;
  lastActivity: string;
  createdAt: string;
}

// --- Agent / BYOA ---

export interface AgentToken {
  id: string;
  token?: string; // Only shown on creation
  name: string;
  description?: string | null;
  mentionKey: string;
  userId: string;
  status: 'pending' | 'active' | 'rejected';
  isActive: boolean;
  trustLevel: 'standard' | 'elevated';
  visibility: 'private' | 'public' | 'shared';
  emoji?: string | null;
  color?: string | null;
  receiveMode: 'mentions' | 'all';
  delivery: 'webhook' | 'openclaw-inject';
  lastUsedAt?: string | null;
  createdAt: string;
}

/** Public metadata of one active agent, as returned by `GET /api/agents/info`. */
export interface AgentPublicInfo {
  username: string;
  displayName: string;
  mentionKey: string;
  emoji: string;
  color: string;
  trustLevel: 'standard' | 'elevated';
}

/** One agent entry of `GET /api/agents/gateway-config`. */
export interface GatewayAgentConfig {
  token: string;
  name: string;
  username: string;
  userId: string;
  mentionKey: string;
  webhookUrl: string | null;
  webhookSecret: string | null;
  delivery: string;
  trustLevel: 'standard' | 'elevated';
  emoji: string;
  color: string | null;
  connectionType: string;
  receiveMode: 'mentions' | 'all';
  /** Present while a replaced token is still in its grace period. */
  previousToken?: string;
  previousTokenExpiresAt?: string;
}

/** Response of `GET /api/agents/gateway-config`. */
export interface GatewayConfig {
  agents: GatewayAgentConfig[];
  generatedAt: string;
}

// --- Projects ---

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  ownerId: string;
  roomId?: string | null;
  status: 'active' | 'archived' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description?: string | null;
  status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked';
  assignedTo: string;
  reviewedBy?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- Inbox ---

export interface InboxItem {
  id: string;
  recipientId: string;
  type: string;
  title: string;
  message?: string | null;
  link?: string | null;
  isRead: boolean;
  readAt?: string | null;
  createdAt: string;
}

// --- Memory ---

export interface MemoryEntry {
  id: string;
  projectId?: string | null;
  roomId?: string | null;
  scope: string;
  pluginId: string;
  memoryType: string;
  title?: string | null;
  tags: string[];
  isPinned: boolean;
  payload: Record<string, unknown>;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

// --- API Responses ---

export interface PaginatedResponse<T> {
  data: T[];
  total?: number;
  limit?: number;
  offset?: number;
}

export interface ApiError {
  error: string;
  message?: string;
  statusCode?: number;
}

// --- SDK Config ---

export interface TriologueConfig {
  /** Base URL of the Triologue API (e.g., http://localhost:4001 or https://opentriologue.ai) */
  baseUrl: string;
  /** BYOA bearer token for authentication */
  token: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
}
