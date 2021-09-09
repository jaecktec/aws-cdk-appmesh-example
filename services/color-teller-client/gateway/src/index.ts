import express, { Express } from 'express';
import httpProxy from 'express-http-proxy';

const http = require('http');

const port = process.env['PORT'] || 3001;
const staticFilesDir = process.env['STATIC_FILES'] || 'public';

const app: Express = express();

app.use(express.static(staticFilesDir));

type ServiceConfig = {
  readonly name: string
  readonly endpoint: string
  readonly gatewayPath: string,
}

const services: ServiceConfig[] = [
  {
    name: 'color-service',
    endpoint: process.env['COLOR_BACKEND'] || 'http://color.service.local:3000',
    gatewayPath: '/color',
  },
];

services.forEach(({ gatewayPath, endpoint }) => {
  const path = `/gateway${gatewayPath}`;
  const proxy = httpProxy(endpoint, {
    proxyReqPathResolver: function (req: { url: string; }) {
      return req.url.replace(path, '');
    },
  });
  app.all(`${path}/*`, proxy);
  app.all(path, proxy);
});

app.get('/gateway/version', (_, res) => {
  return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    .end(JSON.stringify({
      version: process.env['VERSION'] || 'local',
    }), 'utf-8');
});

app.get('/health', (_, res) => {
  return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    .end(JSON.stringify({
      status: 'up',
    }), 'utf-8');
});

const server = http.createServer(app);

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

server.listen(port, () => {
  console.log(
    `The application is listening on port ${port} and hosting static files from ${staticFilesDir}`,
  );
});
