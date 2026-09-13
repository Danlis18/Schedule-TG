import http from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const { Pool } = pg;
const PORT = Number(process.env.PORT || 3000);
const PUBLIC = join(process.cwd(), 'public');
const APP_SECRET = process.env.APP_SECRET || '';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const APP_URL = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const isProduction = process.env.NODE_ENV === 'production';
const WEBHOOK_SECRET = APP_SECRET ? createHmac('sha256', APP_SECRET).update('telegram-webhook').digest('hex') : '';

if (!DATABASE_URL) throw new Error('DATABASE_URL is required. Add a PostgreSQL service.');
if (isProduction && APP_SECRET.length < 32) throw new Error('APP_SECRET must contain at least 32 characters.');

const pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
const quotes = [
  ['Дисципліна — це турбота про майбутнього себе.', 'нагадування дня'],
  ['Великий результат складається з маленьких чесних дій.', 'крок за кроком'],
  ['Не чекай мотивації. Створи рух — і вона наздожене.', 'твій новий ритм'],
  ['Ти не мусиш бути ідеальним. Достатньо не зупинятися.', 'один день за раз'],
  ['Енергія з’являється там, де є ясна наступна дія.', 'фокус дня'],
  ['Порівнюй себе лише із собою вчорашнім.', 'правило прогресу'],
  ['Тиха послідовність голосніша за гучні обіцянки.', 'про дисципліну']
];

await pool.query(`
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, stars INTEGER NOT NULL DEFAULT 0 CHECK (stars >= 0), saved_money NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (saved_money >= 0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, emoji TEXT NOT NULL DEFAULT '☺', title TEXT NOT NULL, stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 999), category TEXT NOT NULL DEFAULT 'growth', task_date DATE NOT NULL, completed BOOLEAN NOT NULL DEFAULT FALSE, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_routine BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS routine_series_id TEXT;
CREATE TABLE IF NOT EXISTS incomes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, amount NUMERIC(14,2) NOT NULL CHECK (amount > 0), source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', income_date DATE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS rewards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, emoji TEXT NOT NULL DEFAULT '✦', title TEXT NOT NULL, star_price INTEGER NOT NULL CHECK (star_price > 0), money_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (money_price >= 0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
ALTER TABLE rewards ADD COLUMN IF NOT EXISTS image_data TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reward_id TEXT REFERENCES rewards(id) ON DELETE SET NULL, title TEXT NOT NULL, purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, task_date DESC);
CREATE INDEX IF NOT EXISTS idx_incomes_user_date ON incomes(user_id, income_date DESC);
CREATE INDEX IF NOT EXISTS idx_rewards_user ON rewards(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_user_date ON purchases(user_id, purchased_at DESC);
`);

const id = () => randomBytes(12).toString('hex');
const scrypt = promisify(scryptCallback);
const today = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const clean = (value, max) => String(value || '').trim().slice(0, max);
const asAmount = value => Number(Number(value).toFixed(2));
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
async function hashPassword(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${Buffer.from(await scrypt(password, salt, 64)).toString('hex')}`; }
async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }
async function parseBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 2_500_000) throw Object.assign(new Error('Payload too large'), { status: 413 }); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('Некоректні дані запиту.'), { status: 400 }); }
}
function createSession(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + 30 * 86400000 })).toString('base64url');
  const signature = createHmac('sha256', APP_SECRET || 'development-only-secret').update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function sessionId(req) {
  try {
    const [payload, signature] = String(req.headers.authorization || '').replace(/^Bearer /, '').split('.');
    if (!payload || !signature) return null;
    const expected = createHmac('sha256', APP_SECRET || 'development-only-secret').update(payload).digest('base64url');
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return session.exp > Date.now() ? session.userId : null;
  } catch { return null; }
}
const safeUser = row => ({ id: row.id, username: row.username, name: row.name, stars: Number(row.stars), savedMoney: Number(row.saved_money) });
async function requireUser(req) { const userId = sessionId(req); if (!userId) return null; return (await pool.query('SELECT * FROM users WHERE id=$1', [userId])).rows[0] || null; }
function validateTelegram(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData); const received = params.get('hash'); params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = createHmac('sha256', secret).update(check).digest('hex');
  if (!received || received.length !== expected.length || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}
async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method}: ${result.description || 'unknown error'}`);
  return result.result;
}
async function telegramWebhook(req, res) {
  const received = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (!WEBHOOK_SECRET || received.length !== WEBHOOK_SECRET.length || !timingSafeEqual(Buffer.from(received), Buffer.from(WEBHOOK_SECRET))) return json(res, 403, { ok: false });
  const update = await parseBody(req);
  const message = update.message;
  if (message?.chat?.id && /^\/start(?:@\w+)?(?:\s|$)/i.test(message.text || '')) {
    await telegram('sendMessage', {
      chat_id: message.chat.id,
      text: `Привіт, ${clean(message.from?.first_name, 40) || 'гравцю'}! ✦\n\nLevelUp Life перетворює твої щоденні справи на квести, зірки, прогрес і реальні нагороди. Натискай кнопку та починай свій день.`,
      reply_markup: { inline_keyboard: [[{ text: 'OPEN', web_app: { url: APP_URL } }]] }
    });
  }
  return json(res, 200, { ok: true });
}
async function configureTelegram() {
  if (!BOT_TOKEN || !APP_URL || !WEBHOOK_SECRET) { console.warn('Telegram webhook skipped: BOT_TOKEN, APP_URL or APP_SECRET is missing.'); return; }
  const webhookUrl = `${APP_URL.replace(/\/$/, '')}/api/telegram/webhook`;
  await telegram('setWebhook', { url: webhookUrl, secret_token: WEBHOOK_SECRET, allowed_updates: ['message'] });
  await telegram('setMyCommands', { commands: [{ command: 'start', description: 'Відкрити LevelUp Life' }] });
  await telegram('setChatMenuButton', { menu_button: { type: 'web_app', text: 'OPEN', web_app: { url: APP_URL } } });
  console.log(`Telegram webhook configured: ${webhookUrl}`);
}

