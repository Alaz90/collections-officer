import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getAuth } from 'firebase-admin/auth';
import { Playbook } from '@co/shared';
import { z } from 'zod';
import { askManagerAgent } from './agent/manager.js';
import { CollectionsAgent } from './agent/service.js';
import { OutboxChannel, TelegramChannel } from './adapters/channels.js';
import { firebaseApp, firestoreStore } from './adapters/firestore.js';
import { GeminiAI } from './adapters/gemini.js';
import { memoryStore, uuid } from './adapters/memory.js';
import { ChapaPayments, FakePayments, validChapaSignature } from './adapters/payments.js';
import { TemplateAI } from './adapters/templateAI.js';
import { DemoOverrideWeather, FixedWeather, OpenMeteoWeather } from './adapters/weather.js';
import { loadConfig, type Config } from './config.js';
import { toIsoDate } from './domain/dates.js';
import { convert, parseCsv, suggestMapping, type Mapping } from './importer.js';
import type { Deps, Lender, Segment } from './ports.js';
import { DEMO_RAINFALL, seedDemo } from './seed.js';
import { runSandbox, type PolicyProposal } from './sim/sandbox.js';
import { portfolioView, todayView, weeklyReport } from './views.js';

type Role = 'officer' | 'manager';
declare module 'express-serve-static-core' {
  interface Request {
    role?: Role;
    userEmail?: string;
  }
}

export function buildDeps(config: Config) {
  const app = config.STORE === 'firestore' || config.AUTH_MODE === 'firebase' ? firebaseApp(config.FIREBASE_PROJECT_ID, config.FIREBASE_SERVICE_ACCOUNT) : null;
  const store = config.STORE === 'firestore' && app ? firestoreStore(app) : memoryStore();
  const ai = config.GEMINI_API_KEY ? new GeminiAI(config.GEMINI_API_KEY, config.GEMINI_MODEL) : new TemplateAI();
  const fake = new FakePayments(config.PUBLIC_BASE_URL);
  const payments = config.CHAPA_SECRET_KEY ? new ChapaPayments(config.CHAPA_SECRET_KEY, config.PUBLIC_BASE_URL) : fake;
  const telegram = config.TELEGRAM_BOT_TOKEN ? new TelegramChannel(config.TELEGRAM_BOT_TOKEN) : null;
  const outbox = new OutboxChannel();
  const live = config.WEATHER === 'open-meteo' ? new OpenMeteoWeather() : new FixedWeather({});
  const weather = new DemoOverrideWeather(live, DEMO_RAINFALL);
  const deps: Deps = { store, ai, payments, channel: telegram ?? outbox, weather, clock: { now: () => new Date() }, ids: uuid };
  return { deps, app, fake, telegram, outbox };
}

