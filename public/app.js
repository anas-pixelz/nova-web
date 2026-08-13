/**
 * Nova Chrono — Standalone Web App Frontend Single-Page App (SPA)
 */

/* ── Telegram Mini App setup ─────────────────────────────────── */
function getTmaInitData() {
  try {
    const tg = window.Telegram?.WebApp;
    if (tg && typeof tg.initData === 'string' && tg.initData.length > 0) {
      return tg.initData;
    }
  } catch(e) {}
  return null;
}

function isTelegramContext() {
  return getTmaInitData() !== null;
}

// API Helper
const API = {
  token: localStorage.getItem('nc_session_token'),
  userId: null,
  
  headers() {
    const h = { 'Content-Type': 'application/json' };
    const tmaData = getTmaInitData();
    if (tmaData) {
      h['Authorization'] = `tma ${tmaData}`;
    } else if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`;
    }
    return h;
  },

  async request(path, method = 'GET', body = null) {
    const options = {
      method,
      headers: this.headers()
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    try {
      const response = await fetch(`/api${path}`, options);
      const resData = await response.json();
      if (!response.ok) {
        throw new Error(resData.error || `HTTP ${response.status}`);
      }
      return resData;
    } catch (e) {
      console.error(`API Error: ${path}`, e);
      throw e;
    }
  },

  async login(email) {
    const res = await this.request('/auth/email', 'POST', { email });
    if (res.ok && res.token) {
      this.token = res.token;
      localStorage.setItem('nc_session_token', res.token);
      return res.user;
    }
    throw new Error('Authentication failed');
  },

  logout() {
    this.token = null;
    localStorage.removeItem('nc_session_token');
    window.location.reload();
  }
};

// Global App State
const state = {
  user: null,
  cooldowns: [],
  meta: null,
  currentTab: 'home',
  activeJob: null
};

// Toast Notifications
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = message;
  container.appendChild(t);
  setTimeout(() => {
    t.remove();
  }, 4300);
}

// Format numbers as currency
function formatYul(val) {
  return Number(val || 0).toLocaleString();
}

// Modal management
function openModal(html) {
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  content.innerHTML = html;
  overlay.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// Settings Drawer management
function toggleDrawer(show) {
  const drawer = document.getElementById('settings-drawer');
  const overlay = document.getElementById('drawer-overlay');
  if (show) {
    drawer.classList.add('open');
    overlay.classList.add('open');
    renderDrawerInfo();
  } else {
    drawer.classList.remove('open');
    overlay.classList.remove('open');
  }
}

function renderDrawerInfo() {
  const info = document.getElementById('drawer-user-info');
  if (!state.user) return;
  info.innerHTML = `
    <img src="${state.user.profilePhoto || 'https://i.pinimg.com/736x/87/42/48/874248ef7273934f8a0058b8f2d5e305.jpg'}" class="drawer-user-avatar" alt="Avatar"/>
    <div class="drawer-user-name">${escapeHTML(state.user.name)}</div>
    <div class="drawer-user-tag">@${escapeHTML(state.user.username || 'user')}</div>
  `;
}

// Render Topbar details
function updateTopbar() {
  if (!state.user) return;
  document.getElementById('topbar-yul').textContent = formatYul(state.user.balance) + ' Yul';
  updateCooldownBadge();
}

function updateCooldownBadge() {
  const badge = document.getElementById('cd-badge');
  const activeCount = state.cooldowns.length;
  if (activeCount > 0) {
    badge.textContent = activeCount;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

// Cooldown list panel
function toggleCooldownPanel() {
  const panel = document.getElementById('cd-panel');
  if (panel.classList.contains('hidden')) {
    renderCooldownPanel();
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
}

function renderCooldownPanel() {
  const body = document.getElementById('cd-panel-body');
  if (state.cooldowns.length === 0) {
    body.innerHTML = '<p class="text-center text-muted" style="padding: 10px 0;">All systems ready!</p>';
    return;
  }
  let html = '';
  const now = Date.now();
  state.cooldowns.forEach(cd => {
    const remaining = Math.max(0, Math.ceil((new Date(cd.endsAt).getTime() - now) / 1000));
    html += `
      <div class="cd-item">
        <span class="cd-name">${cd.key}</span>
        <span class="cd-time" data-cd-key="${cd.key}">${remaining}s</span>
      </div>
    `;
  });
  body.innerHTML = html;
}

// Live timer updater tick
setInterval(() => {
  if (!state.user) return;
  const now = Date.now();
  
  // Update cooldown list times
  document.querySelectorAll('[data-cd-key]').forEach(el => {
    const key = el.getAttribute('data-cd-key');
    const cd = state.cooldowns.find(c => c.key === key);
    if (cd) {
      const remaining = Math.max(0, Math.ceil((new Date(cd.endsAt).getTime() - now) / 1000));
      el.textContent = remaining > 0 ? `${remaining}s` : 'Ready';
      if (remaining <= 0) {
        state.cooldowns = state.cooldowns.filter(c => c.key !== key);
        updateCooldownBadge();
      }
    }
  });

  // Update in-page claim button cooldowns
  document.querySelectorAll('[data-cooldown-target]').forEach(el => {
    const key = el.getAttribute('data-cooldown-target');
    const cd = state.cooldowns.find(c => c.key === key);
    if (cd) {
      const remaining = Math.max(0, Math.ceil((new Date(cd.endsAt).getTime() - now) / 1000));
      if (remaining > 0) {
        el.disabled = true;
        el.textContent = `${key.toUpperCase()} (${remaining}s)`;
      } else {
        el.disabled = false;
        el.textContent = key.toUpperCase();
        state.cooldowns = state.cooldowns.filter(c => c.key !== key);
        updateCooldownBadge();
      }
    }
  });
}, 1000);

// Fetch all initial data
async function fetchAllUserData() {
  try {
    const uRes = await API.request('/auth/me');
    state.user = uRes.data;
    
    const cdRes = await API.request('/cooldowns');
    state.cooldowns = cdRes.data;

    const mRes = await API.request('/meta');
    state.meta = mRes.data;

    updateTopbar();
    renderCurrentTab();
  } catch (e) {
    toast('Session expired. Please log in again.', 'error');
    API.logout();
  }
}

// Safe string escaping
function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ───────────────────────────────────────────────────────────────
   ROUTER & NAVIGATION
   ─────────────────────────────────────────────────────────────── */
function initNavigation() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      switchTab(tab);
    });
  });
}

function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('[data-tab]').forEach(btn => {
    if (btn.getAttribute('data-tab') === tab) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  
  // Set title
  const titles = {
    home: 'Home',
    market: 'Market / Catalog',
    cards: 'Cards & Collection',
    games: 'Games / Activities',
    community: 'Community & Stats',
    admin: 'Admin Console'
  };
  document.getElementById('topbar-title').textContent = titles[tab] || 'Nova Chrono';
  renderCurrentTab();
}

function renderCurrentTab() {
  const content = document.getElementById('page-content');
  content.innerHTML = '<div class="text-center text-muted" style="padding: 40px 0;">Loading magic...</div>';
  
  switch(state.currentTab) {
    case 'home':
      renderHome(content);
      break;
    case 'market':
      renderMarket(content);
      break;
    case 'cards':
      renderCards(content);
      break;
    case 'games':
      renderGames(content);
      break;
    case 'community':
      renderCommunity(content);
      break;
    case 'admin':
      renderAdmin(content);
      break;
  }
}

/* ───────────────────────────────────────────────────────────────
   TAB: HOME (DASHBOARD & PROFILE)
   ─────────────────────────────────────────────────────────────── */
function renderHome(container) {
  const u = state.user;
  const nextLvlXp = (CONFIG_DATA.levels && CONFIG_DATA.levels[u.level]) ? CONFIG_DATA.levels[u.level].xp : 1000;
  const progress = Math.min((u.xp / nextLvlXp) * 100, 100);

  container.innerHTML = `
    <div class="dashboard-grid">
      <!-- Profile Card -->
      <div class="panel profile-card">
        <div class="profile-header">
          <div class="profile-avatar-wrapper">
            <img src="${u.profilePhoto || 'https://i.pinimg.com/736x/87/42/48/874248ef7273934f8a0058b8f2d5e305.jpg'}" class="profile-avatar" alt="Avatar"/>
            <div class="level-badge">${u.level}</div>
          </div>
          <div class="profile-info">
            <h3>${escapeHTML(u.name)}</h3>
            <span class="profile-squad">${escapeHTML(u.squad || 'No Squad')}</span>
          </div>
        </div>

        <p class="profile-bio">"${escapeHTML(u.bio || 'No bio set.')}"</p>

        <div class="stat-meters">
          <div class="meter-group">
            <div class="meter-header">
              <span>HP</span>
              <span>${u.hp} / ${u.maxHp}</span>
            </div>
            <div class="meter-bar">
              <div class="meter-fill meter-hp" style="width: ${(u.hp / u.maxHp)*100}%"></div>
            </div>
          </div>

          <div class="meter-group">
            <div class="meter-header">
              <span>Mana</span>
              <span>${u.mana} / ${u.maxMana}</span>
            </div>
            <div class="meter-bar">
              <div class="meter-fill meter-mana" style="width: ${(u.mana / u.maxMana)*100}%"></div>
            </div>
          </div>

          <div class="meter-group">
            <div class="meter-header">
              <span>XP Progress</span>
              <span>${u.xp} / ${nextLvlXp} XP</span>
            </div>
            <div class="meter-bar">
              <div class="meter-fill meter-xp" style="width: ${progress}%"></div>
            </div>
          </div>
        </div>

        <div class="claim-row" style="margin-top: 10px;">
          <button class="btn btn-secondary btn-sm" id="btn-edit-profile-modal">
            <svg class="icon-sm"><use href="#icon-edit"/></svg> Edit Bio
          </button>
          <button class="btn ${u.afk?.isAfk ? 'btn-danger' : 'btn-secondary'} btn-sm" id="btn-afk-toggle">
            <svg class="icon-sm"><use href="#icon-afk"/></svg> ${u.afk?.isAfk ? 'AFK On' : 'Go AFK'}
          </button>
        </div>
      </div>

      <!-- Balance Panel -->
      <div class="panel balance-panel">
        <div class="balance-item">
          <span class="bal-label">Wallet Balance</span>
          <span class="bal-val text-gold">${formatYul(u.balance)} Yul</span>
        </div>
        <div class="balance-item">
          <span class="bal-label">Bank Storage</span>
          <span class="bal-val text-purple">${formatYul(u.bank)} Yul</span>
        </div>
        <div class="balance-item" style="grid-column: span 2;">
          <span class="bal-label">Gems (Perks)</span>
          <span class="bal-val text-blue">${formatYul(u.gems || 0)} 💎</span>
        </div>
        
        <div class="claim-row" style="grid-column: span 2;">
          <button class="btn btn-primary btn-sm" id="btn-deposit-modal">Deposit</button>
          <button class="btn btn-secondary btn-sm" id="btn-withdraw-modal">Withdraw</button>
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="panel full-width">
        <h3 class="games-group-title" style="margin-bottom: 16px;">
          <svg class="icon-sm"><use href="#icon-bolt"/></svg> Daily Claims
        </h3>
        <div class="claim-row">
          <button class="btn btn-primary" id="btn-daily-claim" data-cooldown-target="daily">
            CLAIM DAILY
          </button>
          <button class="btn btn-secondary" id="btn-bonus-claim" data-cooldown-target="bonus">
            CLAIM BONUS
          </button>
          <button class="btn btn-secondary" id="btn-train-claim" data-cooldown-target="train">
            TRAIN XP
          </button>
        </div>
      </div>
    </div>
  `;

  // Attach handlers
  document.getElementById('btn-daily-claim').addEventListener('click', () => handleClaim('/daily', 'Daily claimed!'));
  document.getElementById('btn-bonus-claim').addEventListener('click', () => handleClaim('/bonus', 'Bonus reward claimed!'));
  document.getElementById('btn-train-claim').addEventListener('click', () => handleClaim('/train', 'You completed training and gained XP!'));
  
  document.getElementById('btn-deposit-modal').addEventListener('click', () => showBankModal('deposit'));
  document.getElementById('btn-withdraw-modal').addEventListener('click', () => showBankModal('withdraw'));
  document.getElementById('btn-edit-profile-modal').addEventListener('click', showEditProfileModal);
  
  document.getElementById('btn-afk-toggle').addEventListener('click', async () => {
    try {
      const reason = u.afk?.isAfk ? '' : prompt('Enter AFK message:', 'Away from keyboard') || 'Away';
      const res = await API.request('/afk', 'POST', { reason });
      if (res.ok) {
        state.user.afk.isAfk = res.data.afk;
        toast(res.data.afk ? 'You are now AFK' : 'Welcome back! AFK disabled.', 'success');
        fetchAllUserData();
      }
    } catch(e) { toast('Failed to update AFK status', 'error'); }
  });
}

async function handleClaim(path, successMsg) {
  try {
    const res = await API.request(path, 'POST');
    if (res.ok) {
      toast(`${successMsg} +${formatYul(res.data.reward || res.data.xpGained || 0)}`, 'success');
      fetchAllUserData();
    }
  } catch(e) {
    toast(e.message, 'error');
  }
}

function showBankModal(action) {
  const title = action === 'deposit' ? 'Bank Deposit' : 'Bank Withdrawal';
  const label = action === 'deposit' ? 'Deposit amount' : 'Withdraw amount';
  const max = action === 'deposit' ? state.user.balance : state.user.bank;
  
  openModal(`
    <h2>${title}</h2>
    <p class="text-muted" style="margin-bottom: 16px;">Max available: ${formatYul(max)} Yul</p>
    <div class="form-group">
      <label>${label}</label>
      <input type="number" id="bank-input-amt" placeholder="Enter amount" min="1" max="${max}" style="width:100%"/>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary btn-sm" id="btn-bank-all">MAX</button>
      <button class="btn btn-primary btn-sm" id="btn-bank-submit">CONFIRM</button>
    </div>
  `);

  document.getElementById('btn-bank-all').addEventListener('click', () => {
    document.getElementById('bank-input-amt').value = max;
  });

  document.getElementById('btn-bank-submit').addEventListener('click', async () => {
    const val = document.getElementById('bank-input-amt').value;
    const amount = val === String(max) ? 'all' : Number(val);
    if (!val || (amount !== 'all' && isNaN(amount))) return toast('Please enter a valid amount', 'error');
    try {
      const res = await API.request(`/${action}`, 'POST', { amount });
      if (res.ok) {
        toast(`${action === 'deposit' ? 'Deposited' : 'Withdrawn'} ${formatYul(res.data.bank - state.user.bank)} Yul`, 'success');
        closeModal();
        fetchAllUserData();
      }
    } catch(e) { toast(e.message, 'error'); }
  });
}

function showEditProfileModal() {
  openModal(`
    <h2>Edit Profile</h2>
    <div class="form-group">
      <label>Display Name</label>
      <input type="text" id="edit-profile-name" value="${escapeHTML(state.user.name)}" maxlength="30" style="width:100%"/>
    </div>
    <div class="form-group">
      <label>Biography</label>
      <textarea id="edit-profile-bio" rows="3" maxlength="150" style="width:100%">${escapeHTML(state.user.bio || '')}</textarea>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary btn-sm" id="btn-profile-save">SAVE CHANGES</button>
    </div>
  `);

  document.getElementById('btn-profile-save').addEventListener('click', async () => {
    const name = document.getElementById('edit-profile-name').value;
    const bio = document.getElementById('edit-profile-bio').value;
    try {
      await API.request('/profile/name', 'POST', { name });
      await API.request('/profile/bio', 'POST', { bio });
      toast('Profile updated successfully!', 'success');
      closeModal();
      fetchAllUserData();
    } catch(e) { toast(e.message, 'error'); }
  });
}

/* ───────────────────────────────────────────────────────────────
   TAB: MARKET / SHOP
   ─────────────────────────────────────────────────────────────── */
let shopCatalog = [];
async function renderMarket(container) {
  container.innerHTML = `<div class="text-center text-muted" style="padding: 40px 0;">Loading marketplace inventory...</div>`;
  try {
    if (shopCatalog.length === 0) {
      const res = await API.request('/catalog');
      shopCatalog = res.data || [];
    }
    
    // Render inventory & Shop items
    let invHtml = '';
    const invRes = await API.request('/inventory');
    const myInv = invRes.data || [];
    
    myInv.forEach(item => {
      invHtml += `
        <div class="squad-member-row" style="margin-bottom: 8px;">
          <span>${item.emoji} <strong>${escapeHTML(item.name)}</strong></span>
          <div style="display:flex; gap:10px; align-items:center;">
            <span class="text-muted">x${item.quantity}</span>
            <button class="btn btn-danger btn-sm" onclick="sellItem(${item.itemId}, 1)">Sell 75%</button>
          </div>
        </div>
      `;
    });

    let shopCards = '';
    shopCatalog.forEach(item => {
      const isPerk = item.category === 'perks';
      const costType = isPerk ? 'Gems' : 'Yul';
      const priceVal = isPerk ? Math.ceil(item.price / 1000) : item.price;
      
      shopCards += `
        <div class="shop-card">
          <div class="shop-card-emoji">${item.emoji || '📦'}</div>
          <div class="shop-card-info">
            <span class="shop-card-name">${escapeHTML(item.name)}</span>
            <span class="shop-card-desc">${escapeHTML(item.description || 'Equipable magic item.')}</span>
          </div>
          <div class="shop-card-footer">
            <span class="shop-card-price text-gold">
              ${isPerk ? '💎 ' : ''}${formatYul(priceVal)} ${costType}
            </span>
            <button class="btn btn-primary btn-sm" onclick="buyItem(${item.id})">BUY</button>
          </div>
        </div>
      `;
    });

    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:24px;">
        <div class="panel">
          <h3 class="games-group-title" style="margin-bottom: 16px;"><svg><use href="#icon-package"/></svg> Your Inventory</h3>
          <div id="user-inventory-container">
            ${invHtml || '<p class="text-muted text-center" style="padding:20px 0;">No items in inventory. Buy some below!</p>'}
          </div>
        </div>
        
        <div>
          <h3 class="games-group-title" style="margin-bottom:16px;"><svg><use href="#icon-shop"/></svg> Clover Kingdom Shop</h3>
          <div class="shop-grid">${shopCards}</div>
        </div>
      </div>
    `;
  } catch(e) { container.innerHTML = `<p class="text-red">${e.message}</p>`; }
}

