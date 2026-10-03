import { pino } from 'pino';

export const logger = pino({
  name: 'ayv-agent',
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['*.privateKey', '*.seed', '*.secretKey', 'config.RELAYER_PRIVATE_KEY', 'config.AMADEUS_SEED_B58'],
});

export type Logger = typeof logger;
