/**
 * 📖 read-tracker.ts
 *
 * Tracks the last message ID each agent has seen in each room.
 * Used to fetch unread messages when an agent is mentioned.
 *
 * Storage: .read-tracker.json in gateway root directory
 */

import * as fs from 'fs';
import * as path from 'path';

const TRACKER_FILE = path.join(__dirname, '..', '.read-tracker.json');

interface ReadState {
  [agentId: string]: {
    [roomId: string]: {
      lastMessageId: string;
      lastSeenAt: number; // timestamp
    };
  };
}

let state: ReadState = {};

/** Load tracker state from disk */
export function loadReadTracker(): void {
  try {
    if (fs.existsSync(TRACKER_FILE)) {
      state = JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf-8'));
      console.log('📖 Read tracker loaded');
    }
  } catch (err: any) {
    console.warn(`⚠️ Failed to load read tracker: ${err.message}`);
    state = {};
  }
}

/** Save tracker state to disk */
function saveReadTracker(): void {
  try {
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(state, null, 2));
  } catch (err: any) {
    console.error(`❌ Failed to save read tracker: ${err.message}`);
  }
}

/** Get the last message ID seen by an agent in a room */
export function getLastSeenMessageId(agentId: string, roomId: string): string | null {
  return state[agentId]?.[roomId]?.lastMessageId ?? null;
}

/** Update the last seen message for an agent in a room */
export function markMessageSeen(agentId: string, roomId: string, messageId: string): void {
  if (!state[agentId]) state[agentId] = {};
  if (!state[agentId][roomId]) state[agentId][roomId] = { lastMessageId: '', lastSeenAt: 0 };
  
  state[agentId][roomId].lastMessageId = messageId;
  state[agentId][roomId].lastSeenAt = Date.now();
  
  saveReadTracker();
}

/** Get timestamp of last seen message (for debugging) */
export function getLastSeenTimestamp(agentId: string, roomId: string): number | null {
  return state[agentId]?.[roomId]?.lastSeenAt ?? null;
}
