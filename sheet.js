// Talking to the Google Sheet (through the Apps Script web app in gas/Code.gs).
//
// The sheet is the source of truth. This module keeps a copy in memory so
// commands answer instantly, and appends to memory AND sheet on every write.

const b = require('./bounty');

// Apps Script cold starts can take 10–20 s.
const FETCH_TIMEOUT_MS = 45000;
const RETRY_DELAYS_MS = [2000, 6000];

let url = '';
let available = false;
let degraded = false;

const state = {
  bountyRows: [], drops: [], shopRows: [], approvers: [], rawSettings: {},
  submissions: [], points: [], purchases: []
};

// Derived (re-parsed whenever config changes).
let bounties = [];
let shop = [];
let settings = b.readSettings({});

function configure(sheetUrl) { url = String(sheetUrl || '').trim(); return Boolean(url); }

async function request(target, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'the sheet returned ok:false');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function applyConfig(body) {
  if (Array.isArray(body.bounties)) state.bountyRows = body.bounties;
  if (Array.isArray(body.drops)) state.drops = body.drops.filter(d => d.boss && d.item).map(d => ({ boss: String(d.boss).trim(), item: String(d.item).trim() }));
  if (Array.isArray(body.shop)) state.shopRows = body.shop;
  if (Array.isArray(body.approvers)) state.approvers = body.approvers.map(String);
  if (body.settings && typeof body.settings === 'object') state.rawSettings = body.settings;

  settings = b.readSettings(state.rawSettings);
  // Keep posting info the bot wrote but the sheet read may not show yet.
  const previous = new Map(bounties.map(x => [x.weekOf, x]));
  bounties = b.parseBounties(state.bountyRows, state.drops).map(row => {
    const old = previous.get(row.weekOf);
    if (old && old.postedAt && !row.postedAt) return { ...row, postedAt: old.postedAt, messageId: old.messageId };
    return row;
  });
  shop = b.parseShop(state.shopRows);
}

function warnings() {
  const out = [];
  for (const x of bounties) for (const w of x.warnings) out.push(`Bounty ${x.weekOf} (${x.boss}): ${w}`);
  for (const x of bounties) if (x.active && !x.parts.length) out.push(`Bounty ${x.weekOf} (${x.boss}) has no parts filled in`);
  return out;
}

async function loadAll() {
  if (!url) { console.error('❌ No SHEET_URL set.'); return false; }
  try {
    const body = await request(`${url}?type=all`);
    applyConfig(body);
    state.submissions = body.submissions || [];
    state.points = body.points || [];
    state.purchases = body.purchases || [];
    available = true;
    degraded = false;
    console.log(`✅ Sheet loaded: ${bounties.length} bounties, ${state.drops.length} drops, ${shop.length} shop items, ` +
      `${state.approvers.length} approvers, ${state.submissions.length} submissions, ${state.points.length} points rows.`);
    warnings().forEach(w => console.warn(`⚠️ ${w}`));
    return true;
  } catch (err) {
    available = false;
    console.error(`❌ Could not read the sheet: ${err.message}`);
    return false;
  }
}

async function refreshConfig() {
  if (!url) return false;
  try {
    applyConfig(await request(`${url}?type=config`));
    available = true;
    return true;
  } catch (err) {
    console.error(`⚠️ Config refresh failed (keeping last values): ${err.message}`);
    return false;
  }
}

async function post(payload, { retry = false } = {}) {
  if (!url) return { ok: false, error: 'no sheet configured' };
  const attempts = retry ? RETRY_DELAYS_MS.length + 1 : 1;
  let lastError;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[i - 1]));
    try {
      return await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (err) {
      lastError = err;
      console.error(`⚠️ Sheet write "${payload.action}" failed (attempt ${i + 1}): ${err.message}`);
    }
  }
  if (retry) {
    degraded = true;
    console.error(`❌ Sheet write lost on restart: ${JSON.stringify(payload)}`);
  }
  return { ok: false, error: lastError?.message || 'failed' };
}

let opCounter = 0;
const newOpId = () => `${Date.now().toString(36)}-${(opCounter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Log rows: added to memory first, then written with retries. */
async function addSubmission(row) {
  state.submissions.push(row);
  return post({ action: 'submission', row }, { retry: true });
}

async function addPoints(row) {
  const full = { opId: newOpId(), ...row };
  state.points.push(full);
  return post({ action: 'points', row: full }, { retry: true });
}

/** Buying is checked and written by the sheet in one locked step (stock + wallet). */
async function buy({ item, player, playerId }) {
  const res = await post({ action: 'buy', item, player, playerId, time: Date.now(), opId: newOpId() });
  if (res.ok) {
    state.purchases.push(res.purchase);
    state.points.push(res.points);
    const row = state.shopRows.find(r => String(r.item).trim().toLowerCase() === String(res.purchase.item).trim().toLowerCase());
    if (row && res.stockLeft !== null && res.stockLeft !== undefined) row.stock = res.stockLeft;
    shop = b.parseShop(state.shopRows);
  }
  return res;
}

async function markPosted(weekOf, postedAt, messageId, codeWord = "") {
  const bounty = bounties.find(x => x.weekOf === weekOf);
  if (bounty) { bounty.postedAt = postedAt; bounty.messageId = messageId; bounty.codeWord = bounty.codeWord || codeWord; }
  const row = state.bountyRows.find(r => String(r.weekOf) === weekOf);
  if (row) { row.postedAt = postedAt; row.messageId = messageId; row.codeWord = row.codeWord || codeWord; }
  return post({ action: "bountyPosted", weekOf, postedAt, messageId, codeWord }, { retry: true });
}

async function setPurchaseMessage(id, adminMessageId) {
  const p = state.purchases.find(x => x.id === id);
  if (p) p.adminMessageId = adminMessageId;
  return post({ action: 'purchaseMessage', id, adminMessageId }, { retry: true });
}

async function setPurchaseDelivered(id, deliveredBy) {
  const p = state.purchases.find(x => x.id === id);
  const deliveredAt = Date.now();
  if (p) { p.deliveredBy = deliveredBy; p.deliveredAt = deliveredAt; }
  return post({ action: 'purchaseDelivered', id, deliveredBy, deliveredAt }, { retry: true });
}

async function setSetting(key, value) {
  state.rawSettings[key] = value;
  settings = b.readSettings(state.rawSettings);
  return post({ action: 'setting', key, value }, { retry: true });
}

const writePlayers = rows => post({ action: 'players', rows });

module.exports = {
  configure, loadAll, refreshConfig, warnings,
  addSubmission, addPoints, buy, markPosted, setPurchaseMessage, setPurchaseDelivered, setSetting, writePlayers,
  isAvailable: () => available,
  isDegraded: () => degraded,
  getBounties: () => bounties,
  getShop: () => shop,
  getSettings: () => settings,
  getDrops: () => state.drops,
  getSubmissions: () => state.submissions,
  getPoints: () => state.points,
  getPurchases: () => state.purchases,
  isApproverId: id => state.approvers.includes(String(id))
};