window.buyItem = async function(id) {
  const item = shopCatalog.find(i => i.id === id);
  if (!item) return;
  const qty = prompt(`How many ${item.name} would you like to buy?`, "1");
  if (!qty || isNaN(qty) || Number(qty) < 1) return;
  try {
    const res = await API.request('/purchase', 'POST', { itemId: id, quantity: Number(qty) });
    if (res.ok) {
      toast(`Successfully purchased ${qty}x ${item.name}!`, 'success');
      fetchAllUserData();
    }
  } catch(e) { toast(e.message, 'error'); }
};

window.sellItem = async function(id, qty) {
  try {
    const res = await API.request('/sell', 'POST', { itemId: id, quantity: qty });
    if (res.ok) {
      toast(`Sold item! Refunded ${formatYul(res.data.refund)} Yul`, 'success');
      fetchAllUserData();
    }
  } catch(e) { toast(e.message, 'error'); }
};

/* ───────────────────────────────────────────────────────────────
   TAB: CARDS (COLLECTION & POKEDEX)
   ─────────────────────────────────────────────────────────────── */
let activeCardTab = 'characters';
let cardsQuery = '';
let selectedTier = '';
if (!state.cardSubTab) state.cardSubTab = 'browse';

function renderCards(container) {
  const subTab = state.cardSubTab || 'browse';
  container.innerHTML = `
    <div>
      <div class="cards-tabs">
        <button class="cards-tab-btn ${activeCardTab === 'characters' ? 'active' : ''}" id="btn-tab-cards">Character Cards</button>
        <button class="cards-tab-btn ${activeCardTab === 'pokedex' ? 'active' : ''}" id="btn-tab-pokedex">Pokédex</button>
      </div>

      ${activeCardTab === 'characters' ? `
      <div class="cards-tabs" style="margin-top:8px;">
        <button class="cards-tab-btn ${subTab === 'browse' ? 'active' : ''}" id="btn-subtab-browse">🌐 Browse All</button>
        <button class="cards-tab-btn ${subTab === 'owned' ? 'active' : ''}" id="btn-subtab-owned">⭐ My Collection</button>
      </div>
      ` : ''}

      <div class="search-filter-bar">
        <div class="input-group">
          <svg class="input-icon"><use href="#icon-search"/></svg>
          <input type="text" id="cards-search-input" placeholder="${activeCardTab === 'pokedex' ? 'Search pokédex...' : 'Search cards by name or series...'}" value="${escapeHTML(cardsQuery)}"/>
        </div>
        ${activeCardTab === 'characters' ? `
          <select id="cards-tier-select" class="btn btn-secondary" style="padding: 10px 14px; border-radius:12px;">
            <option value="">All Tiers</option>
            <option value="T1" ${selectedTier==='T1'?'selected':''}>T1 ⚪</option>
            <option value="T2" ${selectedTier==='T2'?'selected':''}>T2 🟢</option>
            <option value="T3" ${selectedTier==='T3'?'selected':''}>T3 🔵</option>
            <option value="T4" ${selectedTier==='T4'?'selected':''}>T4 🟣</option>
            <option value="T5" ${selectedTier==='T5'?'selected':''}>T5 🟡</option>
            <option value="T6" ${selectedTier==='T6'?'selected':''}>T6 💎</option>
          </select>
        ` : ''}
      </div>

      <div class="collection-grid" id="collection-items-container">
        <!-- Collection content loaded via API -->
      </div>
    </div>
  `;

  // Main tab switchers
  document.getElementById('btn-tab-cards').addEventListener('click', () => {
    activeCardTab = 'characters';
    cardsQuery = '';
    selectedTier = '';
    renderCards(container);
  });
  document.getElementById('btn-tab-pokedex').addEventListener('click', () => {
    activeCardTab = 'pokedex';
    cardsQuery = '';
    renderCards(container);
  });

  // Sub-tab switchers (browse / owned)
  if (activeCardTab === 'characters') {
    document.getElementById('btn-subtab-browse').addEventListener('click', () => {
      state.cardSubTab = 'browse';
      cardsQuery = '';
      selectedTier = '';
      renderCards(container);
    });
    document.getElementById('btn-subtab-owned').addEventListener('click', () => {
      state.cardSubTab = 'owned';
      cardsQuery = '';
      selectedTier = '';
      renderCards(container);
    });
  }

  const searchEl = document.getElementById('cards-search-input');
  searchEl.addEventListener('input', (e) => {
    cardsQuery = e.target.value;
    loadCollectionGrid();
  });

  if (activeCardTab === 'characters') {
    document.getElementById('cards-tier-select').addEventListener('change', (e) => {
      selectedTier = e.target.value;
      loadCollectionGrid();
    });
  }

  loadCollectionGrid();
}

