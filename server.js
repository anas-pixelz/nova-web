/**
 * Nova Chrono — Standalone Web API Server
 * Connects directly to MongoDB or local storage by importing the shared database engine.
 * No Telegram dependency.
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Import the database and game logic from the bot source!
import { db, CONFIG, getTier, getLevelInfo, initMongoStorage } from '../src/database/localstorage.js';
import { getAllCards } from '../src/clover/characters.js';
import { fetchPokemonData, FEATURED_POKEMON } from '../src/clover/pokemon.js';

/* ── Env loading ──────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const sep = t.indexOf('=');
    if (sep === -1) continue;
    const k = t.slice(0, sep).trim();
    const v = t.slice(sep + 1).trim().replace(/^["']|["']$/g, '');
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}
// Also load parent .env
const parentEnv = path.join(__dirname, '..', '.env');
if (fs.existsSync(parentEnv)) {
  for (const line of fs.readFileSync(parentEnv, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const sep = t.indexOf('=');
    if (sep === -1) continue;
    const k = t.slice(0, sep).trim();
    const v = t.slice(sep + 1).trim().replace(/^["']|["']$/g, '');
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

/* ── Config ───────────────────────────────────────────────────── */
const PORT = Number(process.env.PORT || 3002);
const SESSION_SECRET = process.env.SESSION_SECRET || 'nova-chrono-default-secret-change-me';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const BOT_USERNAME = process.env.BOT_USERNAME || 'YOUR_BOT_USERNAME';
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ── Helpers ──────────────────────────────────────────────────── */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, name: u.name,
    bio: u.bio, age: u.age, profilePhoto: u.profilePhoto,
    linkedEmail: u.linkedEmail,
    squad: u.squad, squadId: u.squadId,
    level: u.level, xp: u.xp,
    balance: u.balance, bank: u.bank, gems: u.gems || 0,
    hp: u.hp, maxHp: u.maxHp, mana: u.mana, maxMana: u.maxMana,
    grimoire: u.grimoire, spirit: u.spirit, demon: u.demon,
    battleWins: u.battleWins || 0, battleLosses: u.battleLosses || 0,
    dailyStreak: u.dailyStreak || 0,
    afk: u.afk || { isAfk: false, reason: '', timestamp: 0 },
    registeredAt: u.registeredAt,
    collectionCount: (u.collection || []).length,
    pokedexCount: (u.pokedex || []).length,
  };
}

function getCooldowns(user) {
  const now = Date.now();
  const tier = getTier(user.level);
  const cdPeriod = CONFIG.gameSettings?.cooldowns?.[tier] || 300000;
  const cmds = ['dice','basket','coin','slots','penalty','dart','bowl','fish','explore','mine','dig','crime','rob'];
  const result = [];
  for (const cmd of cmds) {
    const lastRun = user.cooldowns?.[cmd] || 0;
    const period  = cmd === 'rob' ? 900000 : cdPeriod;
    const remaining = period - (now - lastRun);
    if (remaining > 0) result.push({ key: cmd, endsAt: new Date(now + remaining).toISOString() });
  }
  const oneDay = 86400000;
  const lastDaily = user.lastDailyClaim || 0;
  if (now - lastDaily < oneDay) result.push({ key: 'daily', endsAt: new Date(lastDaily + oneDay).toISOString() });
  const lastTrain = user.lastTrainClaim || 0;
  if (now - lastTrain < oneDay) result.push({ key: 'train', endsAt: new Date(lastTrain + oneDay).toISOString() });
  const bonusCd = CONFIG.bonus?.cooldownMs || 360000000;
  const lastBonus = user.lastBonusClaim || 0;
  if (now - lastBonus < bonusCd) result.push({ key: 'bonus', endsAt: new Date(lastBonus + bonusCd).toISOString() });
  return result;
}

function commandResult(command, message, data = {}) {
  return { command, message, timestamp: new Date().toISOString(), ...data };
}

/* ── Session tokens (HMAC-signed, no external dep) ─────────────── */
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

