/**
 * Nova Chrono Webserver — MongoDB Connection Manager
 * Connects directly to the same MongoDB instance as the bot.
 * No in-memory cache — all reads/writes go straight to MongoDB.
 */

import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── Load config.json ──────────────────────────────────────────── */
const CONFIG_PATH = path.resolve(__dirname, 'config.json');
export const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

/* ── Singleton MongoDB connection (reused across serverless calls) */
let _client = null;
let _mainDb  = null;
let _shoobDb = null;

export async function connectDb() {
  if (_mainDb) return; // already connected — reuse

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable is not set. Add it in Vercel → Settings → Environment Variables.');

  _client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    maxPoolSize: 10,
  });
  await _client.connect();

  const dbName = process.env.MONGODB_DB || 'nova_chrono_bot';
  _mainDb  = _client.db(dbName);
  _shoobDb = _client.db('shoob');
  console.log(`✅ Connected to MongoDB (${dbName})`);
}

/* ── Collection accessors (call connectDb() first) ─────────────── */
export const col = {
  users:  () => _mainDb.collection('users'),
  squads: () => _mainDb.collection('squads'),
  admins: () => _mainDb.collection('admins'),
  groups: () => _mainDb.collection('groups'),
  cards:  () => _shoobDb.collection('cards'),
};

/* ── Pure helper functions (no DB needed) ──────────────────────── */
export function getTier(level) {
  if (level <= 10) return 1;
  if (level <= 20) return 2;
  if (level <= 30) return 3;
  if (level <= 40) return 4;
  return 5;
}

export function getLevelInfo(level) {
  const lvl = Math.max(1, Math.min(50, level || 1));
  return CONFIG.levels?.[lvl - 1] || { title: 'Magic Knight', xp: 9999 };
}

export function checkCooldown(user, commandName) {
  const tier = getTier(user.level || 1);
  const cooldownPeriod = CONFIG.gameSettings?.cooldowns?.[tier] || 300000;
  const now = Date.now();
  const lastRun = user.cooldowns?.[commandName] || 0;
  if (now - lastRun < cooldownPeriod) {
    return { active: true, remainingMs: cooldownPeriod - (now - lastRun) };
  }
  return { active: false };
}

export function getCooldowns(user) {
  const now = Date.now();
  const tier = getTier(user.level || 1);
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
  if (now - lastDaily < oneDay)
    result.push({ key: 'daily', endsAt: new Date(lastDaily + oneDay).toISOString() });

  const lastTrain = user.lastTrainClaim || 0;
  if (now - lastTrain < oneDay)
    result.push({ key: 'train', endsAt: new Date(lastTrain + oneDay).toISOString() });

  const bonusCd  = CONFIG.bonus?.cooldownMs || 360000000;
  const lastBonus = user.lastBonusClaim || 0;
  if (now - lastBonus < bonusCd)
    result.push({ key: 'bonus', endsAt: new Date(lastBonus + bonusCd).toISOString() });

  return result;
}

export function buildDefaultUser(userId, username = '', name = 'Magic Knight') {
  return {
    _id: String(userId),
    id:  Number(userId),
    username:   username || '',
    name:       name    || 'Magic Knight',
    bio:        'A newcomer in the Clover Kingdom.',
    age:        null,
    profilePhoto: null,
    linkedEmail:  null,
    squad:   'No squad',
    squadId: null,
    level: 1,
    xp:    0,
    balance: CONFIG.welcomeBonus || 5000,
    bank:    0,
    hp: 100, maxHp: 100,
    mana: 50, maxMana: 50,
    grimoire: null,
    spirit:   null,
    demon:    null,
    inventory:   {},
    activeItems: {},
    gems: 0,
    collection: [],
    pokedex:    [],
    pokedexMap: {},
    lastDailyClaim:  0,
    lastTrainClaim:  0,
    dailyStreak:     0,
    lastBonusClaim:  0,
    cooldowns:   {},
    dailyUsage:  {},
    battleWins:  0,
    battleLosses: 0,
    afk: { isAfk: false, reason: '', timestamp: 0 },
    registeredAt: Date.now(),
  };
}
