/**
 * Nova Chrono Webserver — Self-contained Database & Game Logic Engine
 * Connects directly to MongoDB and caches collections in-memory.
 * Provides synchronous helper interfaces and handles pending promises for serverless.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load local config.json copy
const CONFIG_PATH = path.resolve(__dirname, 'config.json');
export const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

/* ── Memory Cache ─────────────────────────────────────────────── */
export let usersCache = {};
export let squadsCache = {};
export let adminsCache = { ownerId: 0, admins: [] };
export let groupsCache = {};
export let cardsCache = [];

/* ── MongoDB Connection ───────────────────────────────────────── */
export let mongoDb = null;
export let client = null;
let pendingPromises = [];

export const col = {
  users:  () => mongoDb.collection('users'),
  squads: () => mongoDb.collection('squads'),
  admins: () => mongoDb.collection('admins'),
  groups: () => mongoDb.collection('groups'),
  cards:  () => {
    try {
      return client.db('shoob').collection('cards');
    } catch {
      return mongoDb.collection('cards');
    }
  },
};

export async function initMongoStorage() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.warn('⚠️ MONGODB_URI is not set.');
    return false;
  }
  try {
    const dbName = process.env.MONGODB_DB || 'nova_chrono_bot';
    client = new MongoClient(uri);
    await client.connect();
    mongoDb = client.db(dbName);

    // Initial cache warm-up (subsequent requests will refresh individual records)
    const [users, squads, admins, groups, cards] = await Promise.all([
      col.users().find({}).toArray(),
      col.squads().find({}).toArray(),
      col.admins().findOne({ _id: 'singleton' }),
      col.groups().find({}).toArray(),
      col.cards().find({}).limit(500).toArray()
    ]);

    users.forEach(u => { usersCache[String(u.id || u._id)] = u; });
    squads.forEach(s => { squadsCache[String(s.id || s._id)] = s; });
    groups.forEach(g => { groupsCache[String(g.id || g._id)] = g; });
    if (admins) adminsCache = admins;
    if (cards) cardsCache = cards;

    console.log(`✅ Memory Cache Warmed: ${users.length} users.`);
    return true;
  } catch (e) {
    console.error('❌ MongoDB Connection/Warmup failed:', e.message);
    throw e;
  }
}

/* ── Await Helper for Serverless (Vercel) ──────────────────────── */
export function trackPromise(promise) {
  pendingPromises.push(promise);
  promise.catch(() => {});
}

export async function awaitPendingWrites() {
  if (pendingPromises.length > 0) {
    await Promise.all(pendingPromises);
    pendingPromises = [];
  }
}

/* ── Level & Tier Helpers ────────────────────────────────────── */
export function getTier(level) {
  if (level <= 10) return 1;
  if (level <= 20) return 2;
  if (level <= 30) return 3;
  if (level <= 40) return 4;
  return 5;
}

export function getLevelInfo(level) {
  const lvl = Math.max(1, Math.min(50, level));
  return CONFIG.levels[lvl - 1] || { title: 'Magic Knight', xp: 9999 };
}

function buildDefaultUser(userId, username = '', name = 'Magic Knight') {
  return {
    id: Number(userId),
    username: username || '',
    name: name || 'Magic Knight',
    bio: 'A newcomer in the Clover Kingdom.',
    age: null,
    profilePhoto: null,
    linkedEmail: null,
    squad: 'No squad',
    squadId: null,
    level: 1,
    xp: 0,
    balance: CONFIG.welcomeBonus || 5000,
    bank: 0,
    hp: 100,
    maxHp: 100,
    mana: 50,
    maxMana: 50,
    grimoire: null,
    spirit: null,
    demon: null,
    inventory: {},
    activeItems: {},
    gems: 0,
    collection: [],
    pokedex: [],
    pokedexMap: {},
    heistProtectionUntil: 0,
    lastDailyClaim: 0,
    lastTrainClaim: 0,
    dailyStreak: 0,
    lastBonusClaim: 0,
    cooldowns: {},
    dailyUsage: {},
    afk: { isAfk: false, reason: '', timestamp: 0 },
    registeredAt: Date.now()
  };
}

