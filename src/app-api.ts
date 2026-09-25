import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
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

	// Une journée passée : [from, to[ en ISO (bornes calculées par l'app dans son fuseau).
	const buildDay = (from: string, to: string) => {
		const back = new Date(new Date(from).getTime() - 36 * 3_600_000).toISOString();
		const sleeps = db.getSleepsByDateRange(back, to, true);
		const inDay = (iso: string) => iso >= from && iso < to;
		const sleep = sleeps.find(s => !s.is_nap && inDay(s.end_time)) ?? null;
		const nap = sleeps.find(s => s.is_nap && inDay(s.start_time)) ?? null;
		const recovery = db.getRecoveriesByDateRange(from, to)[0] ?? null;
		const cycle = db.getCyclesByDateRange(from, to)[0] ?? null;
		const workouts = db.getWorkoutsByDateRange(from, to).map(w => ({
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
		const sleepMs = sleep ? (sleep.total_in_bed_milli ?? 0) - (sleep.total_awake_milli ?? 0) : null;
		return {
			recovery: recovery?.recovery_score ?? null,
			hrv: recovery?.hrv_rmssd != null ? Math.round(recovery.hrv_rmssd) : null,
			rhr: recovery?.resting_hr ?? null,
			spo2: recovery?.spo2 != null ? Math.round(recovery.spo2 * 10) / 10 : null,
			sleepHours: sleepMs != null ? Math.round((sleepMs / 3_600_000) * 100) / 100 : null,
			sleepPerformance: sleep?.sleep_performance ?? null,
			sleepNeededMin: null,
			strain: cycle?.strain != null ? Math.round(cycle.strain * 10) / 10 : null,
			calories: cycle?.kilojoule != null ? Math.round(cycle.kilojoule / 4.184) : null,
			wakeTimeISO: null,
			recoveryWeek: [] as number[],
			hrvWeek: [] as number[],
			workouts,
			sleep: sleep ? { startISO: sleep.start_time, endISO: sleep.end_time, performance: sleep.sleep_performance } : null,
			nap: nap ? { startISO: nap.start_time, endISO: nap.end_time, performance: nap.sleep_performance } : null,
			updatedAt: new Date().toISOString(),
		};
	};

	const validRange = (req: Request): { from: string; to: string } | null => {
		const from = String(req.query.from ?? '');
		const to = String(req.query.to ?? '');
		if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return null;
		return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
	};

	app.get('/api/day', auth, (req: Request, res: Response) => {
		const range = validRange(req);
		if (!range) {
			res.status(400).json({ error: 'from/to invalides' });
			return;
		}
		res.json(buildDay(range.from, range.to));
	});

	app.get('/api/history', auth, (req: Request, res: Response) => {
		const range = validRange(req);
		if (!range) {
			res.status(400).json({ error: 'from/to invalides' });
			return;
		}
		const sleeps = db.getSleepsByDateRange(range.from, range.to, false);
		res.json({
			recoveries: db.getRecoveriesByDateRange(range.from, range.to).map(r => ({ at: r.created_at, score: r.recovery_score })),
			cycles: db.getCyclesByDateRange(range.from, range.to).map(c => ({ at: c.start_time, strain: c.strain != null ? Math.round(c.strain * 10) / 10 : null })),
			sleeps: sleeps.map(x => ({
				at: x.end_time,
				performance: x.sleep_performance,
				hours: Math.round((((x.total_in_bed_milli ?? 0) - (x.total_awake_milli ?? 0)) / 3_600_000) * 100) / 100,
			})),
		});
	});

	// Poids du profil Whoop (synchronisé depuis Apple Santé) + historique des changements observés.
	app.get('/api/weight', auth, async (_req: Request, res: Response) => {
		const tokens = db.getTokens();
		if (tokens) {
			client.setTokens(tokens);
			try {
				const b = await client.getBodyMeasurement();
				if (b?.weight_kilogram) db.recordWeight(b.weight_kilogram);
			} catch (err) {
				process.stderr.write(`[app-api] weight failed: ${err instanceof Error ? err.message : 'unknown'}\n`);
			}
		}
		const rows = store.prepare('SELECT weight_kilogram AS kg, first_observed_at AS at FROM weight_observations ORDER BY id ASC').all() as { kg: number; at: string }[];
		res.json({ current: rows.length ? rows[rows.length - 1].kg : null, history: rows });
	});

	// Glycémie FreeStyle Libre via LibreLinkUp (accès non officiel, lecture seule).
	// Le compte de suivi est saisi dans l'app, puis gardé chiffré (clé dérivée de APP_TOKEN) ; LLU_EMAIL / LLU_PASSWORD restent possibles en secours.
	store.exec('CREATE TABLE IF NOT EXISTS llu_creds (id INTEGER PRIMARY KEY CHECK (id = 1), blob TEXT NOT NULL)');
	const credKey = () => createHash('sha256').update('llu:' + (process.env.APP_TOKEN ?? '')).digest();
	const saveCreds = (c: { email: string; password: string }) => {
		const iv = randomBytes(12);
		const ci = createCipheriv('aes-256-gcm', credKey(), iv);
		const enc = Buffer.concat([ci.update(JSON.stringify(c), 'utf8'), ci.final()]);
		const blob = Buffer.concat([iv, ci.getAuthTag(), enc]).toString('base64');
		store.prepare('INSERT INTO llu_creds (id, blob) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET blob = excluded.blob').run(blob);
	};
	const loadCreds = (): { email: string; password: string } | null => {
		try {
			const row = store.prepare('SELECT blob FROM llu_creds WHERE id = 1').get() as { blob: string } | undefined;
			if (row) {
				const b = Buffer.from(row.blob, 'base64');
				const de = createDecipheriv('aes-256-gcm', credKey(), b.subarray(0, 12));
				de.setAuthTag(b.subarray(12, 28));
				return JSON.parse(Buffer.concat([de.update(b.subarray(28)), de.final()]).toString('utf8'));
			}
		} catch {}
		const email = process.env.LLU_EMAIL;
		const password = process.env.LLU_PASSWORD;
		return email && password ? { email, password } : null;
	};
	class NeedsLogin extends Error {}
	const llu: { base: string; token: string; accountId: string; patientId: string; cache?: { at: number; data: unknown } } = {
		base: 'https://api.libreview.io',
		token: '',
		accountId: '',
		patientId: '',
	};
	const lluReset = () => {
		llu.base = 'https://api.libreview.io';
		llu.token = '';
		llu.accountId = '';
		llu.patientId = '';
		llu.cache = undefined;
	};
	const lluHeaders = (auth?: boolean): Record<string, string> => ({
		'content-type': 'application/json',
		accept: 'application/json',
		product: 'llu.android',
		version: '4.16.0',
		'cache-control': 'no-cache',
		...(auth ? { authorization: `Bearer ${llu.token}`, 'account-id': llu.accountId } : {}),
	});
	const lluLogin = async (creds?: { email: string; password: string }) => {
		const c = creds ?? loadCreds();
		if (!c) throw new NeedsLogin('Compte LibreLinkUp non connecté');
		for (let i = 0; i < 2; i++) {
			const r = await fetch(`${llu.base}/llu/auth/login`, { method: 'POST', headers: lluHeaders(), body: JSON.stringify({ email: c.email, password: c.password }) });
			const j: any = await r.json().catch(() => null);
			if (j?.data?.redirect && j.data.region) {
				llu.base = `https://api-${j.data.region}.libreview.io`;
				continue;
			}
			if (j?.data?.step?.type) throw new Error(`LibreLinkUp demande une action dans son app (${j.data.step.type}) : ouvre-la et accepte les conditions`);
			const token = j?.data?.authTicket?.token;
			const uid = j?.data?.user?.id;
			if (!token || !uid) throw new Error(r.status === 429 ? 'Trop de tentatives, réessaie dans quelques minutes' : 'E-mail ou mot de passe LibreLinkUp incorrect');
			llu.token = token;
			llu.accountId = createHash('sha256').update(uid).digest('hex');
			return;
		}
		throw new Error('Région LibreLinkUp introuvable');
	};
	const lluGet = async (path: string) => {
		if (!llu.token) await lluLogin();
		let r = await fetch(llu.base + path, { headers: lluHeaders(true) });
		if (r.status === 401 || r.status === 403) {
			await lluLogin();
			r = await fetch(llu.base + path, { headers: lluHeaders(true) });
		}
		if (!r.ok) throw new Error(`LibreLinkUp ${r.status}`);
		return (await r.json()) as any;
	};
	// « 9/26/2026 2:34:12 PM » (UTC, FactoryTimestamp) → ISO
	const lluTime = (t?: string) => {
		const d = t ? new Date(t + ' UTC') : null;
		return d && !isNaN(d.getTime()) ? d.toISOString() : null;
	};
	app.post('/api/glucose/login', auth, async (req: Request, res: Response) => {
		const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
		const password = typeof req.body?.password === 'string' ? req.body.password : '';
		if (!email || !password) {
			res.status(400).json({ error: 'E-mail et mot de passe requis' });
			return;
		}
		try {
			lluReset();
			await lluLogin({ email, password });
			saveCreds({ email, password });
			res.json({ ok: true });
		} catch (err) {
			lluReset();
			res.status(400).json({ error: err instanceof Error ? err.message : 'Connexion impossible' });
		}
	});
	app.delete('/api/glucose/login', auth, (_req: Request, res: Response) => {
		store.prepare('DELETE FROM llu_creds').run();
		lluReset();
		res.json({ ok: true });
	});
	app.get('/api/glucose', auth, async (_req: Request, res: Response) => {
		try {
			if (llu.cache && Date.now() - llu.cache.at < 30_000) {
				res.json(llu.cache.data);
				return;
			}
			if (!llu.patientId) {
				const c = await lluGet('/llu/connections');
				llu.patientId = c?.data?.[0]?.patientId ?? '';
				if (!llu.patientId) throw new Error('Aucun partage LibreLinkUp : accepte l\'invitation dans l\'app LibreLinkUp');
			}
			const g = await lluGet(`/llu/connections/${llu.patientId}/graph`);
			const m = g?.data?.connection?.glucoseMeasurement;
			const point = (x: any) => ({ at: lluTime(x?.FactoryTimestamp), mgdl: Math.round(Number(x?.ValueInMgPerDl)) });
			const points = ((g?.data?.graphData ?? []) as any[]).map(point).concat(m ? [point(m)] : []).filter(p => p.at && Number.isFinite(p.mgdl) && p.mgdl > 0);
			points.sort((a, b) => (a.at! < b.at! ? -1 : 1));
			const uniq = points.filter((p, i) => i === 0 || p.at !== points[i - 1].at);
			const data = {
				current: m ? { ...point(m), trend: Number(m.TrendArrow) || null } : null,
				points: uniq,
				target: { low: g?.data?.connection?.targetLow ?? 70, high: g?.data?.connection?.targetHigh ?? 180 },
			};
			llu.cache = { at: Date.now(), data };
			res.json(data);
		} catch (err) {
			llu.patientId = '';
			if (err instanceof NeedsLogin) {
				res.status(412).json({ error: err.message });
				return;
			}
			res.status(502).json({ error: err instanceof Error ? err.message : 'LibreLinkUp indisponible' });
		}
	});

	app.get('/api/today', auth, async (_req: Request, res: Response) => {
		const ok = await refresh();
		if (!ok) {
			res.status(409).json({ error: 'Whoop non connecté' });
			return;
		}
		res.json(buildToday());
	});

	// Recherche web (Claude + outil web_search) des valeurs nutritionnelles d'un produit introuvable.
	app.post('/api/nutrition-lookup', auth, async (req: Request, res: Response) => {
		const key = process.env.ANTHROPIC_API_KEY;
		if (!key) {
			res.status(503).json({ error: 'ANTHROPIC_API_KEY manquant sur le serveur' });
			return;
		}
		const barcode = String(req.body?.barcode ?? '').replace(/\D/g, '');
		const name = String(req.body?.name ?? '').trim().slice(0, 120);
		const brand = String(req.body?.brand ?? '').trim().slice(0, 80);
		if (!barcode && !name) {
			res.status(400).json({ error: 'barcode ou name requis' });
			return;
		}
		const what = [barcode ? `code-barres EAN ${barcode}` : '', [brand, name].filter(Boolean).join(' ')].filter(Boolean).join(' - ');
		const prompt = `Trouve les valeurs nutritionnelles pour 100 g (ou 100 ml) de ce produit alimentaire : ${what}.
Cherche sur le web (site de la marque, Open Food Facts, sites de supermarchés comme Carrefour, Auchan, Leclerc, Intermarché, fiches produit). Recoupe si possible deux sources.
Réponds UNIQUEMENT avec un objet JSON sur une seule ligne : {"name":"...","brand":"...","kcal100":nombre,"carbs100":nombre,"fat100":nombre,"protein100":nombre,"source":"site ou url"}
carbs100 = glucides totaux (pas seulement les sucres). Nombres pour 100 g/ml, sans unité. Si tu ne trouves pas de valeurs fiables, réponds {"error":"introuvable"}. Ne devine jamais.`;
		try {
			const r = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
				body: JSON.stringify({
					model: MODEL,
					max_tokens: 1500,
					tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
					messages: [{ role: 'user', content: prompt }],
				}),
			});
			const data = (await r.json()) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
			if (!r.ok) {
				res.status(502).json({ error: data.error?.message ?? 'Erreur Anthropic' });
				return;
			}
			const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
			const raw = text.match(/\{[^{}]*\}/g)?.at(-1);
			const j = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
			const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
			const kcal100 = num(j?.kcal100);
			const carbs100 = num(j?.carbs100);
			const fat100 = num(j?.fat100);
			const protein100 = num(j?.protein100);
			if (!j || j.error || kcal100 == null || carbs100 == null || fat100 == null || protein100 == null) {
				res.status(404).json({ error: 'introuvable' });
				return;
			}
			res.json({ name: String(j.name ?? name ?? ''), brand: String(j.brand ?? brand ?? ''), kcal100, carbs100, fat100, protein100, source: String(j.source ?? 'web') });
		} catch (err) {
			res.status(502).json({ error: err instanceof Error ? err.message : 'Erreur réseau' });
		}
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