export function createServer(config: Config, built = buildDeps(config)) {
  const { deps, app: fbApp, fake, telegram } = built;
  const agent = new CollectionsAgent(deps);
  const lenderId = config.LENDER_ID;
  const today = () => toIsoDate(deps.clock.now());
  const gemini = config.GEMINI_API_KEY ? { apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL } : undefined;
  const managers = new Set(config.MANAGER_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb', verify: (req, _res, buf) => ((req as Request & { rawBody?: string }).rawBody = buf.toString()) }));
  app.use(express.text({ type: 'text/csv', limit: '4mb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.DASHBOARD_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Demo-Role');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

  // --- Auth ---------------------------------------------------------------
  const requireRole = (need: Role) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (config.AUTH_MODE === 'demo') {
        req.role = req.header('x-demo-role') === 'officer' ? 'officer' : 'manager';
      } else {
        const token = req.header('authorization')?.replace(/^Bearer /, '');
        if (!token || !fbApp) return res.status(401).json({ error: 'sign in required' });
        const decoded = await getAuth(fbApp).verifyIdToken(token);
        req.userEmail = decoded.email;
        req.role = decoded.email && managers.has(decoded.email.toLowerCase()) ? 'manager' : 'officer';
      }
      if (need === 'manager' && req.role !== 'manager') return res.status(403).json({ error: 'managers only' });
      next();
    } catch {
      res.status(401).json({ error: 'invalid sign-in' });
    }
  };
  const officer = requireRole('officer');
  const manager = requireRole('manager');

  // --- Health and scheduler ----------------------------------------------
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      store: config.STORE,
      ai: gemini ? `gemini (${config.GEMINI_MODEL})` : 'templates',
      payments: deps.payments.name,
      channel: telegram ? 'telegram' : 'outbox',
      auth: config.AUTH_MODE,
    }),
  );

  /** Called by the scheduler every morning (Cloud Scheduler or GitHub Actions). */
  app.post(
    '/api/cycle/run',
    wrap(async (req, res) => {
      const viaCron = config.CRON_SECRET && req.header('x-cron-secret') === config.CRON_SECRET;
      if (!viaCron) {
        await new Promise<void>((resolve, reject) => manager(req, res, (err?: unknown) => (err ? reject(err) : resolve())));
        if (res.headersSent) return;
      }
      const { actions } = await agent.dailyCycle(lenderId);
      res.json({ ok: true, actions });
    }),
  );

  // --- Officer ------------------------------------------------------------
  app.get('/api/me', officer, (req, res) => res.json({ role: req.role, email: req.userEmail ?? null }));
  app.get('/api/today', officer, wrap(async (_req, res) => res.json(await todayView(deps.store, agent, lenderId, today()))));

  app.get(
    '/api/cases/:borrowerId',
    officer,
    wrap(async (req, res) => {
      const borrower = await deps.store.borrowers.get(String(req.params.borrowerId));
      if (!borrower) return res.status(404).json({ error: 'not found' });
      const [loans, messages, plans, payments, runs] = await Promise.all([
        deps.store.loans.list(lenderId),
        deps.store.messages.list(lenderId),
        deps.store.plans.list(lenderId),
        deps.store.payments.list(lenderId),
        deps.store.runs.list(lenderId),
      ]);
      const loan = loans.find((l) => l.borrowerId === borrower.id);
      const view = (await agent.preview(lenderId)).find((c) => c.borrower.id === borrower.id);
      res.json({
        borrower,
        loan,
        risk: view?.risk ?? null,
        nextAction: view?.decision ?? null,
        rainfall: view?.region ?? null,
        messages: messages.filter((m) => m.borrowerId === borrower.id).sort((a, b) => a.at.localeCompare(b.at)),
        plans: plans.filter((p) => p.loanId === loan?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        payments: payments.filter((p) => p.loanId === loan?.id).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
        runs: runs.filter((r) => r.borrowerId === borrower.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
        telegramInvite: `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${borrower.id}`,
      });
    }),
  );

  app.get(
    '/api/approvals',
    officer,
    wrap(async (_req, res) => {
      const [messages, plans, borrowers, loans] = await Promise.all([
        deps.store.messages.list(lenderId),
        deps.store.plans.list(lenderId),
        deps.store.borrowers.list(lenderId),
        deps.store.loans.list(lenderId),
      ]);
      const name = new Map(borrowers.map((b) => [b.id, b.name]));
      const loanOwner = new Map(loans.map((l) => [l.id, l.borrowerId]));
      res.json({
        messages: messages.filter((m) => m.status === 'pending_approval').map((m) => ({ ...m, borrowerName: name.get(m.borrowerId) })),
        plans: plans
          .filter((p) => p.status === 'pending_approval')
          .map((p) => ({ ...p, borrowerId: loanOwner.get(p.loanId), borrowerName: name.get(loanOwner.get(p.loanId) ?? '') })),
      });
    }),
  );

  app.post(
    '/api/messages/:id/approve',
    officer,
    wrap(async (req, res) => {
      const text = z.object({ text: z.string().optional() }).parse(req.body ?? {}).text;
      res.json({ delivered: await agent.approveMessage(lenderId, String(req.params.id), text) });
    }),
  );
  app.post(
    '/api/messages/:id/reject',
    officer,
    wrap(async (req, res) => {
      const m = await deps.store.messages.get(String(req.params.id));
      if (!m) return res.status(404).json({ error: 'not found' });
      await deps.store.messages.put({ ...m, status: 'blocked' });
      res.json({ ok: true });
    }),
  );
  app.post('/api/plans/:id/approve', manager, wrap(async (req, res) => res.json(await agent.approvePlan(lenderId, String(req.params.id)) ?? { ok: true })));
  app.post(
    '/api/plans/:id/reject',
    manager,
    wrap(async (req, res) => {
      const p = await deps.store.plans.get(String(req.params.id));
      if (!p) return res.status(404).json({ error: 'not found' });
      await deps.store.plans.put({ ...p, status: 'rejected' });
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/loans/:id/officer-call',
    officer,
    wrap(async (req, res) => {
      const body = z.object({ note: z.string().min(1), keepWithOfficer: z.boolean().default(false) }).parse(req.body);
      await agent.logOfficerCall(lenderId, String(req.params.id), body.note, body.keepWithOfficer);
      res.json({ ok: true });
    }),
  );

  // --- Manager ------------------------------------------------------------
  app.get('/api/portfolio', manager, wrap(async (_req, res) => res.json(await portfolioView(deps.store, agent, lenderId, today()))));
  app.get('/api/report/weekly', manager, wrap(async (_req, res) => res.json(await weeklyReport(deps.store, agent, lenderId, today()))));
  app.get('/api/playbook', officer, wrap(async (_req, res) => res.json(await deps.store.lenders.get(lenderId))));
  app.put(
    '/api/playbook',
    manager,
    wrap(async (req, res) => {
      const lender = (await deps.store.lenders.get(lenderId))!;
      const playbook = Playbook.parse(req.body.playbook);
      await deps.store.lenders.put({ ...lender, playbook });
      res.json({ ok: true });
    }),
  );

  const ProposalBody = z.object({
    name: z.string(),
    segment: z.object({ region: z.string().optional(), sector: z.enum(['farming', 'trade', 'salaried', 'other']).optional() }).optional(),
    playbook: Playbook.partial(),
  });
  app.post(
    '/api/sandbox',
    manager,
    wrap(async (req, res) => {
      const proposal = ProposalBody.parse(req.body) as PolicyProposal;
      const lender = (await deps.store.lenders.get(lenderId)) as Lender;
      const cases = await agent.preview(lenderId);
      const signals = cases.map((c) => c.region).filter((r): r is NonNullable<typeof r> => !!r);
      res.json(await runSandbox({ lender, cases, signals, proposal, today: today(), seeds: 2 }));
    }),
  );
  app.post(
    '/api/policy/apply',
    manager,
    wrap(async (req, res) => {
      const proposal = ProposalBody.parse(req.body);
      const lender = (await deps.store.lenders.get(lenderId)) as Lender;
      const segment: Segment = { name: proposal.name, ...proposal.segment, playbook: proposal.playbook };
      await deps.store.lenders.put({ ...lender, segments: [...(lender.segments ?? []).filter((s) => s.name !== segment.name), segment] });
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/ask',
    manager,
    wrap(async (req, res) => {
      const { question } = z.object({ question: z.string().min(3).max(500) }).parse(req.body);
      res.json(await askManagerAgent({ store: deps.store, agent, lenderId, today: today() }, question, gemini));
    }),
  );

  /** Stress-test results from `npm run simulate`, committed with the code. */
  app.get('/api/sim-results', officer, (_req, res) => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'sim-results.json');
    if (!existsSync(file)) return res.json(null);
    res.json(JSON.parse(readFileSync(file, 'utf8')));
  });

  // --- Import ------------------------------------------------------------
  app.post(
    '/api/import/preview',
    manager,
    wrap(async (req, res) => {
      const csv = parseCsv(String(req.body.csv ?? ''));
      const { mapping, by } = await suggestMapping(csv.headers, csv.rows, gemini);
      const result = convert(lenderId, csv, mapping, uuid);
      res.json({ headers: csv.headers, sample: csv.rows.slice(0, 5), mapping, mappedBy: by, readable: result.loans.length, problems: result.problems });
    }),
  );
  app.post(
    '/api/import/commit',
    manager,
    wrap(async (req, res) => {
      const csv = parseCsv(String(req.body.csv ?? ''));
      const result = convert(lenderId, csv, req.body.mapping as Mapping, uuid);
      for (const b of result.borrowers) await deps.store.borrowers.put(b);
      for (const l of result.loans) await deps.store.loans.put(l);
      res.json({ imported: result.loans.length, problems: result.problems });
    }),
  );

  // --- Demo helpers (used when a borrower is not on a real phone) ----------
  app.post(
    '/api/demo/reply',
    officer,
    wrap(async (req, res) => {
      const body = z.object({ borrowerId: z.string(), text: z.string().min(1) }).parse(req.body);
      res.json(await agent.handleReply(lenderId, body.borrowerId, body.text));
    }),
  );
  app.post(
    '/api/demo/receipt',
    officer,
    wrap(async (req, res) => {
      const body = z.object({ borrowerId: z.string(), mimeType: z.string(), base64: z.string() }).parse(req.body);
      res.json(await agent.handleReceipt(lenderId, body.borrowerId, { mimeType: body.mimeType, base64: body.base64 }));
    }),
  );
  app.post(
    '/api/demo/reset',
    manager,
    wrap(async (_req, res) => {
      if (config.STORE !== 'memory') return res.status(400).json({ error: 'reset only works with the memory store' });
      res.json({ ok: false, note: 'restart the server to reset the memory store' });
    }),
  );

  // --- Webhooks -----------------------------------------------------------
  app.post(
    '/webhooks/telegram',
    wrap(async (req, res) => {
      if (config.TELEGRAM_WEBHOOK_SECRET && req.header('x-telegram-bot-api-secret-token') !== config.TELEGRAM_WEBHOOK_SECRET) {
        return res.sendStatus(401);
      }
      res.sendStatus(200); // acknowledge first; Telegram retries slow webhooks
      const msg = req.body?.message;
      if (!msg?.chat?.id || !telegram) return;
      const chatId = String(msg.chat.id);
      const text: string | undefined = msg.text;
      const borrowers = await deps.store.borrowers.list(lenderId);

      if (text?.startsWith('/start')) {
        const borrowerId = text.split(' ')[1];
        const b = borrowers.find((x) => x.id === borrowerId);
        if (!b) {
          await telegram.send({ telegramChatId: chatId } as never, 'Hello! Please use the link your lender sent you to connect your loan.');
          return;
        }
        await deps.store.borrowers.put({ ...b, telegramChatId: chatId, preferredChannel: 'telegram' });
        await telegram.send({ ...b, telegramChatId: chatId }, `Hi ${b.name.split(' ')[0]}, you are connected to Demo Lender. We will send your payment reminders and links here. Reply STOP at any time to stop automated messages.`);
        return;
      }
      const b = borrowers.find((x) => x.telegramChatId === chatId);
      if (!b) return;
      if (Array.isArray(msg.photo) && msg.photo.length) {
        const largest = msg.photo[msg.photo.length - 1];
        const image = await telegram.downloadPhoto(largest.file_id);
        await agent.handleReceipt(lenderId, b.id, image);
      } else if (text) {
        await agent.handleReply(lenderId, b.id, text);
      }
    }),
  );

  const chapaRef = (req: Request) => String(req.body?.tx_ref ?? req.body?.trx_ref ?? req.query.trx_ref ?? req.query.tx_ref ?? '');
  app.post(
    '/webhooks/chapa',
    wrap(async (req, res) => {
      const raw = (req as Request & { rawBody?: string }).rawBody ?? '';
      const sig = req.header('chapa-signature') ?? req.header('x-chapa-signature');
      if (!validChapaSignature(raw, sig, config.CHAPA_WEBHOOK_SECRET)) return res.sendStatus(401);
      const ref = chapaRef(req);
      if (ref) await agent.handlePayment(lenderId, ref);
      res.sendStatus(200);
    }),
  );
  // Chapa also calls the callback URL with GET after checkout.
  app.get(
    '/webhooks/chapa',
    wrap(async (req, res) => {
      const ref = chapaRef(req);
      if (ref) await agent.handlePayment(lenderId, ref);
      res.sendStatus(200);
    }),
  );
  app.get('/paid', (_req, res) => res.type('html').send(page('Payment received', '<p>Thank you. Your payment is being confirmed and you will get a message shortly.</p>')));

  // Local checkout page, used when Chapa keys are not configured.
  app.get('/pay/:ref', (req, res) => {
    const amount = fake.amountFor(String(req.params.ref));
    if (amount === undefined) return res.status(404).type('html').send(page('Link not found', '<p>This payment link is not valid.</p>'));
    res.type('html').send(
      page(
        'Demo checkout',
        `<p>Amount: <strong>${(amount / 100).toLocaleString('en-US')} birr</strong></p><form method="post"><button>Pay (demo)</button></form><p class="note">This page stands in for the payment gateway in local runs.</p>`,
      ),
    );
  });
  app.post(
    '/pay/:ref',
    wrap(async (req, res) => {
      const ref = String(req.params.ref);
      if (!fake.markPaid(ref)) return res.sendStatus(404);
      await agent.handlePayment(lenderId, ref);
      res.redirect('/paid');
    }),
  );

  // --- Dashboard (built React app) ----------------------------------------
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api|webhooks|pay).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err instanceof Error ? err.message : 'error';
    if (!res.headersSent) res.status(err instanceof z.ZodError ? 400 : 500).json({ error: message });
  });

  return { app, agent, deps };
}

function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 16px;color:#1f2937}button{background:#166534;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:16px}.note{color:#6b7280;font-size:14px}</style></head><body><h1>${title}</h1>${body}</body></html>`;
}

async function main() {
  const config = loadConfig();
  const built = buildDeps(config);
  const { app, deps } = createServer(config, built);

  if (config.SEED_DEMO === 'true' && (await deps.store.loans.list(config.LENDER_ID)).length === 0) {
    await seedDemo(deps.store, config.LENDER_ID, toIsoDate(new Date()));
    console.log('seeded demo lender');
  }
  if (built.telegram && config.PUBLIC_BASE_URL.startsWith('https://')) {
    const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${config.PUBLIC_BASE_URL}/webhooks/telegram`, secret_token: config.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message'] }),
    });
    console.log('telegram webhook', res.ok ? 'set' : `failed (${res.status})`);
  }
  app.listen(config.PORT, () => console.log(`collections officer listening on :${config.PORT}`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
