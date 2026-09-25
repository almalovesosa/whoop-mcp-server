import Database from 'better-sqlite3';
import type { Express, NextFunction, Request, Response } from 'express';
import type { WhoopDatabase } from './database.js';
import type { WhoopClient } from './whoop-client.js';
import type { WhoopSync } from './sync.js';

// Routes /api/* pour l'app iPhone Jarvis.
// Protégées par APP_TOKEN (variable Railway). La clé Anthropic reste côté serveur.

interface Deps {
	db: WhoopDatabase;
	client: WhoopClient;
	sync: WhoopSync;
	dbPath: string;
}

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

export function registerAppApi(app: Express, { db, client, sync, dbPath }: Deps): void {
	const token = process.env.APP_TOKEN ?? '';
	const store = new Database(dbPath);
	store.pragma('journal_mode = WAL');
	store.exec(`CREATE TABLE IF NOT EXISTS app_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		data TEXT NOT NULL,
		updated_at TEXT DEFAULT CURRENT_TIMESTAMP
	)`);

	const auth = (req: Request, res: Response, next: NextFunction): void => {
		if (!token) {
			res.status(503).json({ error: 'APP_TOKEN manquant sur le serveur' });
			return;
		}
		if (req.headers.authorization !== `Bearer ${token}`) {
			res.status(401).json({ error: 'Jeton invalide' });
			return;
		}
		next();
	};

	const refresh = async (): Promise<boolean> => {
		const tokens = db.getTokens();
		if (!tokens) return false;
		client.setTokens(tokens);
		try {
			await sync.smartSync();
		} catch (err) {
			process.stderr.write(`[app-api] sync failed: ${err instanceof Error ? err.message : 'unknown'}\n`);
		}
		return true;
	};

	const buildToday = () => {
		const recovery = db.getLatestRecovery();
		const sleep = db.getLatestSleep();
		const nap = db.getTodayNap();
		const cycle = db.getTodayCycle() ?? db.getLatestCycle();
		const trends = db.getRecoveryTrends(8).slice().reverse();
		const workouts = db.getTodayWorkouts().map(w => ({
			id: w.id,
			name: w.sport_name ?? 'Activité',
			startISO: w.start_time,
			endISO: w.end_time,
			strain: w.strain != null ? Math.round(w.strain * 10) / 10 : null,
			calories: w.kilojoule != null ? Math.round(w.kilojoule / 4.184) : null,
			avgHr: w.avg_hr,
			maxHr: w.max_hr,
			distanceMeter: w.distance_meter,
		}));

		const ends = [sleep?.end_time, nap?.end_time].filter((v): v is string => Boolean(v));
		const wakeTimeISO = ends.length ? ends.sort().at(-1)! : null;

		const sleepMs = sleep ? (sleep.total_in_bed_milli ?? 0) - (sleep.total_awake_milli ?? 0) : null;
		const sleepNeededMs = sleep
			? (sleep.sleep_needed_baseline_milli ?? 0) + (sleep.sleep_needed_debt_milli ?? 0) +
			  (sleep.sleep_needed_strain_milli ?? 0) + (sleep.sleep_needed_nap_milli ?? 0)
			: null;

		return {
			recovery: recovery?.recovery_score ?? null,
			hrv: recovery?.hrv_rmssd != null ? Math.round(recovery.hrv_rmssd) : null,
			rhr: recovery?.resting_hr ?? null,
			spo2: recovery?.spo2 != null ? Math.round(recovery.spo2 * 10) / 10 : null,
			sleepHours: sleepMs != null ? Math.round((sleepMs / 3_600_000) * 100) / 100 : null,
			sleepPerformance: sleep?.sleep_performance ?? null,
			sleepNeededMin: sleepNeededMs ? Math.round(sleepNeededMs / 60_000) : null,
			strain: cycle?.strain != null ? Math.round(cycle.strain * 10) / 10 : null,
			calories: cycle?.kilojoule != null ? Math.round(cycle.kilojoule / 4.184) : null,
			wakeTimeISO,
			recoveryWeek: trends.map(t => t.recovery_score),
			hrvWeek: trends.map(t => Math.round(t.hrv)),
			workouts,
			sleep: sleep ? { startISO: sleep.start_time, endISO: sleep.end_time, performance: sleep.sleep_performance } : null,
			nap: nap ? { startISO: nap.start_time, endISO: nap.end_time, performance: nap.sleep_performance } : null,
			updatedAt: new Date().toISOString(),
		};
	};

	app.get('/api/today', auth, async (_req: Request, res: Response) => {
		const ok = await refresh();
		if (!ok) {
			res.status(409).json({ error: 'Whoop non connecté' });
			return;
		}
		res.json(buildToday());
	});

	app.get('/api/state', auth, (_req: Request, res: Response) => {
		const row = store.prepare('SELECT data, updated_at FROM app_state WHERE id = 1').get() as
			| { data: string; updated_at: string }
			| undefined;
		res.json(row ? { state: JSON.parse(row.data), updatedAt: row.updated_at } : { state: null });
	});

	app.put('/api/state', auth, (req: Request, res: Response) => {
		const state = req.body?.state;
		if (!state || typeof state !== 'object') {
			res.status(400).json({ error: 'state manquant' });
			return;
		}
		store
			.prepare(`INSERT INTO app_state (id, data, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)
				ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`)
			.run(JSON.stringify(state));
		res.json({ ok: true });
	});

	app.post('/api/chat', auth, async (req: Request, res: Response) => {
		const key = process.env.ANTHROPIC_API_KEY;
		if (!key) {
			res.status(503).json({ error: 'ANTHROPIC_API_KEY manquant sur le serveur' });
			return;
		}
		const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
		const context = req.body?.context ?? {};
		if (!messages.length) {
			res.status(400).json({ error: 'messages manquants' });
			return;
		}
		let whoop: unknown = null;
		if (await refresh()) whoop = buildToday();

		const system = `Tu es Jarvis, l'assistant personnel d'Almamy. Réponds en français, de façon brève, directe et élégante (3 à 6 phrases max, pas de listes sauf si nécessaire), comme dans une conversation SMS.
Tu as accès à ses données du jour. Pour les peptides, rappelle uniquement ce qui est inscrit dans son protocole (nom, dosage, horaire) : ne recommande jamais de nouveau dosage, produit ou combinaison, et suggère d'en parler à un médecin si la question dépasse son protocole.
WHOOP: ${JSON.stringify(whoop)}
PLANNING ET PROTOCOLE: ${JSON.stringify(context)}`;

		try {
			const r = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-api-key': key,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify({
					model: MODEL,
					max_tokens: 600,
					system,
					messages: messages.map((m: { role: string; content: string }) => ({
						role: m.role === 'assistant' ? 'assistant' : 'user',
						content: String(m.content ?? ''),
					})),
				}),
			});
			const data = (await r.json()) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
			if (!r.ok) {
				res.status(502).json({ error: data.error?.message ?? 'Erreur Anthropic' });
				return;
			}
			const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
			res.json({ text });
		} catch (err) {
			res.status(502).json({ error: err instanceof Error ? err.message : 'Erreur réseau' });
		}
	});
}
