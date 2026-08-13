/**
 * Nova Chrono — Standalone Web API Server
 * Queries MongoDB directly on every request (same DB the bot uses).
 * No in-memory cache — changes from the bot reflect immediately.
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  CONFIG, connectDb, col,
  getTier, getLevelInfo, checkCooldown, getCooldowns, buildDefaultUser,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── Load .env files (local dev) ────────────────────────────────── */
for (const envFile of [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]) {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const sep = t.indexOf('=');
      if (sep === -1) continue;
      const k = t.slice(0, sep).trim();
      const v = t.slice(sep + 1).trim().replace(/^["']|["']$/g, '');
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  }
}

/* ── Config ─────────────────────────────────────────────────────── */
const PORT           = Number(process.env.PORT || 3002);
const SESSION_SECRET = process.env.SESSION_SECRET || 'nova-chrono-default-secret-change-me';
const BOT_TOKEN      = process.env.BOT_TOKEN || '';
const BOT_USERNAME   = process.env.BOT_USERNAME || 'YOUR_BOT_USERNAME';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PUBLIC_DIR     = path.join(__dirname, 'public');

/* ── Pokémon helper (read-only external API — ok to cache) ──────── */
const POKE_CACHE = new Map();
const FEATURED_POKEMON = ['pikachu','charizard','mewtwo','gengar','eevee','snorlax','lucario','gardevoir','rayquaza','umbreon'];

async function fetchPokemon(nameOrId) {
  const key = String(nameOrId).toLowerCase().trim();
  if (POKE_CACHE.has(key)) return POKE_CACHE.get(key);
  try {
    const r = await fetch(`https://pokeapi.co/api/v2/pokemon/${key}`);
    if (!r.ok) return null;
    const d = await r.json();
    const result = {
      id:   d.id,
      name: d.name,
      displayName: d.name.charAt(0).toUpperCase() + d.name.slice(1),
      sprite: d.sprites?.other?.['official-artwork']?.front_default || d.sprites?.front_default,
      types:  d.types.map(t => t.type.name),
      stats:  Object.fromEntries(d.stats.map(s => [s.stat.name, s.base_stat])),
      catchPrice: 50000 + d.id * 1000,
    };
    POKE_CACHE.set(key, result);
    return result;
  } catch { return null; }
}

/* ── Token helpers ───────────────────────────────────────────────── */
function signToken(payload) {
  const data = JSON.stringify(payload);
  const b64  = Buffer.from(data).toString('base64url');
  const sig  = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyToken(token) {
  try {
    const [b64, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

/* ── Telegram initData validation ────────────────────────────────── */
function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    params.delete('hash');
    if (!hash) return null;
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computed  = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computed !== hash) return null;
    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch { return null; }
}

function getUserIdFromReq(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const payload = verifyToken(auth.slice(7));
    if (payload?.userId) return Number(payload.userId);
  } else if (auth.startsWith('tma ')) {
    const tgUser = validateInitData(auth.slice(4));
    if (tgUser?.id) return Number(tgUser.id);
  }
  const hdr = req.headers['x-user-id'];
  if (hdr) return Number(hdr);
  return null;
}

/* ── HTTP helpers ────────────────────────────────────────────────── */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
  };
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
  res.end(JSON.stringify(data));
}

function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target    = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!target.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const ext = path.extname(target).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
    '.json': 'application/json',
  };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', ...corsHeaders() });
  res.end(fs.readFileSync(target));
  return true;
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

/* ── User helpers ────────────────────────────────────────────────── */
function publicUser(u) {
  if (!u) return null;
  return {
    id:       u.id || Number(u._id),
    username: u.username,
    name:     u.name,
    bio:      u.bio,
    age:      u.age,
    profilePhoto: u.profilePhoto,
    linkedEmail:  u.linkedEmail,
    squad:    u.squad,
    squadId:  u.squadId,
    level:    u.level,
    xp:       u.xp,
    balance:  u.balance,
    bank:     u.bank,
    gems:     u.gems || 0,
    hp: u.hp, maxHp: u.maxHp,
    mana: u.mana, maxMana: u.maxMana,
    grimoire: u.grimoire,
    spirit:   u.spirit,
    demon:    u.demon,
    battleWins:   u.battleWins   || 0,
    battleLosses: u.battleLosses || 0,
    dailyStreak:  u.dailyStreak  || 0,
    afk:         u.afk || { isAfk: false, reason: '', timestamp: 0 },
    registeredAt: u.registeredAt,
    collectionCount: (u.collection || []).length,
    pokedexCount:    (u.pokedex    || []).length,
  };
}

async function getOrCreateUser(userId) {
  const idStr = String(userId);
  let user = await col.users().findOne({ _id: idStr });
  if (!user) user = await col.users().findOne({ id: Number(userId) }); // legacy compat
  if (!user) {
    user = buildDefaultUser(userId);
    await col.users().insertOne(user);
  }
  return user;
}