async function loadCollectionGrid() {
  const container = document.getElementById('collection-items-container');
  container.innerHTML = '<div class="text-center text-muted" style="grid-column: 1/-1; padding: 20px 0;">Searching cards...</div>';

  try {
    if (activeCardTab === 'characters') {
      // Sub-tabs: 'owned' or 'browse'
      const subTab = state.cardSubTab || 'browse';

      let cards = [];
      if (subTab === 'owned') {
        // User's personal collection
        const res = await API.request('/collection');
        cards = res.data || [];
      } else {
        // Browse ALL cards from shoob database via search endpoint
        let url = '/cards';
        const params = [];
        if (cardsQuery) params.push(`q=${encodeURIComponent(cardsQuery)}`);
        if (selectedTier) params.push(`tier=${encodeURIComponent(selectedTier)}`);
        if (params.length) url += '?' + params.join('&');
        const res = await API.request(url);
        cards = res.data || [];
      }

      // Client-side filter (for owned tab)
      if (subTab === 'owned') {
        if (cardsQuery) cards = cards.filter(c => `${c.name||''} ${c.series||''}`.toLowerCase().includes(cardsQuery.toLowerCase()));
        if (selectedTier) cards = cards.filter(c => String(c.tier).toUpperCase() === selectedTier.toUpperCase());
      }

      if (cards.length === 0) {
        const msg = subTab === 'owned'
          ? 'You have no anime cards yet. Cards are claimed in Telegram groups.'
          : 'No cards found matching your search. Try different keywords.';
        container.innerHTML = `<p class="text-center text-muted" style="grid-column: 1/-1; padding: 40px 0;">${msg}</p>`;
        return;
      }

      let html = '';
      cards.forEach(card => {
        const img = card.image_url || card.media_url || card.img || 'https://i.pinimg.com/736x/87/42/48/874248ef7273934f8a0058b8f2d5e305.jpg';
        const tierLabel = card.tier || card.rarity || '?';
        const seriesLabel = card.series || card.anime || card.source || '';
        html += `
          <div class="character-card" onclick="viewCardDetails('${escapeHTML(card.card_id || card._id || card.name)}')"
               style="cursor:pointer;" data-card-id="${escapeHTML(card.card_id || card._id || '')}"
               data-card-name="${escapeHTML(card.name||'')}"
               data-card-series="${escapeHTML(seriesLabel)}"
               data-card-tier="${escapeHTML(String(tierLabel))}"
               data-card-img="${escapeHTML(img)}">
            <img class="character-img" src="${img}" alt="${escapeHTML(card.name||'Card')}" loading="lazy"
                 onerror="this.src='https://i.pinimg.com/736x/87/42/48/874248ef7273934f8a0058b8f2d5e305.jpg'"/>
            <div class="card-overlay">
              <span class="card-tier">${escapeHTML(String(tierLabel))}</span>
              <span class="card-title">${escapeHTML(card.name||'Unknown')}</span>
              <span class="card-series">${escapeHTML(seriesLabel)}</span>
            </div>
          </div>
        `;
      });
      container.innerHTML = html;

      // Save collection for detail view
      state.currentCardCollection = cards;

      // Attach click from data-attributes (avoids closure issues)
      container.querySelectorAll('.character-card').forEach(el => {
        el.addEventListener('click', () => {
          const card = {
            card_id: el.dataset.cardId,
            name: el.dataset.cardName,
            series: el.dataset.cardSeries,
            tier: el.dataset.cardTier,
            image_url: el.dataset.cardImg
          };
          openCardDetailModal(card);
        });
      });

    } else {
      // Pokemon tab
      const res = await API.request('/pokedex');
      let pokemons = res.data || [];

      if (cardsQuery) {
        pokemons = pokemons.filter(p => p.name.toLowerCase().includes(cardsQuery.toLowerCase()));
      }

      if (pokemons.length === 0) {
        container.innerHTML = '<p class="text-center text-muted" style="grid-column: 1/-1; padding: 40px 0;">No Pokémon registered in your Pokédex yet.</p>';
        return;
      }

      let html = '';
      for (const pk of pokemons) {
        html += `
          <div class="character-card pokemon-card" onclick="viewPokemonDetails('${escapeHTML(pk.name)}')">
            <div class="card-overlay" style="background: linear-gradient(0deg, rgba(0,0,0,0.9) 0%, transparent 100%);">
              <span class="card-tier" style="background:var(--accent-gold); color:black;">x${pk.count}</span>
              <span class="card-title" style="text-transform: capitalize;">${escapeHTML(pk.name)}</span>
              <span class="card-series">Click for details</span>
            </div>
          </div>
        `;
      }
      container.innerHTML = html;
    }
  } catch(e) { container.innerHTML = `<p class="text-red" style="grid-column:1/-1;">Error loading cards: ${e.message}</p>`; }
}

