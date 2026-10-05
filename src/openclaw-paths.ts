/**
 * Locations of the local OpenClaw installation used by the openclaw-inject
 * delivery and the OpenClawBridge helper.
 *
 * The base directory comes from OPENCLAW_HOME. When it is unset or blank the
 * historical default /root/.openclaw applies, so an existing OpenClaw-style
 * deployment keeps working without any configuration change.
 */

import * as path from 'node:path';

export const DEFAULT_OPENCLAW_HOME = '/root/.openclaw';

export function resolveOpenClawHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_HOME?.trim();
  return configured ? configured : DEFAULT_OPENCLAW_HOME;
}

export function openClawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.posix.join(resolveOpenClawHome(env), 'openclaw.json');
}

export function openClawDevicePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.posix.join(resolveOpenClawHome(env), 'identity', 'device.json');
}

export function openClawReplyScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.posix.join(resolveOpenClawHome(env), 'workspace', 'send-to-triologue.sh');
}

/**
 * Reply instruction appended to every message injected into an OpenClaw
 * session. Resolved per message so it follows OPENCLAW_HOME.
 */
export function openClawReplyHint(roomId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `(Reply with: ${openClawReplyScriptPath(env)} ${roomId} "<your message>")`;
}