async function getAdminDoc() {
  return (await col.admins().findOne({ _id: 'singleton' })) || { ownerId: 0, admins: [] };
}

async function isAdmin(userId) {
  const doc = await getAdminDoc();
  const uid = Number(userId);
  return uid === Number(doc.ownerId) || (doc.admins || []).map(Number).includes(uid);
}

async function isOwner(userId) {
  const doc = await getAdminDoc();
  return Number(userId) === Number(doc.ownerId);
}

/* ── XP + level-up (direct MongoDB) ─────────────────────────────── */
async function addXp(userId, amount) {
  const user = await col.users().findOne({ _id: String(userId) });
  if (!user) return;
  const newXp   = Math.max(0, (user.xp || 0) + amount);
  let newLevel  = user.level || 1;
  if (amount > 0) {
    while (newLevel < 50) {
      const info = CONFIG.levels?.[newLevel - 1];
      if (info && newXp >= info.xp) newLevel++; else break;
    }
  }
  await col.users().updateOne({ _id: String(userId) }, { $set: { xp: newXp, level: newLevel } });
}

/* ── Normalise shoob card for frontend ───────────────────────────── */
function normalizeCard(c) {
  const idStr = c._id ? c._id.toString() : (c.card_id || '');
  return {
    ...c,
    _id:       idStr,
    card_id:   idStr,
    image_url: c.media_url || c.image_url || '',  // always expose image_url
    series:    c.series || c.anime || '',
  };
}

function commandResult(command, message, extra = {}) {
  return { command, message, timestamp: new Date().toISOString(), ...extra };
}

