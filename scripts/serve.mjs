// Development server for public/: static files with caching turned off, so an
// edit is always what the browser runs. Usage:
//   npm start                        # http://localhost:5391/
//   npm start -- --host 0.0.0.0      # also reachable from other devices on the LAN
//   npm start -- --port 8080
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

export function createStaticServer(root = PUBLIC_DIR) {
  const base = resolve(root);

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    let file = resolve(base, `.${pathname}`);
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(404, { 'Content-Type': TYPES['.txt'], 'Cache-Control': 'no-store' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error(error);
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end('Internal error');
    });
  });
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => net.address);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: process.env.PORT ?? '5391' },
      host: { type: 'string', default: process.env.HOST ?? 'localhost' },
    },
  });
  const port = Number(values.port);
  const server = createStaticServer();
  server.listen(port, values.host, () => {
    console.log(`Camera Cast is running at http://localhost:${port}/`);
    if (values.host === '0.0.0.0' || values.host === '::') {
      for (const address of lanAddresses()) console.log(`  on your network: http://${address}:${port}/`);
      console.log('  (other devices can watch over plain http; sharing a camera needs https or localhost)');
    }
  });
}