/* ── Telegram initData validation ─────────────────────────── */
const BOT_TOKEN = process.env.BOT_TOKEN || '';

function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    if (!hash) return null;

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) return null;

    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch {
    return null;
  }
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

/* ── HTTP helpers ─────────────────────────────────────────────── */
function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
  };
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...cors() });
  res.end(JSON.stringify(data));
}

function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = path.normalize(path.join(PUBLIC_DIR, requested));
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
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', ...cors() });
  res.end(fs.readFileSync(target));
  return true;
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

/* ── Work / Game handlers ──────────────────────────────────────── */
async function runWork(userId, command) {
  const user = db.getUser(userId);
  if (!user) return { status: 401, body: { ok: false, error: 'User not found' } };
  const cd = db.checkCooldown(user, command);
  if (cd.active) return { status: 400, body: { ok: false, error: `${command} is on cooldown`, data: { remainingMs: cd.remainingMs } } };
  
  const rewardCfg = CONFIG.rewards?.[command] || { min: 100, max: 1000 };
  const tier = getTier(user.level);
  const successRate = CONFIG.gameSettings?.successRates?.[tier] || 65;
  const success = Math.random() * 100 < successRate;
  const reward  = success ? Math.floor(Math.random() * (rewardCfg.max - rewardCfg.min + 1)) + rewardCfg.min : 0;
  
  db.setCooldown(userId, command);
  db.incrementDailyUsage(userId, command);
  
  if (success) {
    db.updateUser(userId, u => { u.balance = (u.balance || 0) + reward; });
  }
  db.addXp(userId, success ? 3 : -2);
  
  const fresh = db.getUser(userId);
  return { status: 200, body: { ok: true, data: commandResult(command, success ? `Success! Earned ${reward.toLocaleString()} Yul.` : 'Mission failed. You lost 2 XP.', { success, reward, user: publicUser(fresh), cooldowns: getCooldowns(fresh) }) } };
}

async function applyGame(userId, command, bet, win, multiplier, detail) {
  const user = db.getUser(userId);
  if (!user) return { status: 401, body: { ok: false, error: 'User not found' } };
  const amount = Math.floor(Number(bet));
  if (!Number.isFinite(amount) || amount <= 0) return { status: 400, body: { ok: false, error: 'Bet must be a positive number' } };
  if (user.balance < amount) return { status: 400, body: { ok: false, error: 'Insufficient Yul' } };
  
  const cd = db.checkCooldown(user, command);
  if (cd.active) return { status: 400, body: { ok: false, error: `${command} is on cooldown`, data: { remainingMs: cd.remainingMs } } };
  
  const payout = win ? Math.floor(amount * multiplier) : 0;
  db.updateUser(userId, u => {
    u.balance = u.balance - amount + payout;
  });
  db.setCooldown(userId, command);
  db.incrementDailyUsage(userId, command);
  db.addXp(userId, win ? 3 : -2);
  
  const fresh = db.getUser(userId);
  return { status: 200, body: { ok: true, data: commandResult(command, win ? `You won ${payout.toLocaleString()} Yul` : `You lost ${amount.toLocaleString()} Yul`, { bet: amount, payout, win, detail, user: publicUser(fresh), cooldowns: getCooldowns(fresh) }) } };
}