/* ═══════════════════════════════════════════════════════════════════
   ROUTER
═══════════════════════════════════════════════════════════════════ */
async function handleReq(req, res) {
  await connectDb(); // ensure connected (no-op if already connected)

  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const p      = url.pathname;
  const method = req.method;

  /* OPTIONS pre-flight */
  if (method === 'OPTIONS') { sendJSON(res, 200, {}); return; }

  /* Static files */
  if (method === 'GET' && !p.startsWith('/api/')) {
    if (serveStatic(p, res)) return;
    if (serveStatic('/index.html', res)) return;
    sendJSON(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  /* ── PUBLIC ─────────────────────────────────────────────────── */
  if (p === '/api/health' && method === 'GET') {
    sendJSON(res, 200, { ok: true, status: 'online', ts: new Date().toISOString() });
    return;
  }

  if (p === '/api/catalog' && method === 'GET') {
    sendJSON(res, 200, { ok: true, data: CONFIG.shop || [] });
    return;
  }

  if (p === '/api/config' && method === 'GET') {
    sendJSON(res, 200, { ok: true, data: {
      levels:       CONFIG.levels,
      welcomeBonus: CONFIG.welcomeBonus,
      dailyReward:  CONFIG.dailyReward,
      bonus:        CONFIG.bonus,
      gameSettings: CONFIG.gameSettings,
    }});
    return;
  }

  /* ── EMAIL LOGIN ─────────────────────────────────────────────── */
  if (p === '/api/auth/email' && method === 'POST') {
    const { email } = await parseBody(req);
    if (!email) { sendJSON(res, 400, { ok: false, error: 'Email required' }); return; }
    const q    = String(email).trim().toLowerCase();
    const user = await col.users().findOne({ linkedEmail: q });
    if (!user) {
      sendJSON(res, 401, { ok: false, error: 'No account linked to this email. Use /secure in the Telegram bot first.' });
      return;
    }
    const token = signToken({ userId: user.id || Number(user._id), exp: Date.now() + 30 * 24 * 60 * 60 * 1000 });
    sendJSON(res, 200, { ok: true, token, user: publicUser(user) });
    return;
  }

  /* ── AUTH GATE ───────────────────────────────────────────────── */
  const userId = getUserIdFromReq(req);
  if (!userId) { sendJSON(res, 401, { ok: false, error: 'Unauthorized — please log in' }); return; }

  // Always read fresh from MongoDB
  const user = await getOrCreateUser(userId);

  /* ── PROFILE ─────────────────────────────────────────────────── */
  if ((p === '/api/auth/me' || p === '/api/profile' || p === '/api/user') && method === 'GET') {
    sendJSON(res, 200, { ok: true, data: publicUser(user) }); return;
  }

  if (p === '/api/profile/name' && method === 'POST') {
    const { name } = await parseBody(req);
    if (!name || name.length > 30) { sendJSON(res, 400, { ok: false, error: 'Name must be 1–30 chars' }); return; }
    await col.users().updateOne({ _id: String(userId) }, { $set: { name } });
    sendJSON(res, 200, { ok: true, data: publicUser({ ...user, name }) }); return;
  }

  if (p === '/api/profile/bio' && method === 'POST') {
    const { bio } = await parseBody(req);
    if ((bio || '').length > 150) { sendJSON(res, 400, { ok: false, error: 'Bio max 150 chars' }); return; }
    await col.users().updateOne({ _id: String(userId) }, { $set: { bio: bio || '' } });
    sendJSON(res, 200, { ok: true, data: publicUser({ ...user, bio }) }); return;
  }

  if (p === '/api/profile/age' && method === 'POST') {
    const { age } = await parseBody(req);
    if (isNaN(age) || Number(age) < 1 || Number(age) > 1000) { sendJSON(res, 400, { ok: false, error: 'Invalid age' }); return; }
    await col.users().updateOne({ _id: String(userId) }, { $set: { age: Number(age) } });
    sendJSON(res, 200, { ok: true, data: publicUser({ ...user, age: Number(age) }) }); return;
  }

  if (p === '/api/profile/email' && method === 'POST') {
    const { email } = await parseBody(req);
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { sendJSON(res, 400, { ok: false, error: 'Invalid email' }); return; }
      const existing = await col.users().findOne({ linkedEmail: String(email).trim().toLowerCase() });
      if (existing && String(existing._id) !== String(userId)) { sendJSON(res, 400, { ok: false, error: 'Email already in use' }); return; }
    }
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    await col.users().updateOne({ _id: String(userId) }, { $set: { linkedEmail: cleanEmail } });
    sendJSON(res, 200, { ok: true, data: publicUser({ ...user, linkedEmail: cleanEmail }) }); return;
  }

  /* ── BALANCE / RANK ──────────────────────────────────────────── */
  if (p === '/api/balance' && method === 'GET') {
    sendJSON(res, 200, { ok: true, data: { balance: user.balance, bank: user.bank, gems: user.gems || 0 } }); return;
  }

  if (p === '/api/rank' && method === 'GET') {
    const allUsers = await col.users().find({}, { projection: { id: 1, level: 1, xp: 1, balance: 1, bank: 1 } }).toArray();
    allUsers.sort((a, b) => (b.level || 0) - (a.level || 0) || (b.xp || 0) - (a.xp || 0));
    const levelRank  = allUsers.findIndex(u => String(u._id) === String(userId)) + 1;
    allUsers.sort((a, b) => ((b.balance || 0) + (b.bank || 0)) - ((a.balance || 0) + (a.bank || 0)));
    const wealthRank = allUsers.findIndex(u => String(u._id) === String(userId)) + 1;
    sendJSON(res, 200, { ok: true, data: {
      rank: levelRank, wealthRank, total: allUsers.length,
      level: user.level, levelTitle: getLevelInfo(user.level)?.title || '',
    }}); return;
  }

  if (p === '/api/cooldowns' && method === 'GET') {
    sendJSON(res, 200, { ok: true, data: getCooldowns(user) }); return;
  }

  /* ── DAILY / TRAIN / BONUS ───────────────────────────────────── */
  if (p === '/api/daily' && method === 'POST') {
    const now = Date.now();
    const oneDay = 86400000, twoDays = 172800000;
    if (now - (user.lastDailyClaim || 0) < oneDay) { sendJSON(res, 400, { ok: false, error: 'Daily already claimed' }); return; }
    let streak = user.dailyStreak || 0;
    streak = (now - (user.lastDailyClaim || 0) < twoDays) ? streak + 1 : 1;
    const multiplier = 1 + (streak - 1) * 0.5;
    const payout = Math.floor((CONFIG.dailyReward || 5000) * multiplier);
    await col.users().updateOne({ _id: String(userId) }, {
      $inc: { balance: payout },
      $set: { lastDailyClaim: now, dailyStreak: streak },
    });
    await addXp(userId, 1);
    const fresh = await col.users().findOne({ _id: String(userId) });
    sendJSON(res, 200, { ok: true, data: { reward: payout, streak, multiplier, cooldowns: getCooldowns(fresh) } }); return;
  }

  if (p === '/api/train' && method === 'POST') {
    const now = Date.now();
    if (now - (user.lastTrainClaim || 0) < 86400000) { sendJSON(res, 400, { ok: false, error: 'Already trained today' }); return; }
    await col.users().updateOne({ _id: String(userId) }, { $set: { lastTrainClaim: now } });
    await addXp(userId, 5);
    const fresh = await col.users().findOne({ _id: String(userId) });
    sendJSON(res, 200, { ok: true, data: { xpGained: 5, cooldowns: getCooldowns(fresh) } }); return;
  }

  if (p === '/api/bonus' && method === 'POST') {
    const now = Date.now();
    const cd = CONFIG.bonus?.cooldownMs || 360000000;
    if (now - (user.lastBonusClaim || 0) < cd) { sendJSON(res, 400, { ok: false, error: 'Bonus on cooldown' }); return; }
    const payout = Math.floor(Math.random() * ((CONFIG.bonus?.maxReward || 3000) - (CONFIG.bonus?.minReward || 1000) + 1)) + (CONFIG.bonus?.minReward || 1000);
    await col.users().updateOne({ _id: String(userId) }, { $inc: { balance: payout }, $set: { lastBonusClaim: now } });
    await addXp(userId, 1);
    const fresh = await col.users().findOne({ _id: String(userId) });
    sendJSON(res, 200, { ok: true, data: { reward: payout, cooldowns: getCooldowns(fresh) } }); return;
  }

  /* ── AFK ─────────────────────────────────────────────────────── */
  if (p === '/api/afk' && method === 'POST') {
    const { reason } = await parseBody(req);
    const isAfk = !user.afk?.isAfk;
    await col.users().updateOne({ _id: String(userId) }, { $set: { afk: { isAfk, reason: reason || 'Away from keyboard', timestamp: Date.now() } } });
    sendJSON(res, 200, { ok: true, data: { afk: isAfk } }); return;
  }

  /* ── DEPOSIT / WITHDRAW ──────────────────────────────────────── */
  if (p === '/api/deposit' && method === 'POST') {
    const { amount } = await parseBody(req);
    const amt = amount === 'all' ? user.balance : Number(amount);
    if (isNaN(amt) || amt <= 0 || amt > user.balance) { sendJSON(res, 400, { ok: false, error: 'Invalid amount' }); return; }
    await col.users().updateOne({ _id: String(userId) }, { $inc: { balance: -amt, bank: amt } });
    const fresh = await col.users().findOne({ _id: String(userId) });
    sendJSON(res, 200, { ok: true, data: publicUser(fresh) }); return;
  }

  if (p === '/api/withdraw' && method === 'POST') {
    const { amount } = await parseBody(req);
    const amt = amount === 'all' ? user.bank : Number(amount);
    if (isNaN(amt) || amt <= 0 || amt > user.bank) { sendJSON(res, 400, { ok: false, error: 'Invalid amount' }); return; }
    await col.users().updateOne({ _id: String(userId) }, { $inc: { balance: amt, bank: -amt } });
    const fresh = await col.users().findOne({ _id: String(userId) });
    sendJSON(res, 200, { ok: true, data: publicUser(fresh) }); return;
  }

  /* ── TRANSFER / DONATE ───────────────────────────────────────── */
  if ((p === '/api/transfer' || p === '/api/donate') && method === 'POST') {
    const { targetId, amount } = await parseBody(req);
    const amt    = Math.floor(Number(amount));
    const target = await col.users().findOne({ _id: String(targetId) });
    if (!target) { sendJSON(res, 400, { ok: false, error: 'Target user not found' }); return; }
    if (!Number.isFinite(amt) || amt <= 0 || amt > user.balance) { sendJSON(res, 400, { ok: false, error: 'Invalid amount' }); return; }
    await col.users().updateOne({ _id: String(userId) },   { $inc: { balance: -amt } });
    await col.users().updateOne({ _id: String(targetId) }, { $inc: { balance:  amt } });
    sendJSON(res, 200, { ok: true, data: commandResult(p.slice(5), `Sent ${amt.toLocaleString()} Yul to ${target.name}.`) }); return;
  }

  /* ── EXCHANGE (Yul → Gems) ───────────────────────────────────── */
  if (p === '/api/exchange' && method === 'POST') {
    const { gems }  = await parseBody(req);
    const gemsToBuy = Number(gems);
    if (isNaN(gemsToBuy) || gemsToBuy <= 0) { sendJSON(res, 400, { ok: false, error: 'Invalid gem amount' }); return; }
    const yulCost = gemsToBuy * 1000;
    if (user.balance < yulCost) { sendJSON(res, 400, { ok: false, error: 'Insufficient Yul' }); return; }
    await col.users().updateOne({ _id: String(userId) }, { $inc: { balance: -yulCost, gems: gemsToBuy } });
    const fresh = await col.users().findOne({ _id: String(userId) });
    sendJSON(res, 200, { ok: true, data: publicUser(fresh) }); return;
  }

  /* ── SHOP: BUY ───────────────────────────────────────────────── */
  if (p === '/api/purchase' && method === 'POST') {
    const { itemId, quantity } = await parseBody(req);
    const item = CONFIG.shop?.find(i => i.id === Number(itemId));
    if (!item) { sendJSON(res, 400, { ok: false, error: 'Item not found' }); return; }
    const qty    = Math.max(1, Number(quantity) || 1);
    const isPerk = item.category === 'perks';
    const totalYul  = item.price * qty;
    const totalGems = Math.ceil(item.price / 1000) * qty;
    if (isPerk) {
      if ((user.gems || 0) < totalGems) { sendJSON(res, 400, { ok: false, error: 'Insufficient Gems' }); return; }
    } else {
      if (user.balance < totalYul) { sendJSON(res, 400, { ok: false, error: 'Insufficient Yul' }); return; }
    }
    if (item.subcategory === 'spirit' && user.demon) { sendJSON(res, 400, { ok: false, error: 'Cannot have Spirit and Demon' }); return; }
    if (item.subcategory === 'demon'  && user.spirit) { sendJSON(res, 400, { ok: false, error: 'Cannot have Spirit and Demon' }); return; }

    const $inc = { [`inventory.${itemId}`]: qty };
    const $set = {};
    if (isPerk) $inc.gems = -totalGems; else $inc.balance = -totalYul;
    if (item.subcategory === 'grimoire') $set.grimoire = item.id;
    if (item.subcategory === 'spirit')   $set.spirit   = item.id;
    if (item.subcategory === 'demon')    $set.demon    = item.id;
    await col.users().updateOne({ _id: String(userId) }, { $inc, $set });

    const fresh = await col.users().findOne({ _id: String(userId) });
    sendJSON(res, 200, { ok: true, data: publicUser(fresh) }); return;
  }

  /* ── SHOP: SELL ──────────────────────────────────────────────── */
  if (p === '/api/sell' && method === 'POST') {
    const { itemId, quantity } = await parseBody(req);
    const item = CONFIG.shop?.find(i => i.id === Number(itemId));
    if (!item) { sendJSON(res, 400, { ok: false, error: 'Item not found' }); return; }
    const qty    = Math.max(1, Number(quantity) || 1);
    const owned  = user.inventory?.[String(itemId)] || 0;
    if (owned < qty) { sendJSON(res, 400, { ok: false, error: 'Not enough owned' }); return; }
    const refund = Math.floor(item.price * 0.75) * qty;
    const newQty = owned - qty;
    const update = newQty <= 0
      ? { $inc: { balance: refund }, $unset: { [`inventory.${itemId}`]: '' } }
      : { $inc: { balance: refund, [`inventory.${itemId}`]: -qty } };
    await col.users().updateOne({ _id: String(userId) }, update);
    sendJSON(res, 200, { ok: true, data: { refund, balance: (user.balance || 0) + refund } }); return;
  }

  /* ── INVENTORY ───────────────────────────────────────────────── */
  if (p === '/api/inventory' && method === 'GET') {
    const inv   = user.inventory || {};
    const items = Object.entries(inv)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => {
        const item = CONFIG.shop?.find(i => i.id === Number(id));
        return { itemId: Number(id), name: item?.name || id, emoji: item?.emoji || '', quantity: qty, category: item?.category || '' };
      });
    sendJSON(res, 200, { ok: true, data: items }); return;
  }

  /* ── USER'S OWNED CARD COLLECTION ───────────────────────────── */
  if (p === '/api/collection' && method === 'GET') {
    sendJSON(res, 200, { ok: true, data: (user.collection || []).map(c => normalizeCard(c)) }); return;
  }

  /* ── BROWSE ALL CARDS (shoob DB) ─────────────────────────────── */
  if ((p === '/api/cards' || p === '/api/cards/search') && method === 'GET') {
    const q    = (url.searchParams.get('q') || '').trim();
    const tier = (url.searchParams.get('tier') || '').toUpperCase().trim();
    const filter = {};
    if (q)    filter.$or = [{ name: { $regex: q, $options: 'i' } }, { series: { $regex: q, $options: 'i' } }];
    if (tier) filter.tier = tier;
    // Only image cards (skip videos so cards always have a thumbnail)
    filter.media_type = 'image';
    const cards = await col.cards().find(filter).limit(120).toArray();
    sendJSON(res, 200, { ok: true, data: cards.map(normalizeCard) }); return;
  }

  /* ── POKÉDEX ─────────────────────────────────────────────────── */
  if (p === '/api/pokedex' && method === 'GET') {
    const pokedex    = user.pokedex    || [];
    const pokedexMap = user.pokedexMap || {};
    sendJSON(res, 200, { ok: true, data: pokedex.map(name => ({ name, count: pokedexMap[name] || 1 })) }); return;
  }

  if (p === '/api/pokemon' && method === 'GET') {
    const q  = url.searchParams.get('q') || FEATURED_POKEMON[Math.floor(Math.random() * FEATURED_POKEMON.length)];
    const pk = await fetchPokemon(q);
    sendJSON(res, pk ? 200 : 404, pk ? { ok: true, data: pk } : { ok: false, error: 'Pokémon not found' }); return;
  }

  if (p === '/api/pokemon/catch' && method === 'POST') {
    const { name } = await parseBody(req);
    const pk = await fetchPokemon(name || FEATURED_POKEMON[Math.floor(Math.random() * FEATURED_POKEMON.length)]);
    if (!pk) { sendJSON(res, 400, { ok: false, error: 'Pokémon not found' }); return; }
    if (user.balance < pk.catchPrice) { sendJSON(res, 400, { ok: false, error: 'Insufficient Yul' }); return; }
    await col.users().updateOne({ _id: String(userId) }, {
      $inc: { balance: -pk.catchPrice, [`pokedexMap.${pk.name}`]: 1 },
      $addToSet: { pokedex: pk.name },
    });
    sendJSON(res, 200, { ok: true, data: commandResult('catch', `Caught ${pk.displayName}!`, { pokemon: pk }) }); return;
  }

  /* ── LEADERBOARDS ────────────────────────────────────────────── */
  if (p === '/api/leaderboard' && method === 'GET') {
    const users = await col.users()
      .find({}, { projection: { id: 1, name: 1, username: 1, level: 1, xp: 1 } })
      .sort({ level: -1, xp: -1 }).limit(50).toArray();
    sendJSON(res, 200, { ok: true, data: users.map((u, i) => ({
      rank: i + 1, id: u.id || Number(u._id), name: u.name, username: u.username, level: u.level, xp: u.xp,
    })) }); return;
  }

  if (p === '/api/richest' && method === 'GET') {
    const users = await col.users()
      .find({}, { projection: { id: 1, name: 1, username: 1, balance: 1, bank: 1 } })
      .toArray();
    users.sort((a, b) => ((b.balance || 0) + (b.bank || 0)) - ((a.balance || 0) + (a.bank || 0)));
    sendJSON(res, 200, { ok: true, data: users.slice(0, 50).map((u, i) => ({
      rank: i + 1, id: u.id || Number(u._id), name: u.name, username: u.username,
      wealth: (u.balance || 0) + (u.bank || 0), balance: u.balance || 0, bank: u.bank || 0,
    })) }); return;
  }

  /* ── ACTIVITY ────────────────────────────────────────────────── */
  if (p === '/api/activity' && method === 'GET') {
    const recent = await col.users()
      .find({}, { projection: { name: 1, registeredAt: 1 } })
      .sort({ registeredAt: -1 }).limit(20).toArray();
    sendJSON(res, 200, { ok: true, data: recent.map((u, i) => ({
      id: i + 1, text: `${u.name} is active in Nova Chrono`,
      at: new Date(u.registeredAt || Date.now()).toISOString(),
    })) }); return;
  }

  /* ── SQUAD ───────────────────────────────────────────────────── */
  if (p === '/api/squad' && method === 'GET') {
    if (!user.squadId) { sendJSON(res, 200, { ok: true, data: null }); return; }
    const squad = await col.squads().findOne({ _id: String(user.squadId) });
    if (!squad) { sendJSON(res, 200, { ok: true, data: null }); return; }
    const memberIds  = (squad.members || []).map(String);
    const memberDocs = await col.users().find({ _id: { $in: memberIds } }, { projection: { id: 1, name: 1 } }).toArray();
    const members    = memberDocs.map(m => ({
      id:   m.id || Number(m._id),
      name: m.name,
      role: String(m._id) === String(squad.captain)   ? 'captain'
          : String(m._id) === String(squad.assistant) ? 'assistant' : 'member',
    }));
    sendJSON(res, 200, { ok: true, data: { ...squad, _id: String(squad._id), members } }); return;
  }

  if (p === '/api/squad/create' && method === 'POST') {
    const { name } = await parseBody(req);
    if (!name) { sendJSON(res, 400, { ok: false, error: 'Name required' }); return; }
    if (user.squadId) { sendJSON(res, 400, { ok: false, error: 'Already in a squad' }); return; }
    const squadId = 'SQ' + Date.now().toString(36).toUpperCase();
    const squad   = { _id: squadId, id: squadId, name, captain: String(userId), assistant: null, members: [String(userId)], createdAt: Date.now() };
    await col.squads().insertOne(squad);
    await col.users().updateOne({ _id: String(userId) }, { $set: { squadId, squad: name } });
    sendJSON(res, 200, { ok: true, data: squad }); return;
  }

  if (p === '/api/squad/join' && method === 'POST') {
    const { squadId } = await parseBody(req);
    const squad = await col.squads().findOne({ _id: String(squadId) });
    if (!squad)       { sendJSON(res, 400, { ok: false, error: 'Squad not found' }); return; }
    if (user.squadId) { sendJSON(res, 400, { ok: false, error: 'Already in a squad' }); return; }
    await col.squads().updateOne({ _id: String(squadId) }, { $addToSet: { members: String(userId) } });
    await col.users().updateOne({ _id: String(userId) }, { $set: { squadId: squad._id, squad: squad.name } });
    sendJSON(res, 200, { ok: true, data: { ...squad, _id: String(squad._id) } }); return;
  }

  if (p === '/api/squad/leave' && method === 'POST') {
    if (!user.squadId) { sendJSON(res, 400, { ok: false, error: 'Not in a squad' }); return; }
    const squad = await col.squads().findOne({ _id: String(user.squadId) });
    if (squad?.captain === String(userId)) { sendJSON(res, 400, { ok: false, error: 'Captain must disband' }); return; }
    await col.squads().updateOne({ _id: String(user.squadId) }, { $pull: { members: String(userId) } });
    await col.users().updateOne({ _id: String(userId) }, { $set: { squadId: null, squad: 'No squad' } });
    sendJSON(res, 200, { ok: true, data: null }); return;
  }

  if (p === '/api/squad/disband' && method === 'POST') {
    if (!user.squadId) { sendJSON(res, 400, { ok: false, error: 'Not in a squad' }); return; }
    const squad = await col.squads().findOne({ _id: String(user.squadId) });
    if (squad?.captain !== String(userId)) { sendJSON(res, 400, { ok: false, error: 'Only captain can disband' }); return; }
    const memberIds = (squad.members || []).map(String);
    await col.users().updateMany({ _id: { $in: memberIds } }, { $set: { squadId: null, squad: 'No squad' } });
    await col.squads().deleteOne({ _id: String(user.squadId) });
    sendJSON(res, 200, { ok: true, data: null }); return;
  }

  /* ── WORK ────────────────────────────────────────────────────── */
  if (p === '/api/work' && method === 'POST') {
    const { job } = await parseBody(req);
    const valid   = ['fish','mine','dig','explore','crime'];
    const cmd     = String(job || '').toLowerCase();
    if (!valid.includes(cmd)) { sendJSON(res, 400, { ok: false, error: 'Invalid job' }); return; }
    const cd = checkCooldown(user, cmd);
    if (cd.active) { sendJSON(res, 400, { ok: false, error: `${cmd} is on cooldown`, data: { remainingMs: cd.remainingMs } }); return; }
    const rewardCfg  = CONFIG.rewards?.[cmd] || { min: 100, max: 1000 };
    const tier       = getTier(user.level || 1);
    const successRate = CONFIG.gameSettings?.successRates?.[tier] || 65;
    const success    = Math.random() * 100 < successRate;
    const reward     = success ? Math.floor(Math.random() * (rewardCfg.max - rewardCfg.min + 1)) + rewardCfg.min : 0;
    const now        = Date.now();
    const $inc = { [`cooldowns.${cmd}`]: 0 }; // placeholder, we use $set for cooldown
    const upd  = { $set: { [`cooldowns.${cmd}`]: now }, $inc: {} };
    if (success) upd.$inc.balance = reward;
    await col.users().updateOne({ _id: String(userId) }, upd);
    await addXp(userId, success ? 3 : -2);
    const fresh = await col.users().findOne({ _id: String(userId) });
    sendJSON(res, 200, { ok: true, data: commandResult(cmd,
      success ? `Success! Earned ${reward.toLocaleString()} Yul.` : 'Mission failed. You lost 2 XP.',
      { success, reward, user: publicUser(fresh), cooldowns: getCooldowns(fresh) }
    )}); return;
  }

  /* ── GAMES ───────────────────────────────────────────────────── */
  if (p === '/api/games/play' && method === 'POST') {
    const body   = await parseBody(req);
    const game   = String(body.game || '').toLowerCase();
    const amount = Math.floor(Number(body.bet));
    if (!Number.isFinite(amount) || amount <= 0) { sendJSON(res, 400, { ok: false, error: 'Bet must be a positive number' }); return; }
    if (user.balance < amount) { sendJSON(res, 400, { ok: false, error: 'Insufficient Yul' }); return; }
    const cd = checkCooldown(user, game);
    if (cd.active) { sendJSON(res, 400, { ok: false, error: `${game} is on cooldown`, data: { remainingMs: cd.remainingMs } }); return; }

    let win = false, detail = {}, multiplier = 2;
    if      (game === 'dice')   { const roll = Math.ceil(Math.random() * 6); win = roll === Number(body.prediction); detail = { roll, prediction: Number(body.prediction) }; }
    else if (game === 'coin')   { const flip = Math.random() < 0.5 ? 'heads' : 'tails'; win = flip === body.choice; detail = { flip, choice: body.choice }; }
    else if (game === 'slots')  { multiplier = 4; const icons = ['🍒','💎','⭐','🔮']; const reels = [0,1,2].map(() => icons[Math.floor(Math.random()*icons.length)]); win = new Set(reels).size === 1; detail = { reels }; }
    else if (game === 'basket') { const score = Math.random(); win = score >= 0.45; detail = { score: Math.round(score * 100) }; }
    else { sendJSON(res, 400, { ok: false, error: 'Unknown game' }); return; }

    const payout = win ? Math.floor(amount * multiplier) : 0;
    const now    = Date.now();
    await col.users().updateOne({ _id: String(userId) }, {
      $inc: { balance: -amount + payout },
      $set: { [`cooldowns.${game}`]: now },
    });
    await addXp(userId, win ? 3 : -2);
    const fresh = await col.users().findOne({ _id: String(userId) });
    sendJSON(res, 200, { ok: true, data: commandResult(game,
      win ? `You won ${payout.toLocaleString()} Yul` : `You lost ${amount.toLocaleString()} Yul`,
      { bet: amount, payout, win, detail, user: publicUser(fresh), cooldowns: getCooldowns(fresh) }
    )}); return;
  }

  /* ── BATTLE ──────────────────────────────────────────────────── */
  if (p === '/api/battle' && method === 'POST') {
    const { targetId } = await parseBody(req);
    const target = await col.users().findOne({ _id: String(targetId) });
    if (!target) { sendJSON(res, 400, { ok: false, error: 'Target user not found' }); return; }
    const win    = (user.level + Math.random() * 10) >= (target.level + Math.random() * 10);
    const reward = win ? Math.min(2500, target.balance || 0) : 0;
    if (win && reward) {
      await col.users().updateOne({ _id: String(targetId) }, { $inc: { balance: -reward } });
      await col.users().updateOne({ _id: String(userId) },   { $inc: { balance: reward, battleWins: 1 } });
    } else {
      await col.users().updateOne({ _id: String(userId) }, { $inc: { battleLosses: 1 } });
    }
    sendJSON(res, 200, { ok: true, data: commandResult('battle',
      win ? `Victory over ${target.name}!` : `Defeated by ${target.name}.`,
      { win, reward }
    )}); return;
  }

  /* ── META ────────────────────────────────────────────────────── */
  if (p === '/api/meta' && method === 'GET') {
    const adminDoc = await getAdminDoc();
    sendJSON(res, 200, { ok: true, data: { botUsername: BOT_USERNAME, ownerId: adminDoc.ownerId, admins: adminDoc.admins } }); return;
  }

  /* ── ADMIN ───────────────────────────────────────────────────── */
  const adminCheck = await isAdmin(userId);
  const ownerCheck = await isOwner(userId);

  if (p === '/api/admin/stats' && method === 'GET') {
    if (!adminCheck) { sendJSON(res, 403, { ok: false, error: 'Admin only' }); return; }
    const totalUsers  = await col.users().countDocuments();
    const squadCount  = await col.squads().countDocuments();
    const agg = await col.users().aggregate([{ $group: { _id: null,
      totalBalance: { $sum: '$balance' },
      totalBank:    { $sum: '$bank' },
      totalGems:    { $sum: '$gems' },
    }}]).toArray();
    const s = agg[0] || { totalBalance: 0, totalBank: 0, totalGems: 0 };
    sendJSON(res, 200, { ok: true, data: { totalUsers, totalBalance: s.totalBalance, totalBank: s.totalBank, totalGems: s.totalGems, squadCount } }); return;
  }

  if (p === '/api/admin/addbal' && method === 'POST') {
    if (!adminCheck) { sendJSON(res, 403, { ok: false, error: 'Admin only' }); return; }
    const { targetId, amount } = await parseBody(req);
    const r = await col.users().updateOne({ _id: String(targetId) }, { $inc: { balance: Number(amount) } });
    if (!r.matchedCount) { sendJSON(res, 400, { ok: false, error: 'User not found' }); return; }
    sendJSON(res, 200, { ok: true }); return;
  }

  if (p === '/api/admin/addxp' && method === 'POST') {
    if (!adminCheck) { sendJSON(res, 403, { ok: false, error: 'Admin only' }); return; }
    const { targetId, amount } = await parseBody(req);
    await addXp(targetId, Number(amount));
    sendJSON(res, 200, { ok: true }); return;
  }

  if (p === '/api/admin/resetuser' && method === 'POST') {
    if (!adminCheck) { sendJSON(res, 403, { ok: false, error: 'Admin only' }); return; }
    const { targetId } = await parseBody(req);
    await col.users().deleteOne({ _id: String(targetId) });
    sendJSON(res, 200, { ok: true }); return;
  }

  if (p === '/api/admin/broadcast' && method === 'POST') {
    if (!ownerCheck) { sendJSON(res, 403, { ok: false, error: 'Owner only' }); return; }
    const { message } = await parseBody(req);
    if (!message) { sendJSON(res, 400, { ok: false, error: 'Message required' }); return; }
    const totalUsers = await col.users().countDocuments();
    sendJSON(res, 200, { ok: true, data: { sent: totalUsers } }); return;
  }

  sendJSON(res, 404, { ok: false, error: 'Not found' });
}

/* ── Local dev server ────────────────────────────────────────────── */
async function main() {
  try { await connectDb(); } catch(e) { console.warn('⚠️  DB not connected at startup:', e.message); }
  const server = http.createServer((req, res) => {
    handleReq(req, res).catch(err => {
      console.error('Request error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
    });
  });
  server.listen(PORT, () => console.log(`🌐 Nova Chrono Web → http://localhost:${PORT}`));
}

/* ── Vercel Serverless export ────────────────────────────────────── */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Id');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  try {
    await handleReq(req, res);
  } catch(err) {
    console.error('Vercel handler error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message || 'Internal server error' }));
  }
}

// Start local server when not running under Vercel
if (!process.env.VERCEL) {
  main();
}
