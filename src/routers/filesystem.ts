// @ts-nocheck
// Daemon: src/routers/filesystem.ts 

import express, { Router } from 'express';
import expressWs from 'express-ws';
import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import * as path from 'path';
import { AppState } from '../index';
import axios from 'axios';
import multer from 'multer';
import archiver from 'archiver';
import extract from 'extract-zip';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';

interface FileStats {
  name: string;
  mode: string;
  size: number;
  isFile: boolean;
  isSymlink: boolean;
  modifiedAt: number;
  createdAt: number;
  mime: string;
}

interface ValidationResponse {
  validated: boolean;
  server: {
    id: string;
    internalId: string;
  }
}

interface FileOperationResponse {
  success: boolean;
  message?: string;
  error?: string;
}

// Extend the Request interface to include the server property
interface AuthenticatedRequest extends Request {
  server?: {
    id: string;
    internalId: string;
  };
}

export function configureFilesystemRouter(appState: AppState): Router {
  const router = Router();
  const wsInstance = expressWs(express());
  const wsRouter = wsInstance.app;
  const upload = multer({ dest: 'uploads/' });

  const routerWithWs = Object.assign(router, {
    ws: wsRouter.ws.bind(wsRouter)
  });

  // Validate auth token against panel
  async function validateToken(serverId: string, token: string): Promise<ValidationResponse | null> {
    try {
      const response = await axios.get(
        `${appState.config.appUrl}/api/servers/${serverId}/validate`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 5000
        }
      );
      return response.data;
    } catch (error) {
      console.error('Token validation failed:', error);
      return null;
    }
  }

  // Auth middleware
  async function authMiddleware(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) {
    const authHeader = req.header('Authorization');
    const serverId = req.params.serverId;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);
    const validation = await validateToken(serverId, token);

    if (!validation?.validated) {
      return res.status(403).json({ error: 'Invalid token or access denied' });
    }

    req.server = validation.server;
    next();
  }

  // Sanitize and validate paths
  function getValidatedPath(serverId: string, requestPath: string): string | null {
    try {
      // Get the base server path
      const serverPath = path.join(appState.config.volumesDirectory, serverId);
      
      // Normalize and join the requested path
      const fullPath = path.normalize(path.join(serverPath, requestPath));

      // Ensure the path stays within the server directory
      if (!fullPath.startsWith(serverPath)) {
        return null;
      }

      return fullPath;
    } catch (error) {
      return null;
    }
  }

  // List directory contents
  router.get('/:serverId/list/*?', authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const requestPath = req.params[0] || '.';
      const fullPath = getValidatedPath(req.server.internalId, requestPath);

      if (!fullPath) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      const stats = await fs.stat(fullPath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }

      const contents = await fs.readdir(fullPath, { withFileTypes: true });
      const files: FileStats[] = await Promise.all(
        contents.map(async (dirent) => {
          const filePath = path.join(fullPath, dirent.name);
          const stats = await fs.stat(filePath);
          
          return {
            name: dirent.name,
            mode: stats.mode.toString(8).slice(-4),
            size: stats.size,
            isFile: dirent.isFile(),
            isSymlink: dirent.isSymbolicLink(),
            modifiedAt: stats.mtimeMs,
            createdAt: stats.ctimeMs,
            mime: dirent.isFile() ? mime.lookup(dirent.name) || 'application/octet-stream' : 'inode/directory'
          };
        })
      );

      res.json({ contents: files });
    } catch (error) {
      console.error('Failed to list directory:', error);
      res.status(500).json({ error: 'Failed to list directory contents' });
    }
  });

  // Get file contents
  router.get('/:serverId/contents/*', authMiddleware, async (req, res) => {
    try {
      const filePath = req.params[0];
      const fullPath = getValidatedPath(req.server.internalId, filePath);

      if (!fullPath) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      const stats = await fs.stat(fullPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Path is not a file' });
      }

      // Don't try to read very large files
      if (stats.size > 100 * 1024 * 1024) { // 100MB limit
        return res.status(413).json({ error: 'File too large to read' });
      }

      const stream = createReadStream(fullPath);
      res.setHeader('Content-Type', mime.lookup(fullPath) || 'application/octet-stream');
      res.setHeader('Content-Length', stats.size);
      
      await pipeline(stream, res);
    } catch (error) {
      console.error('Failed to read file:', error);
      res.status(500).json({ error: 'Failed to read file contents' });
    }
  });

  // Write file contents
  router.post('/:serverId/write/*', authMiddleware, express.raw({ limit: '100mb', type: '*/*' }), async (req, res) => {
    try {
      const filePath = req.params[0];
      const fullPath = getValidatedPath(req.server.internalId, filePath);

      if (!fullPath) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      // Create directory if it doesn't exist
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      await fs.writeFile(fullPath, req.body);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to write file:', error);
      res.status(500).json({ error: 'Failed to write file contents' });
    }
  });

  // Delete file or directory
  router.delete('/:serverId/delete/*', authMiddleware, async (req, res) => {
    try {
      const targetPath = req.params[0];
      const fullPath = getValidatedPath(req.server.internalId, targetPath);

      if (!fullPath) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      const stats = await fs.stat(fullPath);
      
      if (stats.isDirectory()) {
        await fs.rm(fullPath, { recursive: true, force: true });
      } else {
        await fs.unlink(fullPath);
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Failed to delete:', error);
      res.status(500).json({ error: 'Failed to delete target' });
    }
  });

  // Create directory
  router.post('/:serverId/create-directory/*', authMiddleware, async (req, res) => {
    try {
      const dirPath = req.params[0];
      const fullPath = getValidatedPath(req.server.internalId, dirPath);

      if (!fullPath) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      await fs.mkdir(fullPath, { recursive: true });
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to create directory:', error);
      res.status(500).json({ error: 'Failed to create directory' });
    }
  });

  // Rename/move file or directory
  router.post('/:serverId/rename', authMiddleware, express.json(), async (req, res) => {
    try {
      const { from, to } = req.body;
      
      const fromPath = getValidatedPath(req.server.internalId, from);
      const toPath = getValidatedPath(req.server.internalId, to);

      if (!fromPath || !toPath) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      await fs.rename(fromPath, toPath);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to rename:', error);
      res.status(500).json({ error: 'Failed to rename target' });
    }
  });

  // Copy file or directory
  router.post('/:serverId/copy', authMiddleware, express.json(), async (req, res) => {
    try {
      const { from, to } = req.body;
      
      const fromPath = getValidatedPath(req.server.internalId, from);
      const toPath = getValidatedPath(req.server.internalId, to);

      if (!fromPath || !toPath) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      const stats = await fs.stat(fromPath);
      
      if (stats.isDirectory()) {
        // Recursive copy for directories
        await fs.cp(fromPath, toPath, { recursive: true });
      } else {
        // Simple copy for files
        await fs.copyFile(fromPath, toPath);
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Failed to copy:', error);
      res.status(500).json({ error: 'Failed to copy target' });
    }
  });

  // Change file permissions
  router.post('/:serverId/chmod', authMiddleware, express.json(), async (req, res) => {
    try {
      const { path: targetPath, mode } = req.body;
      
      const fullPath = getValidatedPath(req.server.internalId, targetPath);
      if (!fullPath) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      // Convert mode to octal number if it's a string
      const modeNum = typeof mode === 'string' ? parseInt(mode, 8) : mode;
      
      await fs.chmod(fullPath, modeNum);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to change permissions:', error);
      res.status(500).json({ error: 'Failed to change permissions' });
    }
  });

  // Upload file(s)
  router.post('/:serverId/upload/*', authMiddleware, upload.array('files'), async (req, res) => {
    try {
      const targetDir = req.params[0] || '.';
      const fullTargetDir = getValidatedPath(req.server.internalId, targetDir);

      if (!fullTargetDir) {
        return res.status(400).json({ error: 'Invalid target directory' });
      }

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files provided' });
      }

      // Process each uploaded file
      const results = await Promise.all(files.map(async (file) => {
        try {
          const targetPath = path.join(fullTargetDir, file.originalname);
          await fs.rename(file.path, targetPath);
          return { name: file.originalname, success: true };
        } catch (error) {
          return { name: file.originalname, success: false, error: error.message };
        }
      }));

      res.json({ files: results });
    } catch (error) {
      console.error('Failed to process uploads:', error);
      res.status(500).json({ error: 'Failed to process file uploads' });
    }
  });

  // Download directory as zip
  router.get('/:serverId/download/*', authMiddleware, async (req, res) => {
    try {
      const targetPath = req.params[0] || '.';
      const fullPath = getValidatedPath(req.server.internalId, targetPath);

      if (!fullPath) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      const stats = await fs.stat(fullPath);
      
      const archive = archiver('zip', {
        zlib: { level: 9 }
      });

      res.attachment(`${path.basename(targetPath)}.zip`);
      archive.pipe(res);

      if (stats.isDirectory()) {
        archive.directory(fullPath, false);
      } else {
        archive.file(fullPath, { name: path.basename(fullPath) });
      }

      await archive.finalize();
    } catch (error) {
      console.error('Failed to create download:', error);
      res.status(500).json({ error: 'Failed to create download' });
    }
  });

  // Extract zip archive
  router.post('/:serverId/extract/*', authMiddleware, upload.single('file'), async (req, res) => {
    try {
      const targetDir = req.params[0] || '.';
      const fullTargetDir = getValidatedPath(req.server.internalId, targetDir);

      if (!fullTargetDir) {
        return res.status(400).json({ error: 'Invalid target directory' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      await extract(req.file.path, { dir: fullTargetDir });
      await fs.unlink(req.file.path);

      res.json({ success: true });
    } catch (error) {
      console.error('Failed to extract archive:', error);
      res.status(500).json({ error: 'Failed to extract archive' });
    }
  });

  // Get disk usage for server
  router.get('/:serverId/disk-usage', authMiddleware, async (req, res) => {
    try {
      const serverPath = path.join(appState.config.volumesDirectory, req.server.internalId);
      
      let totalSize = 0;
      let fileCount = 0;
      
      async function calculateSize(dirPath: string) {
        const items = await fs.readdir(dirPath, { withFileTypes: true });
        
        for (const item of items) {
          const fullPath = path.join(dirPath, item.name);
          
          if (item.isDirectory()) {
            await calculateSize(fullPath);
          } else if (item.isFile()) {
            const stats = await fs.stat(fullPath);
            totalSize += stats.size;
            fileCount++;
          }
        }
      }

      await calculateSize(serverPath);

      res.json({
        bytes: totalSize,
        files: fileCount,
        human: `${(totalSize / (1024 * 1024)).toFixed(2)} MB`
      });
    } catch (error) {
      console.error('Failed to calculate disk usage:', error);
      res.status(500).json({ error: 'Failed to calculate disk usage' });
    }
  });

  // Search files
  router.get('/:serverId/search', authMiddleware, async (req, res) => {
    try {
      const { query, path: searchPath = '.' } = req.query;
      const fullPath = getValidatedPath(req.server.internalId, searchPath as string);

      if (!fullPath) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'Invalid search query' });
      }

      const results: FileStats[] = [];
      const searchPattern = new RegExp(query, 'i');

      async function searchFiles(dirPath: string) {
        const items = await fs.readdir(dirPath, { withFileTypes: true });

        for (const item of items) {
          const fullItemPath = path.join(dirPath, item.name);
          
          if (searchPattern.test(item.name)) {
            const stats = await fs.stat(fullItemPath);
            results.push({
              name: path.relative(fullPath, fullItemPath),
              mode: stats.mode.toString(8).slice(-4),
              size: stats.size,
              isFile: item.isFile(),
              isSymlink: item.isSymbolicLink(),
              modifiedAt: stats.mtimeMs,
              createdAt: stats.ctimeMs,
              mime: item.isFile() ? mime.lookup(item.name) || 'application/octet-stream' : 'inode/directory'
            });
          }

          if (item.isDirectory()) {
            await searchFiles(fullItemPath);
          }
        }
      }

      await searchFiles(fullPath);
      res.json({ results });
    } catch (error) {
      console.error('Failed to search files:', error);
      res.status(500).json({ error: 'Failed to search files' });
    }
  });

  // Compress files/directories
  router.post('/:serverId/compress', authMiddleware, express.json(), async (req, res) => {
    try {
      const { files, destination } = req.body;

      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'No files specified' });
      }

      const destinationPath = getValidatedPath(req.server.internalId, destination);
      if (!destinationPath) {
        return res.status(400).json({ error: 'Invalid destination path' });
      }

      const archive = archiver('zip', {
        zlib: { level: 9 }
      });

      const output = createWriteStream(destinationPath);
      archive.pipe(output);

      // Add each file/directory to the archive
      for (const file of files) {
        const filePath = getValidatedPath(req.server.internalId, file);
        if (!filePath) {
          continue;
        }

        const stats = await fs.stat(filePath);
        if (stats.isDirectory()) {
          archive.directory(filePath, path.basename(file));
        } else {
          archive.file(filePath, { name: path.basename(file) });
        }
      }

      await archive.finalize();
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to compress files:', error);
      res.status(500).json({ error: 'Failed to compress files' });
    }
  });

  // Stream file changes (websocket)
  routerWithWs.ws('/:serverId/watch/*', async (ws, req) => {
    let watcher: fs.FileHandle | null = null;
    
    try {
      const filePath = req.params[0];
      const fullPath = getValidatedPath(req.params.serverId, filePath);

      if (!fullPath) {
        ws.close(1008, 'Invalid path');
        return;
      }

      // Validate authentication
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        ws.close(1008, 'Invalid authorization');
        return;
      }

      const token = authHeader.substring(7);
      const validation = await validateToken(req.params.serverId, token);

      if (!validation?.validated) {
        ws.close(1008, 'Invalid token');
        return;
      }

      // Open file for watching
      watcher = await fs.open(fullPath, 'r');
      const stats = await watcher.stat();
      let position = stats.size;

      // Send initial file contents
      const initialContent = await fs.readFile(fullPath, 'utf8');
      ws.send(JSON.stringify({
        event: 'content',
        data: initialContent
      }));

      // Watch for changes
      const interval = setInterval(async () => {
        try {
          if (!watcher) return;

          const stats = await watcher.stat();
          if (stats.size < position) {
            // File was truncated
            position = 0;
          }

          if (stats.size > position) {
            const buffer = Buffer.alloc(stats.size - position);
            await watcher.read(buffer, 0, buffer.length, position);
            position = stats.size;

            ws.send(JSON.stringify({
              event: 'update',
              data: buffer.toString('utf8')
            }));
          }
        } catch (error) {
          console.error('Error watching file:', error);
          clearInterval(interval);
          ws.close(1011, 'Error watching file');
        }
      }, 1000);

      ws.on('close', () => {
        clearInterval(interval);
        if (watcher) {
          watcher.close().catch(console.error);
        }
      });

    } catch (error) {
      console.error('Failed to setup file watching:', error);
      if (watcher) {
        await watcher.close();
      }
      ws.close(1011, 'Failed to setup file watching');
    }
  });

  return routerWithWs;
}