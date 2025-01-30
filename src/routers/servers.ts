import express, { Router } from 'express';
import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { Writable } from 'stream';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AppState, ServerState } from '../index';
import { Exec, ExecCreateOptions } from 'dockerode';
import { Duplex } from 'stream';

// Types that represent what we expect from the panel
interface ServerConfig {
  dockerImage: string;
  variables: Array<{
    name: string;
    description?: string;
    defaultValue: string;
    currentValue?: string;
    rules: string;
  }>;
  startupCommand: string;
  configFiles: Array<{
    path: string;
    content: string;
  }>;
  install: {
    dockerImage: string;
    entrypoint: string;
    script: string;
  };
}

interface CreateServerRequest {
  serverId: string;
  validationToken: string;
  name: string;
  memoryLimit: number;
  cpuLimit: number;
  allocation: {
    bindAddress: string;
    port: number;
  };
}

// Helper functions for server management
async function fetchServerConfig(appUrl: string, serverId: string): Promise<ServerConfig> {
  const url = `${appUrl}/api/servers/${serverId}/config`;
  const maxRetries = 3;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, { timeout: 10000 });
      if (response.status === 200) {
        return response.data;
      }
    } catch (error) {
      console.error(`Failed to fetch server configuration (attempt ${attempt}/${maxRetries}):`, error.message);
      lastError = error;
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw new Error(`Failed to fetch server configuration after ${maxRetries} attempts: ${lastError?.message}`);
}

async function validateServerWithPanel(appUrl: string, serverId: string, validationToken: string): Promise<boolean> {
  try {
    const response = await axios.post(
      `${appUrl}/api/servers/validate/${serverId}`,
      { validationToken },
      { timeout: 5000 }
    );
    return response.status === 200;
  } catch (error) {
    console.error('Failed to validate server with panel:', error);
    return false;
  }
}

async function writeConfigFiles(volumePath: string, configFiles: ServerConfig['configFiles']): Promise<void> {
  for (const file of configFiles) {
    const safePath = path.normalize(file.path).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(volumePath, safePath);
    
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    
    try {
      await fs.writeFile(fullPath, file.content, 'utf8');
      console.log(`Created config file: ${safePath}`);
    } catch (error) {
      console.error(`Failed to write config file ${safePath}:`, error);
      throw new Error(`Failed to write config file ${safePath}`);
    }
  }
}

function processVariables(input: string, variables: ServerConfig['variables']): string {
  let result = input;
  
  for (const variable of variables) {
    const placeholder = `%${variable.name.toLowerCase().replace(/ /g, '_')}%`;
    const value = variable.currentValue ?? variable.defaultValue;
    
    if (!validateVariableValue(value, variable.rules)) {
      throw new Error(`Variable ${variable.name} value doesn't match rules: ${variable.rules}`);
    }
    
    result = result.replace(placeholder, value);
  }
  
  return result;
}

function validateVariableValue(value: string, rules: string): boolean {
  const ruleList = rules.split('|');
  
  for (const rule of ruleList) {
    switch (true) {
      case rule === 'nullable':
        if (value === '') return true;
        break;
      case rule === 'string':
        break;
      case rule.startsWith('max:'):
        const max = parseInt(rule.slice(4), 10);
        if (!isNaN(max) && value.length > max) return false;
        break;
    }
  }
  
  return true;
}

async function pullDockerImage(docker: any, image: string): Promise<void> {
  try {
    console.log(`Pulling Docker image: ${image}`);
    await new Promise((resolve, reject) => {
      docker.pull(image, (err: any, stream: any) => {
        if (err) return reject(err);
        
        docker.modem.followProgress(stream, (err: any, output: any) => {
          if (err) return reject(err);
          resolve(output);
        });
      });
    });
  } catch (error) {
    console.error(`Failed to pull Docker image ${image}:`, error);
    throw new Error(`Failed to pull Docker image ${image}`);
  }
}

function sanitizeVolumeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function logEvent(serverId: string, message: string, error?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [Server ${serverId}] ${message}`;
  console.log(logMessage);
  if (error) {
    console.error(`${logMessage} Error:`, error);
  }
}

// Main server installation process
export async function runInstallation(
  appState: AppState, 
  serverId: string,
  serverConfig: ServerConfig
): Promise<void> {
  const { docker, config, wsServer } = appState;
  const safeServerId = sanitizeVolumeName(serverId);
  const volumePath = path.resolve(`${config.volumesDirectory}/${safeServerId}`);

  logEvent(serverId, 'Starting installation process');
  
  try {
    logEvent(serverId, 'Pulling required Docker images');
    await Promise.all([
      pullDockerImage(docker, serverConfig.install.dockerImage)
        .then(() => logEvent(serverId, `Successfully pulled install image: ${serverConfig.install.dockerImage}`)),
      pullDockerImage(docker, serverConfig.dockerImage)
        .then(() => logEvent(serverId, `Successfully pulled server image: ${serverConfig.dockerImage}`))
    ]);

    logEvent(serverId, `Creating volume directory at: ${volumePath}`);
    await fs.mkdir(volumePath, { recursive: true });

    if (serverConfig.configFiles.length > 0) {
      logEvent(serverId, `Writing ${serverConfig.configFiles.length} configuration files`);
      await writeConfigFiles(volumePath, serverConfig.configFiles);
    }

    const installContainerName = `${safeServerId}_install`;
    logEvent(serverId, `Creating installation container: ${installContainerName}`);

    const processedScript = processVariables(serverConfig.install.script, serverConfig.variables);
    
    const scriptContent = `
${processedScript}
echo "Installation script completed" >> /mnt/server/install.log 2>&1
`;

    await fs.writeFile(path.join(volumePath, 'install.sh'), scriptContent, { mode: 0o755 });

    const environmentVariables = [
      'TERM=xterm',
      'HOME=/mnt/server',  // Note: Different path for install container
      'USER=container',
      ...serverConfig.variables.map(variable => 
        `${variable.name}=${variable.currentValue || variable.defaultValue}`
      )
    ];

const container = await docker.createContainer({
  name: installContainerName,
  Image: serverConfig.install.dockerImage,
  HostConfig: {
    Binds: [`${volumePath}:/mnt/server`],
    AutoRemove: true
  },
  WorkingDir: '/mnt/server',
  Cmd: ["./install.sh"],
  AttachStdin: true,
  AttachStdout: true,
  AttachStderr: true,
  Tty: true,
  OpenStdin: true,
  Env: environmentVariables  // env
});

    logEvent(serverId, `Created container with config: ${JSON.stringify({
      name: installContainerName,
      image: serverConfig.install.dockerImage,
      volumePath,
      cmd: "./install.sh"
    }, null, 2)}`);

    // Log the install script content
    logEvent(serverId, `Install script content:\n${scriptContent}`);

    logEvent(serverId, 'Starting installation container');

    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true
    });

    let output = '';
    let lastChunk = '';

    const stdout = new Writable({
      write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const message = chunk.toString();
        lastChunk = message;
        if (message.trim()) {
          output += message;
          logEvent(serverId, `Installation stdout: ${message.trim()}`);
          
          wsServer.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                event: 'console_output',
                serverId,
                data: message
              }));
            }
          });
        }
        callback();
      }
    });

    const stderr = new Writable({
      write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const message = chunk.toString();
        lastChunk = message;
        if (message.trim()) {
          output += message;
          logEvent(serverId, `Installation stderr: ${message.trim()}`);
        }
        callback();
      }
    });

    docker.modem.demuxStream(stream, stdout, stderr);

    await container.start();
    logEvent(serverId, 'Container started, waiting for completion...');

    const result = await container.wait();
    logEvent(serverId, `Container exited with status code: ${result.StatusCode}`);
    logEvent(serverId, `Last output received: ${lastChunk}`);
    logEvent(serverId, `Full installation output:\n${output}`);

    if (result.StatusCode !== 0) {
      throw new Error(`Installation failed with exit code ${result.StatusCode}.\nLast output: ${lastChunk}\nFull output:\n${output}`);
    }

    logEvent(serverId, 'Installation completed successfully');

  } catch (error) {
    logEvent(serverId, 'Installation failed', error);
    throw error;
  } finally {
    try {
      const container = docker.getContainer(`${safeServerId}_install`);
      logEvent(serverId, 'Cleaning up installation container');
      //await container.remove({ force: true }).catch(() => {});
    } catch (cleanupError) {
      logEvent(serverId, 'Failed to remove installation container', cleanupError);
    }
  }
}

// Create the game server container
async function createGameContainer(
  appState: AppState,
  serverId: string,
  config: ServerConfig,
  memoryLimit: number,
  cpuLimit: number,
  allocation: { bindAddress: string; port: number }
): Promise<string> {
  const { docker } = appState;
  const safeServerId = sanitizeVolumeName(serverId);
  const volumePath = path.resolve(`${appState.config.volumesDirectory}/${safeServerId}`);
  
  const processedStartupCommand = processVariables(config.startupCommand, config.variables);
  
  // Map environment variables from the config
  const environmentVariables = [
    'TERM=xterm',
    'HOME=/home/container',
    'USER=container',
    `STARTUP=${processedStartupCommand}`,
    ...config.variables.map(variable => 
      `${variable.name}=${variable.currentValue || variable.defaultValue}`
    )
  ];

  const container = await docker.createContainer({
    name: safeServerId,
    Image: config.dockerImage,
    
    // Don't override the entrypoint/cmd - let the image handle it
    Entrypoint: undefined,
    Cmd: undefined,
    
    // Standard configuration
    WorkingDir: '/home/container',
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    Tty: false,
    StdinOnce: false,
    User: 'container',
    
    // Environment setup
    Env: environmentVariables,
    
    HostConfig: {
      // Memory limits
      Memory: memoryLimit,
      MemorySwap: memoryLimit * 2, // Double the memory limit for swap
      
      // CPU limits if provided
      CpuQuota: cpuLimit ? cpuLimit * 100000 : 0,
      CpuPeriod: 100000,
      
      // Network configuration
      NetworkMode: 'bridge',
      
      // Security options
      Init: true,
      SecurityOpt: ['no-new-privileges'],
      ReadonlyPaths: [
        '/proc/bus',
        '/proc/fs',
        '/proc/irq',
        '/proc/sys',
        '/proc/sysrq-trigger'
      ],
      
      // Container restart policy
      RestartPolicy: {
        Name: 'unless-stopped'
      },
      
      // Volume mounting
      Binds: [`${volumePath}:/home/container:rw`],
      
      // Port bindings - handle both TCP and UDP
      PortBindings: {
        [`${allocation.port}/tcp`]: [{
          HostIp: allocation.bindAddress,
          HostPort: allocation.port.toString()
        }],
        [`${allocation.port}/udp`]: [{
          HostIp: allocation.bindAddress,
          HostPort: allocation.port.toString()
        }]
      },
    },
    
    // Expose both TCP and UDP ports
    ExposedPorts: {
      [`${allocation.port}/tcp`]: {},
      [`${allocation.port}/udp`]: {}
    },

    // Labels for container identification
    Labels: {
      'pterodactyl.server.id': serverId,
      'pterodactyl.server.name': safeServerId
    }
  });

  return container.id;
}

// Configure the router
export function configureServersRouter(appState: AppState): Router {
  const router = Router();

  // Create server
  router.post('/', async (req, res) => {
    try {
      const { serverId, validationToken, name, memoryLimit, cpuLimit, allocation } = req.body as CreateServerRequest;
      
      // Validate with panel first
      const isValid = await validateServerWithPanel(appState.config.appUrl, serverId, validationToken);
      if (!isValid) {
        return res.status(403).json({ error: 'Invalid server registration' });
      }
      
      // Get server configuration from panel
      const serverConfig = await fetchServerConfig(appState.config.appUrl, serverId);
      
      // Create initial database entry
      await appState.db.run(
        `INSERT INTO servers (
          id, docker_id, name, state, memory_limit, cpu_limit, image,
          variables, startup_command, install_script, allocation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          serverId,
          null,
          name,
          ServerState.Installing,
          memoryLimit,
          cpuLimit,
          serverConfig.dockerImage,
          JSON.stringify(serverConfig.variables),
          serverConfig.startupCommand,
          JSON.stringify(serverConfig.install),
          JSON.stringify(allocation)
        ]
      );
      
      // Return success with validation token to confirm identity
      res.status(201).json({
        id: serverId,
        name,
        state: ServerState.Installing,
        validationToken
      });

      // Begin installation process
      runInstallation(appState, serverId, serverConfig)
        .then(async () => {
          const dockerId = await createGameContainer(
            appState,
            serverId,
            serverConfig,
            memoryLimit,
            cpuLimit,
            allocation
          );

          await appState.db.run(
            'UPDATE servers SET docker_id = ?, state = ? WHERE id = ?',
            [dockerId, ServerState.Installed, serverId]
          );
        })
        .catch(async (error) => {
          console.error('Installation failed:', error);
          await appState.db.run(
            'UPDATE servers SET state = ? WHERE id = ?',
            [ServerState.InstallFailed, serverId]
          );
        });
    } catch (error) {
      console.error('Failed to create server:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get all servers
  router.get('/', async (req, res) => {
    try {
      const servers = await appState.db.all('SELECT * FROM servers');
      res.json(servers);
    } catch (error) {
      console.error('Failed to get servers:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get specific server
  router.get('/:id', async (req, res) => {
    try {
      const server = await appState.db.get(
        'SELECT * FROM servers WHERE id = ?',
        [req.params.id]
      );
      
      if (!server) {
        return res.status(404).json({ error: 'Server not found' });
      }
      
      // Get container status if available
      if (server.docker_id) {
        try {
          const container = appState.docker.getContainer(server.docker_id);
          const status = await container.inspect();
          server.status = {
            state: status.State.Status,
            running: status.State.Running,
            startedAt: status.State.StartedAt,
            finishedAt: status.State.FinishedAt
          };
        } catch (error) {
          console.error('Failed to get container status:', error);
          server.status = { state: 'unknown' };
        }
      }
      
      res.json(server);
    } catch (error) {
      console.error('Failed to get server:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Delete server
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const safeId = sanitizeVolumeName(id);
      const server = await appState.db.get(
        'SELECT docker_id FROM servers WHERE id = ?',
        [id]
      );

      if (!server) {
        return res.status(404).json({ error: 'Server not found' });
      }

      // Remove container if it exists
      if (server.docker_id) {
        try {
          const container = appState.docker.getContainer(server.docker_id);
          await container.remove({ force: true, v: true });
          logEvent(id, 'Removed container');
        } catch (error) {
          console.error('Failed to remove container:', error);
          logEvent(id, 'Failed to remove container', error);
        }
      }

      // Remove volume directory
      const volumePath = `${appState.config.volumesDirectory}/${safeId}`;
      await fs.rm(volumePath, { recursive: true, force: true });
      logEvent(id, 'Removed volume directory');

      // Remove from database
      await appState.db.run('DELETE FROM servers WHERE id = ?', [id]);
      logEvent(id, 'Removed from database');

      res.json({ message: 'Server deleted successfully' });
    } catch (error) {
      console.error('Failed to delete server:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Reinstall server
  router.post('/:id/reinstall', async (req, res) => {
    try {
      const { id } = req.params;
      const serverConfig = await fetchServerConfig(appState.config.appUrl, id);

      const server = await appState.db.get(
        'SELECT docker_id FROM servers WHERE id = ?',
        [id]
      );

      if (!server) {
        return res.status(404).json({ error: 'Server not found' });
      }

      // Remove existing container if it exists
      if (server.docker_id) {
        try {
          const container = appState.docker.getContainer(server.docker_id);
          await container.remove({ force: true });
          logEvent(id, 'Removed existing container for reinstall');
        } catch (error) {
          console.error('Failed to remove container:', error);
          logEvent(id, 'Failed to remove container for reinstall', error);
        }
      }

      await appState.db.run(
        'UPDATE servers SET state = ?, docker_id = NULL WHERE id = ?',
        [ServerState.Installing, id]
      );

      // Run installation process
      logEvent(id, 'Starting reinstallation process');
      await runInstallation(appState, id, serverConfig);
      logEvent(id, 'Reinstallation completed');

      await appState.db.run(
        'UPDATE servers SET state = ? WHERE id = ?',
        [ServerState.Installed, id]
      );

      res.json({ message: 'Server reinstallation completed' });
    } catch (error) {
      console.error('Failed to reinstall server:', error);
      logEvent(req.params.id, 'Reinstallation failed', error);
      await appState.db.run(
        'UPDATE servers SET state = ? WHERE id = ?',
        [ServerState.InstallFailed, req.params.id]
      );
      res.status(500).json({ error: error.message });
    }
  });

  // Power actions (start, stop, restart)
  router.post('/:id/power/:action', async (req, res) => {
    try {
      const { id, action } = req.params;

      if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'Invalid power action' });
      }

      const server = await appState.db.get(
        'SELECT docker_id FROM servers WHERE id = ?',
        [id]
      );

      if (!server?.docker_id) {
        return res.status(404).json({ error: 'Server or container not found' });
      }

      const container = appState.docker.getContainer(server.docker_id);
      logEvent(id, `Executing power action: ${action}`);

      switch (action) {
        case 'start':
          await container.start();
          break;
        case 'stop':
          await container.stop();
          break;
        case 'restart':
          await container.restart();
          break;
      }

      // Update container status
      const status = await container.inspect();
      await appState.db.run(
        'UPDATE servers SET state = ? WHERE id = ?',
        [status.State.Status, id]
      );

      res.json({ message: `Power action ${action} completed successfully` });
    } catch (error) {
      console.error('Failed to execute power action:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}