// src/routes/state.ts
import { Router } from 'express';
import { AppState, SystemState, ContainerStats, VERSION } from '../index';

let cachedSystemState: SystemState | null = null;
let cacheTimestamp: number | null = null;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes in milliseconds

export function configureStateRouter(appState: AppState): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const now = Date.now();

      if (cachedSystemState && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
        return res.json(cachedSystemState);
      }

      const { docker, systemInfo } = appState;

      // Get container statistics
      const containers = await docker.listContainers({ all: true });

      const containerStats: ContainerStats = {
        total: containers.length,
        running: containers.filter(c => c.State === 'running').length,
        stopped: containers.filter(c => c.State === 'exited').length,
      };

      // Get system information
      const [cpuInfo, osInfo, memInfo] = await Promise.all([
        systemInfo.cpu(),
        systemInfo.osInfo(),
        systemInfo.mem(),
      ]);

      const systemState: SystemState = {
        version: VERSION,
        kernel: osInfo.kernel || 'unknown',
        osVersion: osInfo.distro || 'unknown',
        hostname: osInfo.hostname || 'unknown',
        cpuCores: cpuInfo.cores || 0,
        memoryTotal: memInfo.total || 0,
        containers: containerStats,
      };

      cachedSystemState = systemState;
      cacheTimestamp = now;

      res.json(systemState);
    } catch (error) {
      console.error('Failed to get system state:', error);
      res.status(500).json({ error: 'Failed to get system state' });
    }
  });

  return router;
}