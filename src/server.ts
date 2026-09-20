import http from 'node:http';
import { Client } from 'discord.js';

/**
 * Создает минимальный HTTP-сервер для прохождения health check на Render
 * и для поддержания бота в активном состоянии (через пинг UptimeRobot/cron-job.org).
 */
export function startHealthServer(client: Client, port: number = Number(process.env.PORT) || 3000): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: 'ok',
        botReady: client.isReady(),
        botTag: client.user?.tag || null,
        guildsCount: client.guilds.cache.size,
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
      }, null, 2));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`[HTTP Server] Health-check сервер запущен на порту ${port}`);
  });

  return server;
}
