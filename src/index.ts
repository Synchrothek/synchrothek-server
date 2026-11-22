import { startServer } from './server.ts';
import { loadConfig, type Config } from './config.ts';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Konfigurationsfehler: ${(err as Error).message}`);
  process.exit(1);
}

const limit = (value: number, unit: string, zero: string) => (value > 0 ? `${value} ${unit}` : zero);

const server = await startServer(config);
console.log(`Synchrothek-Server lauscht auf ws://${config.host}:${server.port}`);
console.log(
  [
    `  Proxy vertrauen: ${config.trustProxy ? 'ja' : 'nein'}`,
    `Verbindungen/IP: ${limit(config.maxConnectionsPerIp, '', 'unbegrenzt').trim()}`,
    `Teilnehmer/Raum: ${limit(config.maxRoomMembers, '', 'unbegrenzt').trim()}`,
    `Raumdauer: ${limit(config.maxRoomDurationMs / 60_000, 'min', 'unbegrenzt')}`,
    `Inaktivität: ${limit(config.idleTimeoutMs / 60_000, 'min', 'aus')}`,
    `Origins: ${config.allowedOrigins.join(', ') || 'alle'}`,
  ].join(' · '),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
