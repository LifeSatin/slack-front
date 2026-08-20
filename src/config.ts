import 'dotenv/config';
import { z } from 'zod';

const bool = z.string().default('false').transform((v) => v.toLowerCase() === 'true');
const schema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SOCKET_MODE: bool,
  SLACK_TEAM_ID: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  BACKEND_BASE_URL: z.string().url().default('http://localhost:8080'),
  BACKEND_WS_URL: z.string().url().default('ws://localhost:8080/ws/chat'),
  BACKEND_SERVICE_TOKEN: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_PATH: z.string().default('./data/meetu.sqlite'),
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  MESSAGE_CONFIRM_TIMEOUT_MS: z.coerce.number().int().positive().default(10000)
}).superRefine((v, ctx) => {
  if (v.SLACK_SOCKET_MODE && !v.SLACK_APP_TOKEN) ctx.addIssue({ code: 'custom', path: ['SLACK_APP_TOKEN'], message: 'Socket Mode requires SLACK_APP_TOKEN' });
});

export type Config = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);