const attempts = new Map();
function authAllowed(req) {
  const key = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  const current = attempts.get(key) || { count: 0, reset: Date.now() + 15 * 60_000 };
  if (Date.now() > current.reset) { current.count = 0; current.reset = Date.now() + 15 * 60_000; }
  current.count += 1; attempts.set(key, current); return current.count <= 25;
}
function dashboard(tasks, incomes) {
  const current = today(); const todays = tasks.filter(task => task.date === current); const start = new Date(); start.setDate(start.getDate() - 6);
  const week = Array.from({ length: 7 }, (_, index) => { const date = new Date(start); date.setDate(date.getDate() + index); const key = today(date); const list = tasks.filter(task => task.date === key); const done = list.filter(task => task.completed).length; return { date: key, done, total: list.length, percent: list.length ? Math.round(done / list.length * 100) : 0 }; });
  const total = week.reduce((sum, day) => sum + day.total, 0); const done = week.reduce((sum, day) => sum + day.done, 0);
  const completedDates = new Set(tasks.filter(task => task.completed).map(task => task.date)); let streak = 0; const cursor = new Date(); while (completedDates.has(today(cursor))) { streak += 1; cursor.setDate(cursor.getDate() - 1); }
  const month = current.slice(0, 7); const monthIncome = incomes.filter(item => item.date.startsWith(month)).reduce((sum, item) => sum + item.amount, 0);
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return { today: todays, week, productivity: total ? Math.round(done / total * 100) : 0, streak, monthIncome, quote: quotes[dayOfYear % quotes.length] };
}
async function bootstrap(user) {
  const [taskResult, incomeResult, rewardResult, purchaseResult] = await Promise.all([
    pool.query("SELECT id,emoji,title,stars,category,task_date::text AS date,completed,completed_at AS \"completedAt\",is_routine AS \"isRoutine\",routine_series_id AS \"routineSeriesId\" FROM tasks WHERE user_id=$1 ORDER BY task_date DESC,created_at DESC", [user.id]),
    pool.query("SELECT id,amount::float8 AS amount,source,note,income_date::text AS date FROM incomes WHERE user_id=$1 ORDER BY income_date DESC,created_at DESC", [user.id]),
    pool.query("SELECT id,emoji,title,star_price AS price,money_price::float8 AS money,image_data AS \"imageData\" FROM rewards WHERE user_id=$1 ORDER BY created_at DESC", [user.id]),
    pool.query("SELECT id,reward_id AS \"rewardId\",title,purchased_at::date::text AS date FROM purchases WHERE user_id=$1 ORDER BY purchased_at DESC", [user.id])
  ]);
  return { user: safeUser(user), dashboard: dashboard(taskResult.rows, incomeResult.rows), tasks: taskResult.rows, incomes: incomeResult.rows, rewards: rewardResult.rows, purchases: purchaseResult.rows };
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') { await pool.query('SELECT 1'); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/telegram/webhook') return telegramWebhook(req, res);
  if (url.pathname.startsWith('/api/auth/') && !authAllowed(req)) return json(res, 429, { error: 'Забагато спроб. Спробуйте через 15 хвилин.' });
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const data = await parseBody(req); const username = clean(data.username, 32).toLowerCase(); const password = String(data.password || '');
    if (!/^[a-z0-9_.-]{3,32}$/i.test(username) || username.startsWith('tg_') || password.length < 8) return json(res, 400, { error: 'Логін: 3–32 латинські символи. Пароль: від 8 символів.' });
    try { const user = (await pool.query('INSERT INTO users (id,username,password_hash,name) VALUES ($1,$2,$3,$4) RETURNING *', [id(), username, await hashPassword(password), clean(data.name, 40) || username])).rows[0]; return json(res, 201, { token: createSession(user.id), user: safeUser(user) }); }
    catch (error) { if (error.code === '23505') return json(res, 409, { error: 'Такий логін уже існує.' }); throw error; }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const data = await parseBody(req); const user = (await pool.query('SELECT * FROM users WHERE username=$1', [clean(data.username, 32).toLowerCase()])).rows[0];
    if (!user || !(await verifyPassword(data.password || '', user.password_hash))) return json(res, 401, { error: 'Неправильний логін або пароль.' });
    return json(res, 200, { token: createSession(user.id), user: safeUser(user) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/telegram') {
    const telegram = validateTelegram((await parseBody(req)).initData); if (!telegram) return json(res, 401, { error: 'Не вдалося підтвердити Telegram.' });
    const username = `tg_${telegram.id}`; const name = clean([telegram.first_name, telegram.last_name].filter(Boolean).join(' '), 40) || 'Гравець';
    const user = (await pool.query('INSERT INTO users (id,username,name) VALUES ($1,$2,$3) ON CONFLICT (username) DO UPDATE SET name=EXCLUDED.name RETURNING *', [id(), username, name])).rows[0];
    return json(res, 200, { token: createSession(user.id), user: safeUser(user) });
  }
  const user = await requireUser(req); if (!user) return json(res, 401, { error: 'Потрібно увійти.' });
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(res, 200, await bootstrap(user));
  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const data = await parseBody(req); const stars = Number(data.stars); const repeatDaily = data.repeatDaily === 'on' || data.repeatDaily === true || data.repeatDaily === 'true';
    if (!clean(data.title, 90) || !Number.isInteger(stars) || stars < 1 || stars > 999 || !validDate(data.date) || (repeatDaily && data.date < today())) return json(res, 400, { error: 'Перевірте назву, дату й нагороду.' });
    const values = [user.id, clean(data.emoji, 4) || '🎯', clean(data.title, 90), stars, ['growth','health','work','balance'].includes(data.category) ? data.category : 'growth', data.date];
    if (repeatDaily) {
      const seriesId = id();
      const result = await pool.query(`WITH dates AS (SELECT generate_series($6::date,make_date(EXTRACT(YEAR FROM $6::date)::int,12,31),INTERVAL '1 day')::date AS day)
        INSERT INTO tasks (id,user_id,emoji,title,stars,category,task_date,is_routine,routine_series_id)
        SELECT $7||'-'||to_char(day,'YYYYMMDD'),$1,$2,$3,$4,$5,day,TRUE,$7 FROM dates
        RETURNING id,emoji,title,stars,category,task_date::text AS date,completed,is_routine AS "isRoutine",routine_series_id AS "routineSeriesId"`, [...values, seriesId]);
      return json(res, 201, { ...result.rows[0], createdCount: result.rowCount });
    }
    const task = (await pool.query("INSERT INTO tasks (id,user_id,emoji,title,stars,category,task_date,is_routine) VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE) RETURNING id,emoji,title,stars,category,task_date::text AS date,completed,is_routine AS \"isRoutine\"", [id(), ...values])).rows[0];
    return json(res, 201, { ...task, createdCount: 1 });
  }
  const toggle = url.pathname.match(/^\/api\/tasks\/([^/]+)\/toggle$/);
  if (req.method === 'PATCH' && toggle) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const task = (await client.query('SELECT * FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE', [toggle[1], user.id])).rows[0]; if (!task) { await client.query('ROLLBACK'); return json(res, 404, { error: 'Завдання не знайдено.' }); } if (String(task.task_date).slice(0,10) < today()) { await client.query('ROLLBACK'); return json(res, 400, { error: 'Цей день уже завершено — завдання неактивне.' }); } const completed = !task.completed; const updated = (await client.query("UPDATE tasks SET completed=$1,completed_at=CASE WHEN $1 THEN NOW() ELSE NULL END WHERE id=$2 RETURNING id,emoji,title,stars,category,task_date::text AS date,completed,is_routine AS \"isRoutine\"", [completed, task.id])).rows[0]; await client.query('UPDATE users SET stars=GREATEST(0,stars+$1) WHERE id=$2', [completed ? task.stars : -task.stars, user.id]); await client.query('COMMIT'); return json(res, 200, { task: updated }); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  const removeTask = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'DELETE' && removeTask) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const task = (await client.query('DELETE FROM tasks WHERE id=$1 AND user_id=$2 RETURNING completed,stars', [removeTask[1], user.id])).rows[0]; if (!task) { await client.query('ROLLBACK'); return json(res, 404, { error: 'Завдання не знайдено.' }); } if (task.completed) await client.query('UPDATE users SET stars=GREATEST(0,stars-$1) WHERE id=$2', [task.stars, user.id]); await client.query('COMMIT'); return json(res, 200, { ok: true }); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  if (req.method === 'POST' && url.pathname === '/api/incomes') {
    const data = await parseBody(req); const value = asAmount(data.amount); const savings = asAmount(data.toSavings || 0);
    if (!Number.isFinite(value) || !Number.isFinite(savings) || !(value > 0) || savings < 0 || !clean(data.source, 70) || !validDate(data.date)) return json(res, 400, { error: 'Перевірте суму, джерело та дату.' });
    const client = await pool.connect();
    try { await client.query('BEGIN'); const income = (await client.query("INSERT INTO incomes (id,user_id,amount,source,note,income_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,amount::float8 AS amount,source,note,income_date::text AS date", [id(), user.id, value, clean(data.source, 70), clean(data.note, 120), data.date])).rows[0]; if (savings) await client.query('UPDATE users SET saved_money=saved_money+$1 WHERE id=$2', [savings, user.id]); await client.query('COMMIT'); return json(res, 201, income); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  if (req.method === 'POST' && url.pathname === '/api/savings') {
    const value = asAmount((await parseBody(req)).amount); if (!Number.isFinite(value)) return json(res, 400, { error: 'Некоректна сума.' });
    const updated = (await pool.query('UPDATE users SET saved_money=GREATEST(0,saved_money+$1) WHERE id=$2 RETURNING *', [value, user.id])).rows[0]; return json(res, 200, { user: safeUser(updated) });
  }
  if (req.method === 'POST' && url.pathname === '/api/rewards') {
    const data = await parseBody(req); const price = Number(data.price); const money = asAmount(data.money || 0); const imageData = String(data.imageData || '');
    const validImage = !imageData || (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData) && imageData.length <= 2_000_000);
    if (!clean(data.title, 80) || !Number.isInteger(price) || price < 1 || price > 1_000_000 || !Number.isFinite(money) || money < 0 || !validImage) return json(res, 400, { error: 'Перевірте назву, вартість і фото бажання.' });
    const reward = (await pool.query("INSERT INTO rewards (id,user_id,emoji,title,star_price,money_price,image_data) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,emoji,title,star_price AS price,money_price::float8 AS money,image_data AS \"imageData\"", [id(), user.id, clean(data.emoji, 4) || '✦', clean(data.title, 80), price, money, imageData])).rows[0]; return json(res, 201, reward);
  }
  const buy = url.pathname.match(/^\/api\/rewards\/([^/]+)\/buy$/);
  if (req.method === 'POST' && buy) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const reward = (await client.query('SELECT * FROM rewards WHERE id=$1 AND user_id=$2 FOR UPDATE', [buy[1], user.id])).rows[0]; const lockedUser = (await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0]; if (!reward) { await client.query('ROLLBACK'); return json(res, 404, { error: 'Нагороду не знайдено.' }); } if (Number(lockedUser.stars) < reward.star_price || Number(lockedUser.saved_money) < Number(reward.money_price)) { await client.query('ROLLBACK'); return json(res, 400, { error: 'Ще трохи — балансу поки недостатньо.' }); } await client.query('UPDATE users SET stars=stars-$1,saved_money=saved_money-$2 WHERE id=$3', [reward.star_price, reward.money_price, user.id]); await client.query('INSERT INTO purchases (id,user_id,reward_id,title) VALUES ($1,$2,$3,$4)', [id(), user.id, reward.id, reward.title]); await client.query('COMMIT'); return json(res, 200, { ok: true }); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  return json(res, 404, { error: 'Маршрут не знайдено.' });
}

const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.webmanifest':'application/manifest+json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.ico':'image/x-icon' };
const server = http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('x-frame-options', 'SAMEORIGIN'); res.setHeader('referrer-policy', 'strict-origin-when-cross-origin'); res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const file = normalize(join(PUBLIC, requested));
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
    await stat(file); const fresh = extname(file) === '.html' || url.pathname === '/sw.js'; res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': fresh ? 'no-cache' : 'public, max-age=3600' }); createReadStream(file).pipe(res);
  } catch (error) {
    if (error?.code === 'ENOENT') { res.writeHead(404); return res.end('Not found'); }
    console.error(error); return json(res, error.status || 500, { error: error.status ? error.message : 'Тимчасова помилка. Спробуйте ще раз.' });
  }
});
server.listen(PORT, () => { console.log(`LevelUp Life running on port ${PORT}`); configureTelegram().catch(error => console.error(error.message)); });
process.on('SIGTERM', async () => { server.close(); await pool.end(); process.exit(0); });