function recalculateStats(user) {
  const baseHp = 100 + (user.level * 20);
  const baseMana = 50 + (user.level * 15);
  let extraHp = 0;
  let extraMana = 0;

  if (user.grimoire) {
    const g = CONFIG.shop?.find(i => i.id == user.grimoire);
    if (g) { extraHp += g.hp || 0; extraMana += g.mana || 0; }
  }
  if (user.spirit) {
    const s = CONFIG.shop?.find(i => i.id == user.spirit);
    if (s) { extraHp += s.hp || 0; extraMana += s.mana || 0; }
  }
  if (user.demon) {
    const d = CONFIG.shop?.find(i => i.id == user.demon);
    if (d) { extraHp += d.hp || 0; extraMana += d.mana || 0; }
  }

  user.maxHp = baseHp + extraHp;
  user.maxMana = baseMana + extraMana;
  if (!user.hp) user.hp = user.maxHp;
  if (!user.mana) user.mana = user.maxMana;
  user.hp = Math.min(user.hp, user.maxHp);
  user.mana = Math.min(user.mana, user.maxMana);
}

/* ── Synchronous Database Interface ───────────────────────────── */
export const db = {
  getAdmins() {
    return adminsCache;
  },

  getOwnerId() {
    return adminsCache.ownerId || 0;
  },

  isAdmin(userId) {
    const uid = Number(userId);
    return uid === Number(adminsCache.ownerId) || (adminsCache.admins || []).includes(uid);
  },

  isOwner(userId) {
    return Number(userId) === Number(adminsCache.ownerId);
  },

  addAdmin(userId) {
    const uid = Number(userId);
    if (!adminsCache.admins) adminsCache.admins = [];
    if (!adminsCache.admins.includes(uid)) {
      adminsCache.admins.push(uid);
      if (mongoDb) {
        trackPromise(col.admins().updateOne(
          { _id: 'singleton' },
          { $addToSet: { admins: uid } },
          { upsert: true }
        ));
      }
    }
    return true;
  },

  removeAdmin(userId) {
    const uid = Number(userId);
    if (adminsCache.admins) {
      adminsCache.admins = adminsCache.admins.filter(id => id !== uid);
      if (mongoDb) {
        trackPromise(col.admins().updateOne(
          { _id: 'singleton' },
          { $pull: { admins: uid } }
        ));
      }
    }
    return true;
  },

  getUser(userId) {
    const idStr = String(userId);
    return usersCache[idStr] || null;
  },

  getUserByEmail(email) {
    if (!email) return null;
    const normalised = String(email).trim().toLowerCase();
    return Object.values(usersCache).find(
      u => u.linkedEmail && String(u.linkedEmail).trim().toLowerCase() === normalised
    ) || null;
  },

  registerUser(userId, username, name) {
    const idStr = String(userId);
    if (usersCache[idStr]) return usersCache[idStr];
    
    const newUser = buildDefaultUser(userId, username, name);
    usersCache[idStr] = newUser;

    if (mongoDb) {
      trackPromise(col.users().insertOne({ _id: idStr, ...newUser }));
    }
    return newUser;
  },

  updateUser(userId, updaterFn) {
    const idStr = String(userId);
    const user = usersCache[idStr];
    if (!user) return null;
    updaterFn(user);

    if (mongoDb) {
      const { _id, ...cleanUser } = user;
      trackPromise(col.users().replaceOne({ _id: idStr }, cleanUser));
    }
    return user;
  },

  linkEmail(userId, email) {
    const idStr = String(userId);
    const user = usersCache[idStr];
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    if (user) {
      user.linkedEmail = cleanEmail;
      if (mongoDb) {
        trackPromise(col.users().updateOne(
          { _id: idStr },
          { $set: { linkedEmail: cleanEmail } }
        ));
      }
    }
  },

  getAllUsers() {
    return Object.values(usersCache);
  },

  getSquad(squadId) {
    const idStr = String(squadId);
    return squadsCache[idStr] || null;
  },

  getAllSquads() {
    return Object.values(squadsCache);
  },

  createSquad(creatorId, name) {
    const squadId = "SQ" + Date.now().toString(36).toUpperCase();
    const newSquad = {
      id: squadId,
      name: name,
      captain: Number(creatorId),
      assistant: null,
      members: [Number(creatorId)],
      createdAt: Date.now()
    };
    squadsCache[squadId] = newSquad;

    if (mongoDb) {
      const dbPayload = { _id: squadId, ...newSquad };
      trackPromise(col.squads().insertOne(dbPayload));
    }
    return newSquad;
  },

  updateSquad(squadId, updaterFn) {
    const idStr = String(squadId);
    const squad = squadsCache[idStr];
    if (!squad) return null;
    updaterFn(squad);

    if (mongoDb) {
      const { _id, ...cleanSquad } = squad;
      trackPromise(col.squads().replaceOne({ _id: idStr }, cleanSquad));
    }
    return squad;
  },

  deleteSquad(squadId) {
    const idStr = String(squadId);
    if (squadsCache[idStr]) {
      delete squadsCache[idStr];
      if (mongoDb) {
        trackPromise(col.squads().deleteOne({ _id: idStr }));
      }
      return true;
    }
    return false;
  },

  recalculateStats(user) {
    recalculateStats(user);
  },

  checkCooldown(user, commandName) {
    const tier = getTier(user.level);
    const cooldownPeriod = CONFIG.gameSettings?.cooldowns?.[tier] || 0;
    const now = Date.now();
    const lastRun = user.cooldowns?.[commandName] || 0;

    if (now - lastRun < cooldownPeriod) {
      const remainingMs = cooldownPeriod - (now - lastRun);
      return { active: true, remainingMs };
    }
    return { active: false };
  },

  setCooldown(userId, commandName) {
    this.updateUser(userId, u => {
      if (!u.cooldowns) u.cooldowns = {};
      u.cooldowns[commandName] = Date.now();
    });
  },

  incrementDailyUsage(userId, commandName) {
    this.updateUser(userId, u => {
      const dateStr = new Date().toISOString().split('T')[0];
      if (!u.dailyUsage) u.dailyUsage = {};
      if (!u.dailyUsage[dateStr]) u.dailyUsage[dateStr] = {};
      u.dailyUsage[dateStr][commandName] = (u.dailyUsage[dateStr][commandName] || 0) + 1;
    });
  },

  addXp(userId, xpAmount) {
    let leveledUp = false;
    let oldLevel = 1;
    let newLevel = 1;

    const user = this.updateUser(userId, u => {
      oldLevel = u.level;
      u.xp = Math.max(0, (u.xp || 0) + xpAmount);

      let currentLvl = u.level;
      if (xpAmount > 0) {
        while (currentLvl < 50) {
          const nextLevelInfo = CONFIG.levels[currentLvl - 1];
          if (nextLevelInfo && u.xp >= nextLevelInfo.xp) {
            currentLvl++;
            leveledUp = true;
          } else {
            break;
          }
        }
      }

      if (leveledUp) {
        u.level = currentLvl;
        newLevel = currentLvl;
        recalculateStats(u);
        u.hp = u.maxHp;
        u.mana = u.maxMana;
      }
    });

    return { user, leveledUp, oldLevel, newLevel };
  },

  resetUserData(userId) {
    const idStr = String(userId);
    if (usersCache[idStr]) {
      delete usersCache[idStr];
      if (mongoDb) {
        trackPromise(col.users().deleteOne({ _id: idStr }));
      }
      return true;
    }
    return false;
  },

  clearAllCollections() {
    let count = 0;
    Object.values(usersCache).forEach(u => {
      if (u.collection && u.collection.length > 0) {
        u.collection = [];
        count++;
      }
    });
    if (mongoDb) {
      trackPromise(col.users().updateMany({}, { $set: { collection: [] } }));
    }
    return count;
  },

  getAllCards() {
    return cardsCache;
  },

  getAllGroups() {
    return Object.values(groupsCache);
  }
};
export default db;
