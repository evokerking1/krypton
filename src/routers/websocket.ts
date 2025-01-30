import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseUrl } from 'url';
import axios from 'axios';
import { AppState } from '../index';
import Docker, { Container } from 'dockerode';
import { Duplex } from 'stream';
import chalk from 'chalk';

enum LogType {
  INFO = 'info',
  SUCCESS = 'success', 
  ERROR = 'error',
  WARNING = 'warning',
  DAEMON = 'daemon'
}

interface ConsoleSession {
  socket: WebSocket;
  container: Container;
  stream?: Duplex;
  serverId: string;
  internalId: string;
  userId: string;
  authenticated: boolean;
  logStream: any;
  stdin?: Duplex;
  lastLogIndex: number;
}

interface ValidateResponse {
  validated: boolean;
  server: {
    id: string;
    name: string;
    internalId: string;
    node: {
      id: string;
      name: string;
      fqdn: string;
      port: number;
    }
  }
}

interface ContainerStatsResponse {
  memory_stats: {
    usage: number;
    limit: number;
  };
  cpu_stats: {
    cpu_usage: {
      total_usage: number;
    };
    system_cpu_usage: number;
    online_cpus: number;
  };
  precpu_stats: {
    cpu_usage: {
      total_usage: number;
    };
    system_cpu_usage: number;
  };
  networks?: {
    eth0?: {
      rx_bytes: number;
      tx_bytes: number;
    };
  };
}

export class WebSocketManager {
  private appState: AppState;
  private sessions = new Map<WebSocket, ConsoleSession>();
  private logBuffers = new Map<string, string[]>();
  private readonly MAX_LOGS = 100;
  private readonly INITIAL_LOGS = 10;

  constructor(appState: AppState) {
    this.appState = appState;
    this.configureWebSocketRouter();
  }

  private formatLogMessage(type: LogType, message: string): string {
    switch (type) {
      case LogType.INFO:
        return chalk.hex('90a2b9')(message);
      case LogType.SUCCESS:
        return chalk.green(message);
      case LogType.ERROR:
        return chalk.red(message);
      case LogType.WARNING:
        return chalk.yellow(message);
      case LogType.DAEMON:
        return chalk.yellow(`[Krypton Daemon]`) + ' ' + message;
      default:
        return message;
    }
  }

  private addLogToBuffer(internalId: string, log: string) {
    if (!this.logBuffers.has(internalId)) {
      this.logBuffers.set(internalId, []);
    }
    const buffer = this.logBuffers.get(internalId)!;
    if (!buffer.includes(log)) { // Ensure the log is not already in the buffer
      buffer.push(log);
      if (buffer.length > this.MAX_LOGS) {
        buffer.shift();
      }
    }
  }

  private broadcastToServer(internalId: string, log: string, type: LogType = LogType.INFO) {
    const formattedLog = this.formatLogMessage(type, log);
    this.addLogToBuffer(internalId, formattedLog);
    
    for (const [socket, session] of this.sessions.entries()) {
      if (session.internalId === internalId && session.authenticated) {
        try {
          socket.send(JSON.stringify({
            event: 'console_output',
            data: { message: formattedLog }
          }));
        } catch (error) {
          console.error('Failed to broadcast log:', error);
        }
      }
    }
  }

  // Throttle logs to prevent mass log spamming
  private throttledBroadcastToServer = this.throttle(this.broadcastToServer, 1000);