window.viewCardDetails = function(cardId) {
  const card = state.currentCardCollection?.find(c =>
    (c.card_id || c._id || c.name) === cardId
  );
  if (!card) return;
  openCardDetailModal(card);
};

function openCardDetailModal(card) {
  const img = card.image_url || card.media_url || card.img || 'https://i.pinimg.com/736x/87/42/48/874248ef7273934f8a0058b8f2d5e305.jpg';
  const series = card.series || card.anime || card.source || 'Unknown Series';
  const tier = card.tier || card.rarity || '?';
  openModal(`
    <div style="text-align: center;">
      <h2 style="margin-bottom:6px;">${escapeHTML(card.name || 'Unknown Card')}</h2>
      <p class="text-gold" style="font-weight: 700; margin-bottom: 12px;">${escapeHTML(series)} &bull; Tier ${escapeHTML(String(tier))}</p>
      <img src="${img}" style="width: 100%; max-width: 260px; border-radius: 12px; margin-bottom: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);"
           onerror="this.src='https://i.pinimg.com/736x/87/42/48/874248ef7273934f8a0058b8f2d5e305.jpg'"/>
      <div style="text-align: left; display:flex; flex-direction:column; gap:8px; background:rgba(255,255,255,0.02); padding:16px; border-radius:12px; border:1px solid var(--panel-border);">
        ${card.card_id ? `<div><strong>Card ID:</strong> <code>${escapeHTML(card.card_id)}</code></div>` : ''}
        <div><strong>Tier Rank:</strong> ${escapeHTML(String(tier))}</div>
        ${card.cp ? `<div><strong>Combat Power:</strong> ${card.cp}</div>` : ''}
        ${card.gender ? `<div><strong>Gender:</strong> ${escapeHTML(card.gender)}</div>` : ''}
      </div>
    </div>
  `);
}

