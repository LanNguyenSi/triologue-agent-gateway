/** Agent info from registry/DB */
export interface AgentInfo {
  id: string;
  name: string;
  userId: string;         // Triologue user ID (cuid)
  username: string;       // "ice", "lava", "weatherbot"
  mentionKey: string;     // @mention trigger
  webhookUrl: string | null;
  webhookSecret: string | null;
  trustLevel: 'standard' | 'elevated';
  emoji: string;
  color: string | null;
  connectionType: 'webhook' | 'websocket' | 'both';
  receiveMode: 'mentions' | 'all';
}

/** Inbound event from Triologue Socket.io */
export interface RoomMessage {
  id: string;
  content: string;
  sender: string;
  senderUsername: string;
  senderType: string;
  roomId: string;
  roomName?: string;
  createdAt: string;
}

/** WebSocket client state */
export interface WsClient {
  ws: import('ws').WebSocket;
  agent: AgentInfo;
  connectedAt: number;
}