  private throttle(func: Function, limit: number) {
    let inThrottle: boolean;
    return function(this: any, ...args: any[]) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    }
  }

  private async validateToken(internalId: string, token: string): Promise<ValidateResponse | null> {
    try {
      const response = await axios.get(`${this.appState.config.appUrl}/api/servers/${internalId}/validate`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      return response.data;
    } catch (error) {
      console.error('Token validation failed:', error);
      return null;
    }
  }

  private calculateCPUPercent(stats: ContainerStatsResponse): number {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuCount = stats.cpu_stats.online_cpus;
    
    return (systemDelta > 0 && cpuDelta > 0) 
      ? (cpuDelta / systemDelta) * cpuCount * 100
      : 0;
  }

  private async handleSendCommand(session: ConsoleSession, command: string) {
    try {
      // Sanitize the command to prevent command injection
      const sanitizedCommand = command.replace(/[^a-zA-Z0-9\s]/g, '');
      console.log('[Command Handler] Starting command execution:', sanitizedCommand);
      
      const { spawn } = require('child_process');
      
      const dockerAttach = spawn('docker', [
        'attach',
        '--sig-proxy=false',  // Prevent signal forwarding
        session.container.id
      ], {
        stdio: ['pipe', 'inherit', 'inherit']
      });
  
      // Send the sanitized command
      dockerAttach.stdin.write(sanitizedCommand + '\n');
      console.log('[Command Handler] Command sent:', sanitizedCommand);
      
      // Brief delay then end stdin (might detach cleanly)
      setTimeout(() => {
        try {
          dockerAttach.stdin.end();
          console.log('[Command Handler] Ended stdin');
        } catch (err) {
          console.error('[Command Handler] Error during stdin end:', err);
        }
      }, 100);
  
    } catch (error) {
      console.error('[Command Handler] Error:', error);
    }
  }

  private async startResourceMonitoring(session: ConsoleSession) {
    const interval = setInterval(async () => {
      try {
        const containerInfo = await session.container.inspect();
        const state = containerInfo.State.Status;

        if (state === 'running') {
          const stats = await session.container.stats({ stream: false }) as ContainerStatsResponse;
          session.socket.send(JSON.stringify({
            event: 'stats',
            data: {
              state,
              cpu_percent: this.calculateCPUPercent(stats),
              memory: {
                used: stats.memory_stats.usage,
                limit: stats.memory_stats.limit,
                percent: (stats.memory_stats.usage / stats.memory_stats.limit) * 100
              },
              network: stats.networks?.eth0 ?? { rx_bytes: 0, tx_bytes: 0 }
            }
          }));
        } else {
          session.socket.send(JSON.stringify({
            event: 'stats',
            data: { state }
          }));
        }
      } catch (error) {
        console.error('Failed to get container stats:', error);
      }
    }, 2000);

    session.socket.on('close', () => clearInterval(interval));
  }

  private getLogsForSession(internalId: string): string[] {
    return this.logBuffers.get(internalId) || [];
  }

  private async setupContainerSession(socket: WebSocket, internalId: string, validation: ValidateResponse) {
    try {
      console.log(`[WebSocket] Setting up session for server ${internalId}`);
      
      const server = await this.appState.db.get(
        'SELECT docker_id FROM servers WHERE id = ?',
        [internalId]
      );
  
      if (!server?.docker_id) {
        console.error(`[WebSocket] No docker_id found for server ${internalId}`);
        throw new Error('Server not found or no container assigned');
      }
  
      const container = this.appState.docker.getContainer(server.docker_id);
      const containerInfo = await container.inspect();
      
      const session: ConsoleSession = {
        socket,
        serverId: validation.server.id,
        internalId: validation.server.internalId,
        userId: validation.server.id,
        container,
        authenticated: true,
        logStream: null,
        lastLogIndex: 0 // Initialize the lastLogIndex
      };
      
      this.sessions.set(socket, session);
  
      const logs = this.getLogsForSession(internalId);
  
      // Send historical logs as console_output events
      logs.forEach(log => {
        socket.send(JSON.stringify({
          event: 'console_output',
          data: { message: log }
        }));
      });

      // Send stats immediately on auth success
      const stats = await session.container.stats({ stream: false }) as ContainerStatsResponse;
      socket.send(JSON.stringify({
        event: 'stats',
        data: {
          state: containerInfo.State.Status,
          cpu_percent: this.calculateCPUPercent(stats),
          memory: {
            used: stats.memory_stats.usage,
            limit: stats.memory_stats.limit,
            percent: (stats.memory_stats.usage / stats.memory_stats.limit) * 100
          },
          network: stats.networks?.eth0 ?? { rx_bytes: 0, tx_bytes: 0 }
        }
      }));
  
      socket.send(JSON.stringify({
        event: 'auth_success',
        data: {
          state: containerInfo.State.Status
        }
      }));
  
      await this.attachLogs(session);
      await this.startResourceMonitoring(session);
  
      console.log(`[WebSocket] Session setup complete`);
      return session;
  
    } catch (error) {
      console.error('[WebSocket] Failed to set up session:', error);
      socket.close(1011, 'Failed to initialize session');
      return null;
    }
  }
  
  private async attachLogs(session: ConsoleSession) {
    try {
      if (session.logStream) {
        session.logStream.destroy();
      }
  
      session.logStream = await session.container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: 0
      });
  
      // Buffer to hold incomplete lines
      let buffer = '';
      const decoder = new TextDecoder('utf-8');
  
      session.logStream.on('data', (chunk: Buffer) => {
        try {
          // Extract the actual log content from the Docker log format
          // Docker log format: 8-byte header followed by log content
          const header = chunk.slice(0, 8);
          const content = chunk.slice(8);
          
          // Decode the content to string
          const data = decoder.decode(content);
          
          // Add to buffer and process
          buffer += data;
          
          // Split on both \n and \r\n to handle different line endings
          const lines = buffer.split(/\r?\n/);
          
          // Keep the last potentially incomplete line in buffer
          buffer = lines.pop() || '';
  
          // Process complete lines
          for (const line of lines) {
            if (line.trim()) {
              // Clean up the line
              const cleaned = line
                .replace('pterodactyl', 'argon') // Because we support Pterodactyl eggs... and they make it very clear it's Pterodactyl 
  
              if (cleaned) {
                // Add the cleaned log to the buffer
                this.addLogToBuffer(session.internalId, cleaned);
  
                // Send the log to the client
                session.socket.send(JSON.stringify({
                  event: 'console_output',
                  data: { message: cleaned }
                }));
              }
            }
          }
        } catch (error) {
          console.error('[Logs] Error processing output:', error);
        }
      });
  
      session.logStream.on('error', (error) => {
        console.error('[Logs] Stream error:', error);
        // Attempt to reattach logs on error
        setTimeout(() => this.attachLogs(session), 5000);
      });
  
    } catch (error) {
      console.error('[Logs] Setup error:', error);
      // Attempt to reattach logs on error
      setTimeout(() => this.attachLogs(session), 5000);
    }
  }

  private async handlePowerAction(session: ConsoleSession, action: string) {
    try {
      this.broadcastToServer(session.internalId, `Performing a ${action} action on server...`, LogType.DAEMON);

      switch (action) {
        case 'start':
          await session.container.start();
          await this.attachLogs(session);
          break;

        case 'stop':
          await session.container.stop();
          break;

        case 'restart':
          await session.container.restart();
          await this.attachLogs(session);
          break;
      }

      // Clear log buffers on power state changes
      this.logBuffers.delete(session.internalId);

      const containerInfo = await session.container.inspect();
      const state = containerInfo.State.Status;
      const error = containerInfo.State.Error || '';

      session.socket.send(JSON.stringify({
        event: 'power_status',
        data: {
          status: state === 'running' ? 
            `${chalk.yellow('[Krypton Daemon]')} The server is now powered on and will begin the pre-boot process.` : 
            `${chalk.yellow('[Krypton Daemon]')} The server has successfully been powered off.`,
          action,
          state,
          error
        }
      }));

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.broadcastToServer(session.internalId, `Failed to ${action} server: ${errorMsg}`, LogType.ERROR);
      console.error(`Server ${action} failed:`, error);
      
      session.socket.send(JSON.stringify({
        event: 'error',
        data: { message: errorMsg }
      }));
    }
  }

  private configureWebSocketRouter() {
    this.appState.wsServer.on('connection', async (socket: WebSocket, request: any) => {
      console.log('[WebSocket] New connection received');
      
      const { query } = parseUrl(request.url!, true);
      const internalId = query.server as string;
      const token = query.token as string;
  
      console.log(`[WebSocket] Connection attempt for server ${internalId}`);
  
      if (!internalId || !token) {
        console.log('[WebSocket] Missing server ID or token');
        socket.close(1008, 'Missing server ID or token');
        return;
      }
  
      console.log('[WebSocket] Validating token...');
      const validation = await this.validateToken(internalId, token);
      if (!validation?.validated) {
        console.log('[WebSocket] Token validation failed');
        socket.close(1008, 'Invalid token or access denied');
        return;
      }
  
      console.log('[WebSocket] Token validated, setting up session...');
      const session = await this.setupContainerSession(socket, internalId, validation);
      if (!session) {
        console.log('[WebSocket] Session setup failed');
        return;
      }
  
      console.log('[WebSocket] Session setup complete, attaching message handlers...');
      if (!session) return;

      socket.on('message', async (message: string) => {
        try {
          const parsed = JSON.parse(message);
          
          switch (parsed.event) {
            case 'send_command':
              await this.handleSendCommand(session, parsed.data);
              break;

            case 'power_action':
              await this.handlePowerAction(session, parsed.data.action);
              break;
          }
        } catch (error) {
          console.error('Failed to process message:', error);
          socket.send(JSON.stringify({
            event: 'error',
            data: { message: 'Failed to process command' }
          }));
        }
      });

      socket.on('close', () => {
        try {
          if (session.stdin) {
            session.stdin.end();
          }
          if (session.stream) {
            session.stream.end();
          }
          if (session.logStream) {
            session.logStream.destroy();
          }
        } catch (error) {
          console.error('[WebSocket] Error during cleanup:', error);
        }
        this.sessions.delete(socket);
      });
    });
  }
}

export function configureWebSocketRouter(appState: AppState) {
  return new WebSocketManager(appState);
}