/* ── Router ───────────────────────────────────────────────────── */
async function handleReq(req, res) {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const p      = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return sendJSON(res, 200, {});

  // Serve static files
  if (method === 'GET' && !p.startsWith('/api/')) {
    if (serveStatic(p, res)) return;
    if (serveStatic('/index.html', res)) return;
    return sendJSON(res, 404, { ok: false, error: 'Not found' });
  }

  /* ── PUBLIC ENDPOINTS ─────────────────────────────────────────── */
  if (p === '/api/health' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, status: 'online', ts: new Date().toISOString() });
  }

  if (p === '/api/catalog' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, data: CONFIG.shop || [] });
  }

  if (p === '/api/config' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, data: { levels: CONFIG.levels, welcomeBonus: CONFIG.welcomeBonus, dailyReward: CONFIG.dailyReward, bonus: CONFIG.bonus, gameSettings: CONFIG.gameSettings } });
  }

  /* ── AUTH ─────────────────────────────────────────────────────── */
  if (p === '/api/auth/email' && method === 'POST') {
    const { email } = await parseBody(req);
    if (!email) return sendJSON(res, 400, { ok: false, error: 'Email required' });
    const user = db.getUserByEmail(email);
    if (!user) return sendJSON(res, 401, { ok: false, error: 'No account linked to this email. Use /secure in the Telegram bot first.' });
    const token = signToken({ userId: user.id, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 });
    return sendJSON(res, 200, { ok: true, token, user: publicUser(user) });
  }

  /* ── AUTH-REQUIRED ENDPOINTS ──────────────────────────────────── */
  const userId = getUserIdFromReq(req);
  if (!userId) return sendJSON(res, 401, { ok: false, error: 'Unauthorized — please log in' });

  let user = db.getUser(userId);
  if (!user) {
    user = db.registerUser(userId, '', 'Magic Knight');
  }

  if ((p === '/api/auth/me' || p === '/api/profile' || p === '/api/user') && method === 'GET') {
    return sendJSON(res, 200, { ok: true, data: publicUser(user) });
  }

  // Profile edits
  if (p === '/api/profile/name' && method === 'POST') {
    const { name } = await parseBody(req);
    if (!name || name.length > 30) return sendJSON(res, 400, { ok: false, error: 'Name must be 1–30 chars' });
    db.updateUser(userId, u => { u.name = name; });
    return sendJSON(res, 200, { ok: true, data: publicUser(db.getUser(userId)) });
  }

  if (p === '/api/profile/bio' && method === 'POST') {
    const { bio } = await parseBody(req);
    if ((bio || '').length > 150) return sendJSON(res, 400, { ok: false, error: 'Bio max 150 chars' });
    db.updateUser(userId, u => { u.bio = bio || ''; });
    return sendJSON(res, 200, { ok: true, data: publicUser(db.getUser(userId)) });
  }

  if (p === '/api/profile/age' && method === 'POST') {
    const { age } = await parseBody(req);
    if (isNaN(age) || age < 1 || age > 1000) return sendJSON(res, 400, { ok: false, error: 'Invalid age' });
    db.updateUser(userId, u => { u.age = Number(age); });
    return sendJSON(res, 200, { ok: true, data: publicUser(db.getUser(userId)) });
  }

  if (p === '/api/profile/email' && method === 'POST') {
    const { email } = await parseBody(req);
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) return sendJSON(res, 400, { ok: false, error: 'Invalid email' });
      const existing = db.getUserByEmail(email);
      if (existing && Number(existing.id) !== Number(userId)) return sendJSON(res, 400, { ok: false, error: 'Email already in use' });
    }
    db.linkEmail(userId, email);
    return sendJSON(res, 200, { ok: true, data: publicUser(db.getUser(userId)) });
  }

  // Balance / rank
  if (p === '/api/balance' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, data: { balance: user.balance, bank: user.bank, gems: user.gems || 0 } });
  }

  if (p === '/api/rank' && method === 'GET') {
    const users = db.getAllUsers();
    users.sort((a, b) => b.level - a.level || b.xp - a.xp);
    const levelRank = users.findIndex(u => Number(u.id) === Number(userId)) + 1;
    users.sort((a, b) => (b.balance + b.bank) - (a.balance + a.bank));
    const wealthRank = users.findIndex(u => Number(u.id) === Number(userId)) + 1;
    return sendJSON(res, 200, { ok: true, data: { rank: levelRank, wealthRank, total: users.length, level: user.level, levelTitle: getLevelInfo(user.level)?.title || '' } });
  }

  // Cooldowns
  if (p === '/api/cooldowns' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, data: getCooldowns(user) });
  }

  // Daily Claim
  if (p === '/api/daily' && method === 'POST') {
    const now = Date.now();
    const oneDay = 86400000;
    const twoDays = 172800000;
    if (now - (user.lastDailyClaim || 0) < oneDay) return sendJSON(res, 400, { ok: false, error: 'Daily already claimed' });
    let streak = user.dailyStreak || 0;
    streak = (now - (user.lastDailyClaim || 0) < twoDays) ? streak + 1 : 1;
    const multiplier = 1 + (streak - 1) * 0.5;
    const payout = Math.floor((CONFIG.dailyReward || 5000) * multiplier);
    db.updateUser(userId, u => { u.balance += payout; u.lastDailyClaim = now; u.dailyStreak = streak; });
    db.addXp(userId, 1);
    const fresh = db.getUser(userId);
    return sendJSON(res, 200, { ok: true, data: { reward: payout, streak, multiplier, cooldowns: getCooldowns(fresh) } });
  }

  // Train
  if (p === '/api/train' && method === 'POST') {
    const now = Date.now();
    if (now - (user.lastTrainClaim || 0) < 86400000) return sendJSON(res, 400, { ok: false, error: 'Already trained today' });
    db.updateUser(userId, u => { u.lastTrainClaim = now; });
    db.addXp(userId, 5);
    const fresh = db.getUser(userId);
    return sendJSON(res, 200, { ok: true, data: { xpGained: 5, cooldowns: getCooldowns(fresh) } });
  }

  // Bonus
  if (p === '/api/bonus' && method === 'POST') {
    const now = Date.now();
    const cd = CONFIG.bonus?.cooldownMs || 360000000;
    if (now - (user.lastBonusClaim || 0) < cd) return sendJSON(res, 400, { ok: false, error: 'Bonus on cooldown' });
    const payout = Math.floor(Math.random() * ((CONFIG.bonus?.maxReward || 3000) - (CONFIG.bonus?.minReward || 1000) + 1)) + (CONFIG.bonus?.minReward || 1000);
    db.updateUser(userId, u => { u.balance += payout; u.lastBonusClaim = now; });
    db.addXp(userId, 1);
    const fresh = db.getUser(userId);
    return sendJSON(res, 200, { ok: true, data: { reward: payout, cooldowns: getCooldowns(fresh) } });
  }

  // AFK status
  if (p === '/api/afk' && method === 'POST') {
    const { reason } = await parseBody(req);
    const isAfk = !user.afk?.isAfk;
    db.updateUser(userId, u => { u.afk = { isAfk, reason: reason || 'Away from keyboard', timestamp: Date.now() }; });
    const fresh = db.getUser(userId);
    return sendJSON(res, 200, { ok: true, data: { afk: isAfk, cooldowns: getCooldowns(fresh) } });
  }

  // Deposit / Withdraw
  if (p === '/api/deposit' && method === 'POST') {
    const { amount } = await parseBody(req);
    const amt = amount === 'all' ? user.balance : Number(amount);
    if (isNaN(amt) || amt <= 0 || amt > user.balance) return sendJSON(res, 400, { ok: false, error: 'Invalid amount' });
    db.updateUser(userId, u => { u.balance -= amt; u.bank += amt; });
    return sendJSON(res, 200, { ok: true, data: publicUser(db.getUser(userId)) });
  }

  if (p === '/api/withdraw' && method === 'POST') {
    const { amount } = await parseBody(req);
    const amt = amount === 'all' ? user.bank : Number(amount);
    if (isNaN(amt) || amt <= 0 || amt > user.bank) return sendJSON(res, 400, { ok: false, error: 'Invalid amount' });
    db.updateUser(userId, u => { u.bank -= amt; u.balance += amt; });
    return sendJSON(res, 200, { ok: true, data: publicUser(db.getUser(userId)) });
  }

  // Transfer / Donate
  if ((p === '/api/transfer' || p === '/api/donate') && method === 'POST') {
    const { targetId, amount } = await parseBody(req);
    const amt = Math.floor(Number(amount));
    const target = db.getUser(Number(targetId));
    if (!target) return sendJSON(res, 400, { ok: false, error: 'Target user not found' });
    if (!Number.isFinite(amt) || amt <= 0 || amt > user.balance) return sendJSON(res, 400, { ok: false, error: 'Invalid amount' });
    db.updateUser(userId, u => { u.balance -= amt; });
    db.updateUser(target.id, u => { u.balance += amt; });
    return sendJSON(res, 200, { ok: true, data: commandResult(p.slice(5), `Sent ${amt.toLocaleString()} Yul to ${target.name}.`, { user: publicUser(db.getUser(userId)) }) });
  }

  // Exchange
  if (p === '/api/exchange' && method === 'POST') {
    const { gems } = await parseBody(req);
    const gemsToBuy = Number(gems);
    if (isNaN(gemsToBuy) || gemsToBuy <= 0) return sendJSON(res, 400, { ok: false, error: 'Invalid gem amount' });
    const yulCost = gemsToBuy * 1000;
    if (user.balance < yulCost) return sendJSON(res, 400, { ok: false, error: 'Insufficient Yul' });
    db.updateUser(userId, u => { u.balance -= yulCost; u.gems = (u.gems || 0) + gemsToBuy; });
    return sendJSON(res, 200, { ok: true, data: publicUser(db.getUser(userId)) });
  }

  // Purchase item
  if (p === '/api/purchase' && method === 'POST') {
    const { itemId, quantity } = await parseBody(req);
    const item = CONFIG.shop?.find(i => i.id === Number(itemId));
    if (!item) return sendJSON(res, 400, { ok: false, error: 'Item not found' });
    const qty = Math.max(1, Number(quantity) || 1);
    const isPerk = item.category === 'perks';
    const totalYul = item.price * qty;
    const totalGems = Math.ceil(item.price / 1000) * qty;

    if (isPerk) {
      if ((user.gems || 0) < totalGems) return sendJSON(res, 400, { ok: false, error: 'Insufficient Gems' });
    } else {
      if (user.balance < totalYul) return sendJSON(res, 400, { ok: false, error: 'Insufficient Yul' });
    }

    if (item.subcategory === 'spirit' && user.demon) return sendJSON(res, 400, { ok: false, error: 'Cannot have Spirit and Demon' });
    if (item.subcategory === 'demon' && user.spirit) return sendJSON(res, 400, { ok: false, error: 'Cannot have Spirit and Demon' });

    db.updateUser(userId, u => {
      if (isPerk) u.gems -= totalGems; else u.balance -= totalYul;
      u.inventory[String(itemId)] = (u.inventory[String(itemId)] || 0) + qty;
      if (item.subcategory === 'grimoire') u.grimoire = item.id;
      if (item.subcategory === 'spirit') u.spirit = item.id;
      if (item.subcategory === 'demon') u.demon = item.id;
      db.recalculateStats(u);
    });

    if (isPerk || item.id === 17) {
      db.activateTimedItem(userId, item.id, qty);
    }
    return sendJSON(res, 200, { ok: true, data: publicUser(db.getUser(userId)) });
  }

  // Sell item
  if (p === '/api/sell' && method === 'POST') {
    const { itemId, quantity } = await parseBody(req);
    const item = CONFIG.shop?.find(i => i.id === Number(itemId));
    if (!item) return sendJSON(res, 400, { ok: false, error: 'Item not found' });
    const qty = Math.max(1, Number(quantity) || 1);
    const owned = user.inventory?.[String(itemId)] || 0;
    if (owned < qty) return sendJSON(res, 400, { ok: false, error: 'Not enough owned' });
    const refund = Math.floor(item.price * 0.75) * qty;
    db.updateUser(userId, u => {
      u.inventory[String(itemId)] -= qty;
      if (u.inventory[String(itemId)] <= 0) delete u.inventory[String(itemId)];
      u.balance += refund;
    });
    return sendJSON(res, 200, { ok: true, data: { refund, balance: db.getUser(userId).balance } });
  }

  // Inventory
  if (p === '/api/inventory' && method === 'GET') {
    const inv = user.inventory || {};
    const items = Object.entries(inv).map(([id, qty]) => {
      const item = CONFIG.shop?.find(i => i.id === Number(id));
      return { itemId: Number(id), name: item?.name || id, emoji: item?.emoji || '', quantity: qty, category: item?.category || '' };
    });
    return sendJSON(res, 200, { ok: true, data: items });
  }

  // Character Collections
  if (p === '/api/collection' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, data: user.collection || [] });
  }

  if ((p === '/api/cards' || p === '/api/cards/search') && method === 'GET') {
    const q    = (url.searchParams.get('q') || '').toLowerCase();
    const tier = (url.searchParams.get('tier') || '').toUpperCase();
    let cards  = getAllCards();
    if (q)    cards = cards.filter(c => `${c.name} ${c.series || ''}`.toLowerCase().includes(q));
    if (tier) cards = cards.filter(c => String(c.tier).toUpperCase() === tier);
    return sendJSON(res, 200, { ok: true, data: cards.slice(0, 120) });
  }

  // Pokedex
  if (p === '/api/pokedex' && method === 'GET') {
    const pokedex = user.pokedex || [];
    const pokedexMap = user.pokedexMap || {};
    return sendJSON(res, 200, { ok: true, data: pokedex.map(name => ({ name, count: pokedexMap[name] || 1 })) });
  }

  if (p === '/api/pokemon' && method === 'GET') {
    const q = url.searchParams.get('q') || FEATURED_POKEMON[Math.floor(Math.random() * FEATURED_POKEMON.length)];
    const pk = await fetchPokemonData(q);
    return sendJSON(res, pk ? 200 : 404, pk ? { ok: true, data: pk } : { ok: false, error: 'Pokémon not found' });
  }

  if (p === '/api/pokemon/catch' && method === 'POST') {
    const { name } = await parseBody(req);
    const pk = await fetchPokemonData(name || FEATURED_POKEMON[Math.floor(Math.random() * FEATURED_POKEMON.length)]);
    if (!pk) return sendJSON(res, 400, { ok: false, error: 'Pokémon not found' });
    if (user.balance < pk.catchPrice) return sendJSON(res, 400, { ok: false, error: 'Insufficient Yul' });
    db.updateUser(userId, u => {
      u.balance -= pk.catchPrice;
      if (!u.pokedex.includes(pk.name)) u.pokedex.push(pk.name);
      u.pokedexMap[pk.name] = (u.pokedexMap[pk.name] || 0) + 1;
    });
    return sendJSON(res, 200, { ok: true, data: commandResult('catch', `Caught ${pk.displayName}.`, { pokemon: pk, user: publicUser(db.getUser(userId)) }) });
  }

  // Leaderboard
  if (p === '/api/leaderboard' && method === 'GET') {
    const users = db.getAllUsers();
    users.sort((a, b) => b.level - a.level || b.xp - a.xp);
    return sendJSON(res, 200, { ok: true, data: users.slice(0, 50).map((u, i) => ({ rank: i+1, id: u.id, name: u.name, username: u.username, level: u.level, xp: u.xp })) });
  }

  if (p === '/api/richest' && method === 'GET') {
    const users = db.getAllUsers();
    users.sort((a, b) => (b.balance + b.bank) - (a.balance + a.bank));
    return sendJSON(res, 200, { ok: true, data: users.slice(0, 50).map((u, i) => ({ rank: i+1, id: u.id, name: u.name, username: u.username, wealth: u.balance + u.bank, balance: u.balance, bank: u.bank })) });
  }

  // Activity log
  if (p === '/api/activity' && method === 'GET') {
    const users = db.getAllUsers();
    return sendJSON(res, 200, { ok: true, data: users.slice(-20).map((u, i) => ({ id: i + 1, text: `${u.name} is active in Nova Chrono`, at: new Date(u.registeredAt || Date.now()).toISOString() })) });
  }

  // Squad
  if (p === '/api/squad' && method === 'GET') {
    if (!user.squadId) return sendJSON(res, 200, { ok: true, data: null });
    const squad = db.getSquad(user.squadId);
    if (!squad) return sendJSON(res, 200, { ok: true, data: null });
    const members = squad.members.map(id => {
      const m = db.getUser(id);
      return m ? { id: m.id, name: m.name, role: id === squad.captain ? 'captain' : id === squad.assistant ? 'assistant' : 'member' } : null;
    }).filter(Boolean);
    return sendJSON(res, 200, { ok: true, data: { ...squad, members } });
  }

  if (p === '/api/squad/create' && method === 'POST') {
    const { name } = await parseBody(req);
    if (!name) return sendJSON(res, 400, { ok: false, error: 'Name required' });
    if (user.squadId) return sendJSON(res, 400, { ok: false, error: 'Already in a squad' });
    const squad = db.createSquad(userId, name);
    db.updateUser(userId, u => { u.squadId = squad.id; u.squad = name; });
    return sendJSON(res, 200, { ok: true, data: squad });
  }

  if (p === '/api/squad/join' && method === 'POST') {
    const { squadId } = await parseBody(req);
    const squad = db.getSquad(squadId);
    if (!squad) return sendJSON(res, 400, { ok: false, error: 'Squad not found' });
    if (user.squadId) return sendJSON(res, 400, { ok: false, error: 'Already in a squad' });
    db.updateSquad(squadId, s => { s.members.push(userId); });
    db.updateUser(userId, u => { u.squadId = squad.id; u.squad = squad.name; });
    return sendJSON(res, 200, { ok: true, data: db.getSquad(squadId) });
  }

  if (p === '/api/squad/leave' && method === 'POST') {
    if (!user.squadId) return sendJSON(res, 400, { ok: false, error: 'Not in a squad' });
    const squad = db.getSquad(user.squadId);
    if (squad?.captain === userId) return sendJSON(res, 400, { ok: false, error: 'Captain must disband' });
    db.updateSquad(user.squadId, s => { s.members = s.members.filter(m => m !== userId); });
    db.updateUser(userId, u => { u.squadId = null; u.squad = 'No squad'; });
    return sendJSON(res, 200, { ok: true, data: null });
  }

  if (p === '/api/squad/disband' && method === 'POST') {
    if (!user.squadId) return sendJSON(res, 400, { ok: false, error: 'Not in a squad' });
    const squad = db.getSquad(user.squadId);
    if (squad?.captain !== userId) return sendJSON(res, 400, { ok: false, error: 'Only captain can disband' });
    for (const memberId of squad.members) {
      db.updateUser(memberId, u => { u.squadId = null; u.squad = 'No squad'; });
    }
    db.deleteSquad(user.squadId);
    return sendJSON(res, 200, { ok: true, data: null });
  }

  // Work
  if (p === '/api/work' && method === 'POST') {
    const { job } = await parseBody(req);
    const valid = ['fish','mine','dig','explore','crime'];
    const cmd = String(job || '').toLowerCase();
    if (!valid.includes(cmd)) return sendJSON(res, 400, { ok: false, error: 'Invalid job' });
    const result = await runWork(userId, cmd);
    return sendJSON(res, result.status, result.body);
  }

  // Games
  if (p === '/api/games/play' && method === 'POST') {
    const body = await parseBody(req);
    const game = String(body.game || '').toLowerCase();
    let result;
    if (game === 'dice') {
      const roll = Math.ceil(Math.random() * 6);
      result = await applyGame(userId, game, body.bet, roll === Number(body.prediction), 2, { roll, prediction: Number(body.prediction) });
    } else if (game === 'coin') {
      const flip = Math.random() < 0.5 ? 'heads' : 'tails';
      result = await applyGame(userId, game, body.bet, flip === body.choice, 2, { flip, choice: body.choice });
    } else if (game === 'slots') {
      const icons = ['🍒','💎','⭐','🔮'];
      const reels = [0,1,2].map(() => icons[Math.floor(Math.random() * icons.length)]);
      result = await applyGame(userId, game, body.bet, new Set(reels).size === 1, 4, { reels });
    } else if (game === 'basket') {
      const score = Math.random();
      result = await applyGame(userId, game, body.bet, score >= 0.45, 2, { score: Math.round(score * 100) });
    } else {
      result = { status: 400, body: { ok: false, error: 'Unknown game' } };
    }
    return sendJSON(res, result.status, result.body);
  }

  // Battle
  if (p === '/api/battle' && method === 'POST') {
    const { targetId } = await parseBody(req);
    const target = db.getUser(Number(targetId));
    if (!target) return sendJSON(res, 400, { ok: false, error: 'Target user not found' });
    const win = (user.level + Math.random() * 10) >= (target.level + Math.random() * 10);
    const reward = win ? Math.min(2500, target.balance || 0) : 0;
    if (win && reward) {
      db.updateUser(target.id, u => { u.balance -= reward; });
      db.updateUser(userId, u => { u.balance += reward; u.battleWins = (u.battleWins || 0) + 1; });
    } else {
      db.updateUser(userId, u => { u.battleLosses = (u.battleLosses || 0) + 1; });
    }
    return sendJSON(res, 200, { ok: true, data: commandResult('battle', win ? `Victory over ${target.name}!` : `Defeated by ${target.name}.`, { win, reward, user: publicUser(db.getUser(userId)) }) });
  }

  // Meta
  if (p === '/api/meta' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, data: { botUsername: BOT_USERNAME, ownerId: db.getOwnerId(), admins: db.getAdmins() } });
  }

  /* ── ADMIN ENDPOINTS ──────────────────────────────────────────── */
  const adminStatus = db.isAdmin(userId);
  const ownerStatus = db.isOwner(userId);

  if (p === '/api/admin/stats' && method === 'GET') {
    if (!adminStatus) return sendJSON(res, 403, { ok: false, error: 'Admin only' });
    const users = db.getAllUsers();
    return sendJSON(res, 200, { ok: true, data: {
      totalUsers: users.length,
      totalBalance: users.reduce((s, u) => s + (u.balance || 0), 0),
      totalBank: users.reduce((s, u) => s + (u.bank || 0), 0),
      totalGems: users.reduce((s, u) => s + (u.gems || 0), 0),
      squadCount: db.getAllSquads().length,
    }});
  }

  if (p === '/api/admin/addbal' && method === 'POST') {
    if (!adminStatus) return sendJSON(res, 403, { ok: false, error: 'Admin only' });
    const { targetId, amount } = await parseBody(req);
    const target = db.getUser(Number(targetId));
    if (!target) return sendJSON(res, 400, { ok: false, error: 'User not found' });
    db.updateUser(target.id, u => { u.balance += Number(amount); });
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/admin/resetuser' && method === 'POST') {
    if (!adminStatus) return sendJSON(res, 403, { ok: false, error: 'Admin only' });
    const { targetId } = await parseBody(req);
    db.resetUserData(Number(targetId));
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/admin/broadcast' && method === 'POST') {
    if (!ownerStatus) return sendJSON(res, 403, { ok: false, error: 'Owner only' });
    const { message } = await parseBody(req);
    if (!message) return sendJSON(res, 400, { ok: false, error: 'Message required' });
    return sendJSON(res, 200, { ok: true, data: { sent: db.getAllUsers().length } });
  }

  return sendJSON(res, 404, { ok: false, error: 'Not found' });
}

/* ── Start ────────────────────────────────────────────────────── */
async function main() {
  // Gracefully attempt MongoDB, fallback to local storage
  try {
    const hasMongo = await initMongoStorage();
    if (hasMongo) {
      console.log('✅ Storage Mode: MongoDB connection established.');
    } else {
      console.log('⚠️ Storage Mode: Local JSON File Storage fallback active.');
    }
  } catch (e) {
    console.warn('❌ MongoDB init error. Falling back to local storage:', e.message);
  }

  const server = http.createServer((req, res) => {
    handleReq(req, res).catch(err => {
      console.error('Request error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
    });
  });

  server.listen(PORT, () => {
    console.log(`🌐 Nova Chrono Web App running → http://localhost:${PORT}`);
    console.log(`📡 API available at → http://localhost:${PORT}/api/`);
  });
}

main();