window.viewPokemonDetails = async function(name) {
  openModal(`<h2>Loading Pokemon details...</h2>`);
  try {
    const res = await API.request(`/pokemon?q=${name}`);
    const pk = res.data;
    if (!pk) return closeModal();
    openModal(`
      <div style="text-align: center;">
        <h2 style="text-transform: capitalize;">${pk.displayName}</h2>
        <div class="pokemon-types" style="justify-content:center; margin-bottom:12px;">
          ${pk.types.map(t => `<span class="type-badge">${t}</span>`).join('')}
        </div>
        <img src="${pk.sprite || 'https://assets.pokemon.com/assets/cms2/img/pokedex/full/025.png'}" style="width: 100%; max-width: 180px; margin-bottom: 16px;"/>
        
        <div style="text-align: left; display:flex; flex-direction:column; gap:8px; background:rgba(255,255,255,0.02); padding:16px; border-radius:12px; border:1px solid var(--panel-border);">
          <div><strong>Dex ID:</strong> #${pk.id}</div>
          <div><strong>Stats:</strong></div>
          <div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:6px; font-size:0.85rem;">
            ${Object.entries(pk.stats).map(([k, v]) => `<div style="text-transform:capitalize;"><strong>${k}:</strong> ${v}</div>`).join('')}
          </div>
        </div>
      </div>
    `);
  } catch(e) { toast(e.message, 'error'); closeModal(); }
};

/* ───────────────────────────────────────────────────────────────
   TAB: GAMES / BATTLE
   ─────────────────────────────────────────────────────────────── */
function renderGames(container) {
  container.innerHTML = `
    <div class="games-hub">
      <!-- Work Jobs -->
      <div class="games-group">
        <h3 class="games-group-title"><svg class="icon-sm"><use href="#icon-sword"/></svg> Work Missions</h3>
        <div class="jobs-grid">
          <div class="job-card" onclick="playJob('fish')">
            <div class="job-icon"><svg><use href="#icon-fish"/></svg></div>
            <span class="job-name">Fish</span>
          </div>
          <div class="job-card" onclick="playJob('mine')">
            <div class="job-icon"><svg><use href="#icon-mine"/></svg></div>
            <span class="job-name">Mine</span>
          </div>
          <div class="job-card" onclick="playJob('dig')">
            <div class="job-icon"><svg><use href="#icon-dig"/></svg></div>
            <span class="job-name">Dig</span>
          </div>
          <div class="job-card" onclick="playJob('explore')">
            <div class="job-icon"><svg><use href="#icon-explore"/></svg></div>
            <span class="job-name">Explore</span>
          </div>
          <div class="job-card" onclick="playJob('crime')">
            <div class="job-icon"><svg><use href="#icon-crime"/></svg></div>
            <span class="job-name">Crime</span>
          </div>
        </div>
      </div>

      <!-- Mini Games -->
      <div class="games-group">
        <h3 class="games-group-title"><svg class="icon-sm"><use href="#icon-games"/></svg> Mini Games</h3>
        <div class="minigames-grid">
          <div class="game-card" onclick="showMiniGameModal('dice')">
            <svg class="game-card-icon"><use href="#icon-dice"/></svg>
            <span class="game-card-title">Dice Roll</span>
            <span class="game-card-multiplier">2x Pay</span>
          </div>
          <div class="game-card" onclick="showMiniGameModal('coin')">
            <svg class="game-card-icon"><use href="#icon-coin"/></svg>
            <span class="game-card-title">Coin Flip</span>
            <span class="game-card-multiplier">2x Pay</span>
          </div>
          <div class="game-card" onclick="showMiniGameModal('slots')">
            <svg class="game-card-icon"><use href="#icon-slots"/></svg>
            <span class="game-card-title">Slots</span>
            <span class="game-card-multiplier">4x Pay</span>
          </div>
          <div class="game-card" onclick="showMiniGameModal('basket')">
            <svg class="game-card-icon"><use href="#icon-bolt"/></svg>
            <span class="game-card-title">Basketball</span>
            <span class="game-card-multiplier">2x Pay</span>
          </div>
        </div>
      </div>

      <!-- Squad management panel -->
      <div class="panel squad-panel" id="squad-details-panel">
        <!-- Rendered by loadSquadPanel() -->
      </div>
    </div>
  `;

  loadSquadPanel();
}

