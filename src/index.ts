import express from 'express';
import { Server as HttpServer } from 'http';
import Docker from 'dockerode';
import * as sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs/promises';
import * as path from 'path';
import si from 'systeminformation';
import yaml from 'js-yaml';
import cors from 'cors';

// Routers
import { configureServersRouter, runInstallation } from './routers/servers';
import { configureStateRouter } from './routers/state';
import { configureWebSocketRouter } from './routers/websocket';

export const VERSION = '1.0.0';

// Types
export interface Config {
  apiKey: string;
  bindAddress: string;
  bindPort: number;
  volumesDirectory: string;
  appUrl: string;
  corsOrigin: string;
}

export interface ServerInstallConfig {
  dockerImage: string;
  script: string;
  entrypoint?: string;
}

export interface ServerVariable {
  name: string;
  description: string;
  currentValue?: string;
  defaultValue: string;
  rules: string;
}

export enum ServerState {
  Creating = 'creating',      // Initial state when request received
  Installing = 'installing',  // Running install script
  InstallFailed = 'install_failed', // Installation failed
  Installed = 'installed',    // Successfully installed
  Starting = 'starting',
  Running = 'running',
  Stopping = 'stopping',
  Stopped = 'stopped',
  Errored = 'errored',
  Deleting = 'deleting'      // Being removed
}

export interface ServerConfig {
  dockerImage: string;
  startupCommand: string;
  install: ServerInstallConfig;
  variables: ServerVariable[];
  configFiles: Array<{
    path: string;
    content: string;
  }>;
}

export interface Server {
  id: string;
  dockerId?: string;
  name: string;
  image: string;
  state: string;
  memoryLimit: number;
  cpuLimit: number;
  variables: string;
  startupCommand: string;
}

export interface SystemState {
  version: string;
  kernel: string;
  osVersion: string;
  hostname: string;
  cpuCores: number;
  memoryTotal: number;
  containers: ContainerStats;
}

export interface ContainerStats {
  total: number;
  running: number;
  stopped: number;
}

// Application state interface
export interface AppState {
  docker: Docker;
  db: Database;
  config: Config;
  systemInfo: typeof si;
  wsServer: WebSocketServer;
  runInstallation: (serverId: string, config: any) => Promise<void>;
}

// Default configuration
const defaultConfig: Config = {
  apiKey: 'your-secret-key',
  bindAddress: '127.0.0.1',
  bindPort: 8080,
  volumesDirectory: './volumes',
  appUrl: 'http://localhost:3000',
  corsOrigin: 'http://localhost:5173',
};

// Load configuration
async function loadConfig(): Promise<Config> {
  const configPath = path.join(process.cwd(), 'config.yml');
  
  try {
    await fs.access(configPath);
    const contents = await fs.readFile(configPath, 'utf8');
    return yaml.load(contents) as Config;
  } catch (error) {
    const defaultYaml = yaml.dump(defaultConfig);
    await fs.writeFile(configPath, defaultYaml, 'utf8');
    return defaultConfig;
  }
}

// Initialize database
async function initDb(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      docker_id TEXT,
      name TEXT NOT NULL,
      image TEXT NOT NULL,
      state TEXT NOT NULL,
      memory_limit INTEGER NOT NULL,
      cpu_limit INTEGER NOT NULL,
      variables TEXT NOT NULL,
      startup_command TEXT NOT NULL,
      install_script TEXT NOT NULL,
      allocation TEXT NOT NULL,
      config_files TEXT
    )
  `);
}

// API key middleware
function apiKeyMiddleware(config: Config) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const apiKey = req.header('X-API-Key');
    
    if (!apiKey || apiKey !== config.apiKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    next();
  };
}

// Main application initialization
async function main() {
  try {
    // Load configuration
    const config = await loadConfig();

    // Create volumes directory
    await fs.mkdir(config.volumesDirectory, { recursive: true });

    // Initialize Docker client
    const docker = new Docker();

    // Initialize SQLite database
    const db = await open({
      filename: 'krypton.db',
      driver: sqlite3.Database
    });
    await initDb(db);

    // Initialize Express app
    const app = express();
    app.use(express.json());

    // Create HTTP server
    const server = new HttpServer(app);

    // Initialize WebSocket server
    const wsServer = new WebSocketServer({ server });

    // Create app state
    const appState: AppState = {
      docker,
      db,
      config,
      systemInfo: si,
      wsServer,
      runInstallation: async (serverId: string, config: any) => 
        runInstallation(appState, serverId, config)
    };

    app.use(cors({
      origin: (origin, callback) => {
        const allowedOrigins = config.corsOrigin.split(',');
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      credentials: true
    }));

    // Configure routes
    app.use('/api/v1/servers', apiKeyMiddleware(config), configureServersRouter(appState));
    app.use('/api/v1/state', configureStateRouter(appState));

    // Configure WebSocket router
    configureWebSocketRouter(appState);

    // Start server
    server.listen(config.bindPort, config.bindAddress, () => {
      console.log(`Krypton is now running on ${config.bindAddress}:${config.bindPort}`);
      wsServer.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            event: 'daemon_message',
            data: `Daemon started on ${config.bindAddress}:${config.bindPort}`
          }));
        }
      });
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the application
main();