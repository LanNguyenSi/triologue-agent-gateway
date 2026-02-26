/**
 * BYOA Metrics — Track connection health, auth failures, message loss
 * 
 * This data will inform the WebSocket → SSE migration decision.
 */

import fs from 'fs';
import path from 'path';

interface MetricsData {
  timestamp: string;
  
  // Connection Stats
  activeConnections: number;
  totalConnections: number;
  disconnects: number;
  
  // Auth Stats
  authFailures: number;
  tokenRevocationAttempts: number; // How many times we wanted to revoke but connection stayed open
  
  // Message Stats
  messagesSent: number;
  messagesLost: number; // Failed after all retries
  messageRetries: number;
  
  // Agent Stats
  agentsByType: {
    websocket: number;
    webhook: number;
  };
}

class MetricsCollector {
  private data: MetricsData;
  private logPath: string;
  private flushInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    this.logPath = path.join(__dirname, '../metrics.jsonl');
    
    this.data = {
      timestamp: new Date().toISOString(),
      activeConnections: 0,
      totalConnections: 0,
      disconnects: 0,
      authFailures: 0,
      tokenRevocationAttempts: 0,
      messagesSent: 0,
      messagesLost: 0,
      messageRetries: 0,
      agentsByType: {
        websocket: 0,
        webhook: 0,
      },
    };
    
    // Flush to disk every 60 seconds
    this.flushInterval = setInterval(() => this.flush(), 60_000);
  }
  
  // --- Connection Events ---
  
  recordConnection(agentId: string, agentName: string): void {
    this.data.activeConnections++;
    this.data.totalConnections++;
    console.log(`📊 Metrics: Connection ${agentName} (active: ${this.data.activeConnections})`);
  }
  
  recordDisconnect(agentId: string, reason: string): void {
    this.data.activeConnections = Math.max(0, this.data.activeConnections - 1);
    this.data.disconnects++;
    console.log(`📊 Metrics: Disconnect (active: ${this.data.activeConnections}, reason: ${reason})`);
  }
  
  // --- Auth Events ---
  
  recordAuthFailure(reason: string): void {
    this.data.authFailures++;
    console.log(`📊 Metrics: Auth failure (total: ${this.data.authFailures}, reason: ${reason})`);
  }
  
  recordTokenRevocationAttempt(agentId: string, reason: string): void {
    this.data.tokenRevocationAttempts++;
    console.log(`📊 Metrics: Token revocation attempted but WS still connected (agent: ${agentId}, reason: ${reason})`);
    console.log(`   ⚠️  This is a security gap that SSE + REST would fix!`);
  }
  
  // --- Message Events ---
  
  recordMessageSent(agentId: string, roomId: string): void {
    this.data.messagesSent++;
  }
  
  recordMessageLost(agentId: string, roomId: string, reason: string): void {
    this.data.messagesLost++;
    console.log(`📊 Metrics: Message lost after retries (agent: ${agentId}, reason: ${reason})`);
    console.log(`   ⚠️  SSE + REST with Redis buffer would prevent this!`);
  }
  
  recordMessageRetry(agentId: string, attempt: number): void {
    this.data.messageRetries++;
  }
  
  // --- Stats ---
  
  updateAgentCounts(websocket: number, webhook: number): void {
    this.data.agentsByType.websocket = websocket;
    this.data.agentsByType.webhook = webhook;
  }
  
  getSnapshot(): MetricsData {
    return { ...this.data };
  }
  
  // --- Persistence ---
  
  private flush(): void {
    const snapshot = this.getSnapshot();
    const line = JSON.stringify(snapshot) + '\n';
    
    try {
      fs.appendFileSync(this.logPath, line, 'utf8');
      console.log(`📊 Metrics flushed (connections: ${snapshot.activeConnections}, sent: ${snapshot.messagesSent}, lost: ${snapshot.messagesLost})`);
    } catch (err) {
      console.error('❌ Failed to flush metrics:', err);
    }
  }
  
  shutdown(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flush(); // Final flush
  }
  
  // --- Analysis (for migration decision) ---
  
  generateReport(): string {
    const s = this.data;
    const authFailureRate = s.totalConnections > 0 ? (s.authFailures / s.totalConnections * 100) : 0;
    const messageLossRate = s.messagesSent > 0 ? (s.messagesLost / s.messagesSent * 100) : 0;
    
    return `
📊 BYOA Gateway Metrics Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Time: ${s.timestamp}

Connections:
  Active:       ${s.activeConnections}
  Total:        ${s.totalConnections}
  Disconnects:  ${s.disconnects}

Auth:
  Failures:     ${s.authFailures} (${authFailureRate.toFixed(1)}% of connections)
  Revocation Attempts: ${s.tokenRevocationAttempts} ⚠️ 
    → These tokens were revoked but WS stayed open!
    → SSE + REST would close immediately

Messages:
  Sent:         ${s.messagesSent}
  Lost:         ${s.messagesLost} (${messageLossRate.toFixed(1)}% loss rate)
  Retries:      ${s.messageRetries}

Agents:
  WebSocket:    ${s.agentsByType.websocket}
  Webhook:      ${s.agentsByType.webhook}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Migration Decision Factors:
  ${s.tokenRevocationAttempts > 0 ? '🚨' : '✅'} Token revocation gaps: ${s.tokenRevocationAttempts}
  ${s.messagesLost > 10 ? '🚨' : '✅'} Message loss: ${s.messagesLost}
  ${authFailureRate > 5 ? '🚨' : '✅'} Auth failure rate: ${authFailureRate.toFixed(1)}%

${s.tokenRevocationAttempts > 0 || s.messagesLost > 10 ? '→ SSE + REST migration recommended!' : '→ Current WebSocket system stable'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();
  }
}

// Singleton
export const metrics = new MetricsCollector();

// CLI tool for analysis
if (require.main === module) {
  const metricsPath = path.join(__dirname, '../metrics.jsonl');
  
  if (!fs.existsSync(metricsPath)) {
    console.log('No metrics data yet. Run the gateway first.');
    process.exit(0);
  }
  
  const lines = fs.readFileSync(metricsPath, 'utf8').trim().split('\n');
  const data = lines.map(line => JSON.parse(line));
  
  // Aggregate stats
  const totals = data.reduce((acc, entry) => ({
    totalConnections: acc.totalConnections + entry.totalConnections,
    authFailures: acc.authFailures + entry.authFailures,
    tokenRevocationAttempts: acc.tokenRevocationAttempts + entry.tokenRevocationAttempts,
    messagesSent: acc.messagesSent + entry.messagesSent,
    messagesLost: acc.messagesLost + entry.messagesLost,
    messageRetries: acc.messageRetries + entry.messageRetries,
  }), {
    totalConnections: 0,
    authFailures: 0,
    tokenRevocationAttempts: 0,
    messagesSent: 0,
    messagesLost: 0,
    messageRetries: 0,
  });
  
  console.log('📊 Aggregated Metrics (all time):');
  console.log(`  Connections: ${totals.totalConnections}`);
  console.log(`  Auth Failures: ${totals.authFailures}`);
  console.log(`  Token Revocation Attempts: ${totals.tokenRevocationAttempts} ⚠️`);
  console.log(`  Messages Sent: ${totals.messagesSent}`);
  console.log(`  Messages Lost: ${totals.messagesLost}`);
  console.log(`  Message Retries: ${totals.messageRetries}`);
  console.log();
  console.log(`📈 Latest snapshot:`);
  console.log(data[data.length - 1]);
}