async function playJob(jobKey) {
  openModal(`
    <div class="text-center" style="padding: 20px 0;">
      <h2>Initiating ${jobKey.toUpperCase()} job...</h2>
      <p class="text-muted">Venturing into the Clover Kingdom wildlands...</p>
      <div class="roll-animation">🔮</div>
    </div>
  `);
  
  try {
    const res = await API.request('/work', 'POST', { job: jobKey });
    if (res.ok) {
      const data = res.data;
      openModal(`
        <div class="text-center">
          <h2>${data.success ? '🏆 Job Succeeded!' : '❌ Job Failed'}</h2>
          <div class="roll-animation">${data.success ? '💰' : '💀'}</div>
          <p style="margin-bottom: 20px; font-size:1.1rem;">${escapeHTML(data.message)}</p>
          <button class="btn btn-primary" onclick="closeModal()">Collect Reward</button>
        </div>
      `);
      fetchAllUserData();
    }
  } catch(e) {
    toast(e.message, 'error');
    closeModal();
  }
}

window.showMiniGameModal = function(game) {
  if (game === 'dice') {
    openModal(`
      <h2>Dice Game</h2>
      <p class="text-muted" style="margin-bottom: 16px;">Predict the number (1-6) rolled by the magic die.</p>
      <div class="form-group">
        <label>Enter Bet (Yul)</label>
        <input type="number" id="game-bet" placeholder="Bet amount" min="10" value="100" style="width:100%;"/>
      </div>
      <div class="form-group">
        <label>Your Prediction (1-6)</label>
        <select id="game-prediction" class="btn btn-secondary" style="width:100%;">
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
          <option value="5">5</option>
          <option value="6">6</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary btn-sm" id="btn-play-game">ROLL DICE</button>
      </div>
    `);
  } else if (game === 'coin') {
    openModal(`
      <h2>Coin Flip</h2>
      <p class="text-muted" style="margin-bottom: 16px;">Flip a golden Yul coin to win double.</p>
      <div class="form-group">
        <label>Enter Bet (Yul)</label>
        <input type="number" id="game-bet" placeholder="Bet amount" min="10" value="100" style="width:100%;"/>
      </div>
      <div class="form-group">
        <label>Side Choice</label>
        <select id="game-choice" class="btn btn-secondary" style="width:100%;">
          <option value="heads">Heads</option>
          <option value="tails">Tails</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary btn-sm" id="btn-play-game">FLIP COIN</button>
      </div>
    `);
  } else if (game === 'slots') {
    openModal(`
      <h2>Slot Machine</h2>
      <p class="text-muted" style="margin-bottom: 16px;">Match 3 slot icons to win 4x payout.</p>
      <div class="form-group">
        <label>Enter Bet (Yul)</label>
        <input type="number" id="game-bet" placeholder="Bet amount" min="10" value="100" style="width:100%;"/>
      </div>
      <div class="modal-actions">
        <button class="btn btn-accent btn-sm" id="btn-play-game">PULL LEVER</button>
      </div>
    `);
  } else if (game === 'basket') {
    openModal(`
      <h2>Basketball Shot</h2>
      <p class="text-muted" style="margin-bottom: 16px;">Take a free throw! Hit it to win 2x pay.</p>
      <div class="form-group">
        <label>Enter Bet (Yul)</label>
        <input type="number" id="game-bet" placeholder="Bet amount" min="10" value="100" style="width:100%;"/>
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary btn-sm" id="btn-play-game">SHOOT BALL</button>
      </div>
    `);
  }

  document.getElementById('btn-play-game').addEventListener('click', () => submitGame(game));
};

async function submitGame(game) {
  const bet = Number(document.getElementById('game-bet').value);
  if (!bet || bet < 10) return toast('Min bet is 10 Yul', 'error');
  
  const payload = { game, bet };
  if (game === 'dice') {
    payload.prediction = Number(document.getElementById('game-prediction').value);
  } else if (game === 'coin') {
    payload.choice = document.getElementById('game-choice').value;
  }

  openModal(`
    <div class="text-center" style="padding: 20px 0;">
      <h2>Rolling the reels...</h2>
      <div class="roll-animation">🎲</div>
    </div>
  `);

  try {
    const res = await API.request('/games/play', 'POST', payload);
    if (res.ok) {
      const data = res.data;
      let extraText = '';
      if (game === 'slots') {
        extraText = `<div class="roll-animation">${data.detail.reels.join(' ')}</div>`;
      } else if (game === 'dice') {
        extraText = `<div class="roll-animation">🎲 ${data.detail.roll}</div>`;
      } else if (game === 'coin') {
        extraText = `<div class="roll-animation">🪙 ${data.detail.flip.toUpperCase()}</div>`;
      }
      
      openModal(`
        <div class="text-center">
          <h2>${data.win ? '🎉 Double Win!' : '💸 Better Luck next time'}</h2>
          ${extraText}
          <p style="margin-bottom: 20px; font-size:1.1rem;">${escapeHTML(data.message)}</p>
          <button class="btn btn-primary" onclick="closeModal()">Close Panel</button>
        </div>
      `);
      fetchAllUserData();
    }
  } catch(e) {
    toast(e.message, 'error');
    closeModal();
  }
}

