import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

dotenv.config({ quiet: true });

const dev = process.argv.includes('--dev');
const app = createApp();
const server = createServer(app);
if (dev) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: 'custom',
  });
  app.use(vite.middlewares);
  app.get('/{*path}', async (req, res, next) => {
    try {
      res
        .type('html')
        .send(await vite.transformIndexHtml(req.originalUrl, await readFile(resolve('index.html'), 'utf8')));
    } catch (e) {
      next(e);
    }
  });
} else {
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
}
let port = Number(process.env.PORT) || 4173;
const initialPort = port;
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && port < initialPort + 20) {
    port++;
    server.listen(port, '127.0.0.1');
  } else {
    console.error(error.message);
    process.exit(1);
  }
});
server.on('listening', () => console.log(`Lineage is ready at http://127.0.0.1:${port}`));
server.listen(port, '127.0.0.1');
