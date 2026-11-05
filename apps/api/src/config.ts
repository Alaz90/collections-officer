import { z } from 'zod';

/**
 * All configuration comes from environment variables. Every external
 * service is optional: without its key the app falls back to a local
 * stand-in, so the demo runs end to end on a laptop with no accounts.
 */
const Env = z.object({
  PORT: z.coerce.number().default(8080),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),
  DASHBOARD_ORIGIN: z.string().default('http://localhost:5173'),
  /** Shared secret the scheduler sends to start the daily cycle. */
  CRON_SECRET: z.string().optional(),

  STORE: z.enum(['memory', 'firestore']).default('memory'),
  FIREBASE_PROJECT_ID: z.string().default('collections-officer'),
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),

  /** firebase = verify Firebase ID tokens; demo = trust the x-demo-role header (local only). */
  AUTH_MODE: z.enum(['firebase', 'demo']).default('demo'),
  /** Comma-separated emails that get the manager role. */
  MANAGER_EMAILS: z.string().default(''),
  /** Comma-separated emails allowed in as officers. Anyone not listed here or above is refused. */
  OFFICER_EMAILS: z.string().default(''),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),

  CHAPA_SECRET_KEY: z.string().optional(),
  CHAPA_WEBHOOK_SECRET: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().default('demolender_collections_bot'),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  WEATHER: z.enum(['open-meteo', 'fixed']).default('open-meteo'),
  /** Seed the demo lender on start when the store is empty. */
  SEED_DEMO: z.enum(['true', 'false']).default('true'),
  LENDER_ID: z.string().default('demo'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