async function loadSquadPanel() {
  const container = document.getElementById('squad-details-panel');
  container.innerHTML = '<p class="text-muted text-center">Loading squad profile...</p>';
  try {
    const res = await API.request('/squad');
    const squad = res.data;
    
    if (!squad) {
      container.innerHTML = `
        <h3 class="games-group-title" style="margin-bottom: 12px;"><svg><use href="#icon-group"/></svg> Magic Squad</h3>
        <p class="text-muted" style="margin-bottom: 16px;">You are not in a Magic Knight squad. Join or create one!</p>
        <div class="claim-row">
          <input type="text" id="join-squad-id" placeholder="Enter Squad ID" style="padding: 8px 12px; border-radius: 8px; border:1px solid var(--panel-border); background:rgba(255,255,255,0.03); color:white;"/>
          <button class="btn btn-primary btn-sm" onclick="joinSquad()">Join Squad</button>
          <button class="btn btn-secondary btn-sm" onclick="createSquad()">Create New</button>
        </div>
      `;
      return;
    }

    let mRows = '';
    squad.members.forEach(m => {
      mRows += `
        <div class="squad-member-row">
          <span>${escapeHTML(m.name)}</span>
          <span class="squad-role role-${m.role}">${m.role}</span>
        </div>
      `;
    });

    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 class="games-group-title"><svg><use href="#icon-group"/></svg> Squad: ${escapeHTML(squad.name)}</h3>
        <span class="text-muted" style="font-size:0.8rem; font-weight:700;">ID: ${squad.id}</span>
      </div>
      
      <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:16px;">
        ${mRows}
      </div>

      <div class="claim-row">
        ${squad.captain === state.user.id ? `
          <button class="btn btn-danger btn-sm" onclick="disbandSquad()">Disband Squad</button>
        ` : `
          <button class="btn btn-danger btn-sm" onclick="leaveSquad()">Leave Squad</button>
        `}
      </div>
    `;
  } catch(e) { container.innerHTML = `<p class="text-red">Error: ${e.message}</p>`; }
}

window.joinSquad = async function() {
  const squadId = document.getElementById('join-squad-id').value;
  if (!squadId) return toast('Please enter a Squad ID', 'error');
  try {
    const res = await API.request('/squad/join', 'POST', { squadId });
    if (res.ok) {
      toast('Successfully joined squad!', 'success');
      loadSquadPanel();
    }
  } catch(e) { toast(e.message, 'error'); }
};

window.createSquad = async function() {
  const name = prompt('Enter squad name:');
  if (!name) return;
  try {
    const res = await API.request('/squad/create', 'POST', { name });
    if (res.ok) {
      toast(`Squad "${name}" created!`, 'success');
      loadSquadPanel();
    }
  } catch(e) { toast(e.message, 'error'); }
};

window.leaveSquad = async function() {
  if (!confirm('Leave current squad?')) return;
  try {
    await API.request('/squad/leave', 'POST');
    toast('Left squad.', 'success');
    loadSquadPanel();
  } catch(e) { toast(e.message, 'error'); }
};

window.disbandSquad = async function() {
  if (!confirm('Disband squad permanently?')) return;
  try {
    await API.request('/squad/disband', 'POST');
    toast('Squad disbanded.', 'success');
    loadSquadPanel();
  } catch(e) { toast(e.message, 'error'); }
};

/* ───────────────────────────────────────────────────────────────
   TAB: COMMUNITY
   ─────────────────────────────────────────────────────────────── */
let activeLbTab = 'levels';
function renderCommunity(container) {
  container.innerHTML = `
    <div class="community-grid">
      <div class="cards-tabs">
        <button class="cards-tab-btn ${activeLbTab === 'levels' ? 'active' : ''}" id="btn-lb-lvl">Level Rankings</button>
        <button class="cards-tab-btn ${activeLbTab === 'wealth' ? 'active' : ''}" id="btn-lb-wealth">Wealth Rankings</button>
      </div>

      <div class="panel">
        <table class="leaderboard-table">
          <thead>
            <tr id="lb-table-head">
              <!-- Handled dynamically -->
            </tr>
          </thead>
          <tbody id="leaderboard-rows">
            <!-- Loaded via API -->
          </tbody>
        </table>
      </div>

      <div class="panel">
        <h3 class="games-group-title" style="margin-bottom:12px;"><svg><use href="#icon-afk"/></svg> Kingdom Activity Log</h3>
        <div class="activity-feed" id="activity-logs">
          <!-- Loaded via API -->
        </div>
      </div>
    </div>
  `;

  // Attach handlers
  document.getElementById('btn-lb-lvl').addEventListener('click', () => {
    activeLbTab = 'levels';
    renderCommunity(container);
  });
  document.getElementById('btn-lb-wealth').addEventListener('click', () => {
    activeLbTab = 'wealth';
    renderCommunity(container);
  });

  loadLeaderboard();
  loadActivities();
}

async function loadLeaderboard() {
  const head = document.getElementById('lb-table-head');
  const rows = document.getElementById('leaderboard-rows');
  rows.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Calculating power level...</td></tr>';
  
  try {
    if (activeLbTab === 'levels') {
      head.innerHTML = `
        <th class="leaderboard-rank">Rank</th>
        <th>Magic Knight</th>
        <th>Squad</th>
        <th class="leaderboard-val">Level</th>
      `;
      const res = await API.request('/leaderboard');
      let html = '';
      res.data.forEach(item => {
        html += `
          <tr>
            <td class="leaderboard-rank rank-${item.rank}">#${item.rank}</td>
            <td class="leaderboard-user">${escapeHTML(item.name)}</td>
            <td><span class="text-muted">@${escapeHTML(item.username || 'knight')}</span></td>
            <td class="leaderboard-val text-purple">Lvl ${item.level}</td>
          </tr>
        `;
      });
      rows.innerHTML = html;
    } else {
      head.innerHTML = `
        <th class="leaderboard-rank">Rank</th>
        <th>Magic Knight</th>
        <th>Wallet</th>
        <th class="leaderboard-val">Total Wealth</th>
      `;
      const res = await API.request('/richest');
      let html = '';
      res.data.forEach(item => {
        html += `
          <tr>
            <td class="leaderboard-rank rank-${item.rank}">#${item.rank}</td>
            <td class="leaderboard-user">${escapeHTML(item.name)}</td>
            <td><span class="text-muted">${formatYul(item.balance)} Yul</span></td>
            <td class="leaderboard-val text-gold">${formatYul(item.wealth)} Yul</td>
          </tr>
        `;
      });
      rows.innerHTML = html;
    }
  } catch(e) { rows.innerHTML = `<tr><td colspan="4" class="text-red">Error: ${e.message}</td></tr>`; }
}

async function loadActivities() {
  const container = document.getElementById('activity-logs');
  try {
    const res = await API.request('/activity');
    let html = '';
    res.data.forEach(log => {
      const timeStr = new Date(log.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      html += `
        <div class="activity-item">
          <svg class="activity-icon icon-sm"><use href="#icon-bolt"/></svg>
          <div class="activity-text">${escapeHTML(log.text)}</div>
          <div class="activity-time">${timeStr}</div>
        </div>
      `;
    });
    container.innerHTML = html || '<p class="text-muted text-center">No kingdom activity logged.</p>';
  } catch(e) { container.innerHTML = `<p class="text-red">Error: ${e.message}</p>`; }
}

/* ───────────────────────────────────────────────────────────────
   TAB: ADMIN PANEL
   ─────────────────────────────────────────────────────────────── */
async function renderAdmin(container) {
  container.innerHTML = `<div class="text-center text-muted" style="padding: 40px 0;">Authorizing admin privilege...</div>`;
  try {
    const res = await API.request('/admin/stats');
    const stats = res.data;

    container.innerHTML = `
      <div>
        <div class="admin-grid">
          <div class="admin-stat">
            <span class="admin-stat-label">Total Magic Knights</span>
            <div class="admin-stat-val text-purple">${stats.totalUsers}</div>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-label">Total Bank Assets</span>
            <div class="admin-stat-val text-gold">${formatYul(stats.totalBank)} Yul</div>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-label">Total Gems Circulating</span>
            <div class="admin-stat-val text-blue">💎 ${stats.totalGems}</div>
          </div>
        </div>

        <div class="panel admin-controls">
          <h3 class="games-group-title"><svg><use href="#icon-settings"/></svg> User Management Panel</h3>
          
          <div class="form-group">
            <label>Target User (Telegram ID)</label>
            <input type="number" id="admin-target-id" placeholder="e.g. 12345678"/>
          </div>

          <div class="form-group">
            <label>Amount to Add (Yul)</label>
            <input type="number" id="admin-bal-amount" placeholder="e.g. 5000"/>
          </div>

          <div class="claim-row">
            <button class="btn btn-primary" onclick="adminAddBalance()">Grant Balance</button>
            <button class="btn btn-secondary" onclick="adminResetUser()">Reset Account</button>
          </div>
        </div>

        <div class="panel" style="margin-top: 20px;">
          <h3 class="games-group-title" style="margin-bottom: 12px;"><svg><use href="#icon-broadcast"/></svg> Global Announcements</h3>
          <div class="form-group">
            <label>Message Content</label>
            <textarea id="admin-broadcast-msg" rows="3" placeholder="Enter broadcast message..."></textarea>
          </div>
          <button class="btn btn-accent" onclick="adminBroadcast()">Send Broadcast</button>
        </div>
      </div>
    `;
  } catch(e) {
    container.innerHTML = `
      <div class="panel text-center">
        <h3 class="text-red">Access Denied</h3>
        <p class="text-muted" style="margin-top:8px;">You do not have administrative credentials to view this dashboard.</p>
      </div>
    `;
  }
}

window.adminAddBalance = async function() {
  const targetId = document.getElementById('admin-target-id').value;
  const amount = document.getElementById('admin-bal-amount').value;
  if (!targetId || !amount) return toast('Please fill all fields', 'error');
  try {
    await API.request('/admin/addbal', 'POST', { targetId, amount });
    toast('Wallet balance updated!', 'success');
  } catch(e) { toast(e.message, 'error'); }
};

window.adminResetUser = async function() {
  const targetId = document.getElementById('admin-target-id').value;
  if (!targetId) return toast('Target user ID required', 'error');
  if (!confirm('Are you sure you want to reset this user?')) return;
  try {
    await API.request('/admin/resetuser', 'POST', { targetId });
    toast('User successfully reset!', 'success');
  } catch(e) { toast(e.message, 'error'); }
};

window.adminBroadcast = async function() {
  const message = document.getElementById('admin-broadcast-msg').value;
  if (!message) return toast('Broadcast message empty', 'error');
  try {
    const res = await API.request('/admin/broadcast', 'POST', { message });
    toast(`Broadcast sent to ${res.data.sent} users!`, 'success');
  } catch(e) { toast(e.message, 'error'); }
};

/* ───────────────────────────────────────────────────────────────
   APP INITIALIZATION & AUTHENTICATION FLOW
   ─────────────────────────────────────────────────────────────── */
let CONFIG_DATA = {};
async function initApp() {
  // Load public config
  try {
    const cfgRes = await fetch('/api/config');
    const cfg = await cfgRes.json();
    CONFIG_DATA = cfg.data || {};
  } catch(e) { console.warn('Config failed to load'); }

  // Set up listeners
  initNavigation();
  
  document.getElementById('topbar-menu-btn').addEventListener('click', () => toggleDrawer(true));
  document.getElementById('drawer-close').addEventListener('click', () => toggleDrawer(false));
  document.getElementById('drawer-overlay').addEventListener('click', () => toggleDrawer(false));
  document.getElementById('topbar-bell').addEventListener('click', toggleCooldownPanel);
  document.getElementById('cd-panel-close').addEventListener('click', toggleCooldownPanel);
  document.getElementById('modal-close').addEventListener('click', closeModal);

  document.getElementById('btn-edit-email').addEventListener('click', () => {
    toggleDrawer(false);
    const email = prompt('Enter your Gmail address to link:', state.user.linkedEmail || '');
    if (email === null) return;
    API.request('/profile/email', 'POST', { email })
      .then(res => {
        state.user = res.data;
        toast('Linked email updated!', 'success');
      })
      .catch(e => toast(e.message, 'error'));
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    API.logout();
  });

  // Handle Login submission
  document.getElementById('login-btn').addEventListener('click', performLogin);
  document.getElementById('login-email').addEventListener('keyup', (e) => {
    if (e.key === 'Enter') performLogin();
  });

  // Check if session token or Telegram WebApp initData exists
  const tg = window.Telegram?.WebApp;
  if (tg) {
    // Initialize Telegram Mini App
    try {
      tg.ready();
      tg.expand();
    } catch(e) { console.warn('TMA init error:', e); }
  }

  const hasTmaData = isTelegramContext();
  const hasToken = !!API.token;

  if (hasTmaData || hasToken) {
    document.getElementById('main-app').classList.remove('hidden');
    await fetchAllUserData();
    
    // Auto show/hide admin tab depending on access
    try {
      const auth = await API.request('/admin/stats');
      if (auth.ok) {
        document.getElementById('nav-admin').classList.remove('hidden');
      }
    } catch(e) {}
  } else {
    document.getElementById('login-screen').classList.remove('hidden');
  }
}

async function performLogin() {
  const emailInput = document.getElementById('login-email');
  const errorEl = document.getElementById('login-error');
  const email = emailInput.value.trim();
  
  if (!email) {
    errorEl.textContent = 'Please enter an email address';
    errorEl.classList.remove('hidden');
    return;
  }

  errorEl.classList.add('hidden');
  document.getElementById('login-btn').disabled = true;

  try {
    const user = await API.login(email);
    toast(`Welcome Knight ${user.name}!`, 'success');
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    await fetchAllUserData();
    
    // Check if user is admin
    try {
      const auth = await API.request('/admin/stats');
      if (auth.ok) {
        document.getElementById('nav-admin').classList.remove('hidden');
      }
    } catch(e) {}
  } catch(e) {
    errorEl.textContent = e.message;
    errorEl.classList.remove('hidden');
  } finally {
    document.getElementById('login-btn').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', initApp);
