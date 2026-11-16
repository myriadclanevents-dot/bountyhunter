// Bounty Hunter rules — all pure functions, no Discord and no sheet.
//
// Everything the bot shows is DERIVED from three append-only logs in the sheet
// (Submissions, Points, Purchases) plus the reference tabs. Nothing is stored
// on the server, so a restart or redeploy loses nothing.

const { sameItemName } = require('./matching');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Points row types.
const TYPE_FIRST = 'first claim';
const TYPE_CLAIM = 'claim';
const TYPE_SHOP = 'shop';
const TYPE_ADMIN = 'admin';
const TYPE_VOID = 'void';
const TYPE_WHEEL = 'wheel'; // spin cost (−) and points won (+): wallet only, never leaderboards

// Types that move the wallet but never count as "earned".
const WALLET_ONLY = new Set([TYPE_SHOP, TYPE_WHEEL]);
const walletOnly = p => WALLET_ONLY.has(String(p.type ?? '').trim().toLowerCase());

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const str = v => String(v ?? '').replace(/^'/, '').trim();

/** Number from a sheet cell. Accepts "1,5" (Spanish-locale decimals). */
function num(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

const clampHour = h => Math.min(23, Math.max(0, Math.floor(h)));

function readSettings(raw = {}) {
  let from = clampHour(num(raw.Post_Hour_From, 0));
  let to = clampHour(num(raw.Post_Hour_To, 23));
  if (from > to) [from, to] = [to, from];

  return {
    submissionsChannelId: str(raw.Submissions_Channel_ID),
    boardChannelId: str(raw.Board_Channel_ID),
    awardsChannelId: str(raw.Awards_Channel_ID),
    shopAdminChannelId: str(raw.Shop_Admin_Channel_ID),
    approveEmoji: str(raw.Approve_Emoji) || '✅',
    defaultFirst: num(raw.Default_First_Points, 10),
    defaultLater: num(raw.Default_Later_Points, 5),
    multiplier: Math.max(1, num(raw.Multiplier, 2)),
    multiplierAfterHours: Math.max(0, num(raw.Multiplier_After_Hours, 72)),
    postHourFrom: from,
    postHourTo: to,
    lateClaimHours: Math.max(0, num(raw.Late_Claim_Hours, 0)),
    lastMonthlyPost: str(raw.Last_Monthly_Post),
    wheelChannelId: str(raw.Wheel_Channel_ID)
  };
}

// ---------------------------------------------------------------------------
// Dates (everything is UTC)
// ---------------------------------------------------------------------------

const isoDate = ms => new Date(ms).toISOString().slice(0, 10);
const dayMs = iso => Date.parse(`${iso}T00:00:00Z`);

/** The Monday (UTC) of the week containing `ms`, as YYYY-MM-DD. */
function mondayOf(ms) {
  const d = new Date(ms);
  const back = (d.getUTCDay() + 6) % 7;
  return isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
}

const monthKey = ms => new Date(ms).toISOString().slice(0, 7);

function monthRange(ms) {
  const d = new Date(ms);
  const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { from, to };
}

/** FNV-1a: a stable hash, so a restart picks the same "random" time. */
function hash(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * When the bounty for a week goes up: a random hour (and minute) on its Monday,
 * between Post_Hour_From and Post_Hour_To (UTC). Derived from the date, so the
 * bot can restart any number of times and still post at the same moment.
 */
function scheduledPostTime(weekOf, settings) {
  const h = hash(`bounty:${weekOf}`);
  const span = settings.postHourTo - settings.postHourFrom + 1;
  const hour = settings.postHourFrom + (h % span);
  const minute = (h >>> 8) % 60;
  return dayMs(weekOf) + hour * HOUR + minute * MINUTE;
}

// ---------------------------------------------------------------------------
// Code words (proof the screenshot was taken while the bounty was live)
// ---------------------------------------------------------------------------

const CODE_WORDS = [
  'Ember', 'Wyvern', 'Phoenix', 'Kraken', 'Raptor', 'Obsidian', 'Cinder', 'Tempest', 'Gargoyle', 'Basilisk',
  'Hydra', 'Chimera', 'Spectre', 'Lantern', 'Anvil', 'Falcon', 'Thunder', 'Glacier', 'Volcano', 'Comet',
  'Meteor', 'Serpent', 'Talon', 'Warden', 'Bastion', 'Harpy', 'Griffin', 'Ironclad', 'Nightfall', 'Starlight',
  'Bonfire', 'Wildfire', 'Frostbite', 'Moonstone', 'Duskwing', 'Thornback', 'Cobalt', 'Sunspear', 'Bramble', 'Halberd'
];

/**
 * The bot's own code word for a week, e.g. "Wyvern37". Derived from the week
 * and a SECRET salt, so it is the same after a restart but can't be guessed
 * before the bounty is posted. An admin-typed Code Word always wins.
 */
function codeWordFor(weekOf, salt) {
  const h = hash(`code:${salt}:${weekOf}`);
  return `${CODE_WORDS[h % CODE_WORDS.length]}${10 + ((h >>> 12) % 90)}`;
}

// ---------------------------------------------------------------------------
// Bounties and their parts
// ---------------------------------------------------------------------------

/**
 * One Part cell → what counts for it.
 *
 *   "Kerapac"                         any one Kerapac drop (from the Drops tab)
 *   "Spider leg top, Araxxi's eye"    any one of these items
 *   "2 of: Kerapac, Nex"              any 2 DIFFERENT items, mixed from both bosses
 *
 * A name that is a boss in the Drops tab expands to all its drops; anything
 * else is taken as an item name.
 */
function parsePart(raw, drops = []) {
  const text = str(raw);
  if (!text) return null;

  let need = 1;
  let rest = text;
  const m = /^(\d+)\s*(?:of|x|×)?\s*:\s*(.*)$/i.exec(text);
  if (m) {
    need = Math.max(1, parseInt(m[1], 10));
    rest = m[2];
  }

  const items = [];
  const sources = [];
  const addItem = name => {
    if (!items.some(x => sameItemName(x, name))) items.push(name);
  };

  for (const token of rest.split(',').map(s => s.trim()).filter(Boolean)) {
    const bossDrops = drops.filter(d => sameItemName(d.boss, token));
    if (bossDrops.length) {
      sources.push({ boss: bossDrops[0].boss, count: bossDrops.length });
      bossDrops.forEach(d => addItem(d.item));
    } else {
      sources.push({ item: token });
      addItem(token);
    }
  }

  const warnings = [];
  if (!items.length) warnings.push(`part "${text}" lists no items`);
  if (need > items.length && items.length) {
    warnings.push(`part "${text}" needs ${need} different items but only lists ${items.length}`);
    need = items.length;
  }

  return { raw: text, need, items, sources, warnings };
}

/** Human wording for a part, as shown in Discord. */
function describePart(part) {
  const label = s => (s.boss ? `any ${s.boss} drop` : s.item);
  if (part.sources.length === 1 && part.need === 1) {
    const only = label(part.sources[0]);
    return only.charAt(0).toUpperCase() + only.slice(1);
  }
  const lead = part.need === 1 ? 'One of' : `${part.need} different items from`;
  const list = part.sources.map(s => (s.boss ? `any ${s.boss} drop` : s.item)).join(', ');
  return `${lead}: ${list}`;
}

function parseBounty(row, drops) {
  const parts = (row.parts || []).map(p => parsePart(p, drops)).filter(Boolean);
  return {
    ...row,
    weekOf: str(row.weekOf),
    boss: str(row.boss) || 'Bounty',
    parts,
    firstPoints: num(row.firstPoints, null),
    laterPoints: num(row.laterPoints, null),
    active: row.active === true || /^(true|yes|1|x|✓|✔)$/i.test(str(row.active)),
    postedAt: Number(row.postedAt) || null,
    messageId: str(row.messageId),
    codeWord: str(row.codeWord),
    warnings: parts.flatMap(p => p.warnings)
  };
}

const parseBounties = (rows, drops) => (rows || []).map(r => parseBounty(r, drops));

/** Posted bounties, oldest first. */
const postedBounties = bounties =>
  bounties.filter(b => b.postedAt).sort((a, b) => a.postedAt - b.postedAt);

/** The live bounty: the one posted most recently. */
function currentBounty(bounties) {
  const posted = postedBounties(bounties);
  return posted[posted.length - 1] || null;
}

/** When a posted bounty stops taking claims (Infinity while it is current). */
function closesAt(bounties, bounty, settings) {
  const posted = postedBounties(bounties);
  const next = posted.find(b => b.postedAt > bounty.postedAt);
  return next ? next.postedAt + settings.lateClaimHours * HOUR : Infinity;
}

/** Posted bounties still taking claims, newest first. */
function openBounties(bounties, now, settings) {
  return postedBounties(bounties)
    .filter(b => now < closesAt(bounties, b, settings))
    .reverse();
}

/** The bounty that should go up now, if any (this Monday's, not yet posted, time reached). */
function dueBounty(bounties, now, settings) {
  const weekOf = mondayOf(now);
  const row = bounties.find(b => b.weekOf === weekOf && b.active && !b.postedAt);
  if (!row) return null;
  return now >= scheduledPostTime(weekOf, settings) ? row : null;
}

/** For /bhpost: this week's unposted bounty, else the next one coming up. */
function nextUnposted(bounties, now) {
  const thisMonday = mondayOf(now);
  return bounties
    .filter(b => b.active && !b.postedAt && b.weekOf >= thisMonday && b.parts.length)
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf))[0] || null;
}

// ---------------------------------------------------------------------------
// Submissions → progress
// ---------------------------------------------------------------------------

/** Approved, not-voided submission rows. The LAST row for a message wins. */
function activeSubmissions(submissions) {
  const byMessage = new Map();
  for (const s of submissions || []) {
    const id = str(s.messageId);
    if (id) byMessage.set(id, s);
  }
  return [...byMessage.values()].filter(s => str(s.status).toLowerCase() === 'approved');
}

/** Whether a Discord message currently counts as an approved part. */
const isMessageApproved = (submissions, messageId) =>
  activeSubmissions(submissions).some(s => str(s.messageId) === str(messageId));

/** One player's progress on each part of a bounty. */
function progressFor(bounty, active, playerId) {
  const mine = active.filter(s => str(s.weekOf) === bounty.weekOf && str(s.playerId) === str(playerId));
  return bounty.parts.map((part, i) => {
    const rows = mine.filter(s => Number(s.part) === i + 1);
    const items = rows.map(s => s.item);
    return { index: i + 1, part, items, rows, done: items.length >= part.need };
  });
}

const isComplete = progress => progress.length > 0 && progress.every(p => p.done);

/**
 * Which part a newly approved item goes to: the first part that lists it,
 * isn't finished yet, and doesn't already hold that same item (parts need
 * DIFFERENT items). Returns { index } or { error }.
 */
function assignPart(progress, itemName) {
  let error = 'not-in-bounty';
  for (const p of progress) {
    if (!p.part.items.some(x => sameItemName(x, itemName))) continue;
    if (p.items.some(x => sameItemName(x, itemName))) { error = 'duplicate'; continue; }
    if (p.done) { if (error === 'not-in-bounty') error = 'part-done'; continue; }
    return { index: p.index };
  }
  return { error };
}

/** All items any part of the bounty accepts, for matching typed text. */
const bountyItems = bounty => {
  const out = [];
  for (const p of bounty.parts) for (const it of p.items) {
    if (!out.some(x => sameItemName(x, it))) out.push(it);
  }
  return out;
};

/** Players with at least one approved part but no claim yet. */
function inProgressCount(bounty, active, claims) {
  const claimed = new Set(claims.map(c => str(c.playerId)));
  const started = new Set(active
    .filter(s => str(s.weekOf) === bounty.weekOf)
    .map(s => str(s.playerId)));
  return [...started].filter(id => !claimed.has(id)).length;
}

// ---------------------------------------------------------------------------
// Points → claims, balances, leaderboards
// ---------------------------------------------------------------------------

const claimRef = (weekOf, playerId) => `claim:${weekOf}:${playerId}`;

/** Points rows with duplicate Op IDs removed (a retried write can land twice). */
function uniquePoints(points) {
  const seen = new Set();
  return (points || []).filter(p => {
    const op = str(p.opId);
    if (!op) return true;
    if (seen.has(op)) return false;
    seen.add(op);
    return true;
  });
}

/**
 * Claims that still stand (not voided), oldest first. Optionally for one week.
 * A claim's ref is claim:<week>:<player>; a void row with the same ref cancels it.
 */
function activeClaims(points, weekOf = null) {
  const byRef = new Map();
  for (const p of uniquePoints(points)) {
    const ref = str(p.ref);
    if (!ref.startsWith('claim:')) continue;
    if (weekOf && str(p.weekOf) !== weekOf) continue;
    const entry = byRef.get(ref) || { n: 0, row: null };
    const type = str(p.type).toLowerCase();
    if (type === TYPE_FIRST || type === TYPE_CLAIM) { entry.n++; entry.row = p; }
    else if (type === TYPE_VOID) entry.n--;
    byRef.set(ref, entry);
  }
  return [...byRef.values()]
    .filter(e => e.n > 0 && e.row)
    .map(e => e.row)
    .sort((a, b) => Number(a.time) - Number(b.time));
}

const baseFirst = (bounty, s) => bounty.firstPoints ?? s.defaultFirst;
const baseLater = (bounty, s) => bounty.laterPoints ?? s.defaultLater;

/** When the multiplier switches on for a bounty (ms), or null if it never does. */
function multiplierStartsAt(bounty, settings) {
  if (!bounty.postedAt || settings.multiplier === 1) return null;
  return bounty.postedAt + settings.multiplierAfterHours * HOUR;
}

/** Whether the first claim is multiplied at moment `at`, given how many claims exist. */
function multiplierActive(bounty, settings, claimCount, at) {
  const start = multiplierStartsAt(bounty, settings);
  return claimCount === 0 && start !== null && at >= start;
}

/**
 * Points for a claim. The multiplier is judged at `completedAt` — when the
 * screenshot that finished the bounty was POSTED, not when it was approved,
 * so a slow approver never costs anyone the bonus.
 */
function claimPoints(bounty, settings, { isFirst, completedAt }) {
  if (!isFirst) return { points: baseLater(bounty, settings), multiplied: false, base: baseLater(bounty, settings) };
  const base = baseFirst(bounty, settings);
  const multiplied = multiplierActive(bounty, settings, 0, completedAt);
  return { points: multiplied ? Math.round(base * settings.multiplier) : base, multiplied, base };
}

/** Wallet (spendable), earned (never counts shopping) and earned this month. */
function balances(points, playerId, now) {
  const { from, to } = monthRange(now);
  let wallet = 0, earned = 0, month = 0;
  for (const p of uniquePoints(points)) {
    if (str(p.playerId) !== str(playerId)) continue;
    const change = num(p.change, 0);
    wallet += change;
    if (walletOnly(p)) continue;
    earned += change;
    const t = Number(p.time);
    if (t >= from && t < to) month += change;
  }
  return { wallet, earned, month };
}

/** Latest known display name per player id. */
function playerNames(points) {
  const names = new Map();
  for (const p of points || []) if (str(p.playerId) && str(p.player)) names.set(str(p.playerId), str(p.player));
  return names;
}

/**
 * Leaderboard rows for a period (default all time), best first.
 * Ranked by points earned; shop spending never counts against anyone.
 */
function standings(points, { from = -Infinity, to = Infinity } = {}) {
  const names = playerNames(points);
  const map = new Map();
  const get = id => {
    if (!map.has(id)) map.set(id, { playerId: id, player: names.get(id) || id, points: 0, claims: 0, firsts: 0 });
    return map.get(id);
  };

  for (const p of uniquePoints(points)) {
    if (walletOnly(p)) continue;
    const t = Number(p.time);
    if (!(t >= from && t < to)) continue;
    get(str(p.playerId)).points += num(p.change, 0);
  }
  for (const c of activeClaims(points)) {
    const t = Number(c.time);
    if (!(t >= from && t < to)) continue;
    const e = get(str(c.playerId));
    e.claims++;
    if (str(c.type).toLowerCase() === TYPE_FIRST) e.firsts++;
  }

  return [...map.values()]
    .filter(e => e.points !== 0 || e.claims > 0)
    .sort((a, b) => b.points - a.points || b.firsts - a.firsts || b.claims - a.claims ||
      a.player.localeCompare(b.player));
}

const rankOf = (rows, playerId) => {
  const i = rows.findIndex(r => r.playerId === str(playerId));
  return i === -1 ? null : i + 1;
};

/** The Players tab summary, one row per player who has ever had points. */
function playerSummary(points, now) {
  const all = standings(points);
  const ids = new Set([...playerNames(points).keys()]);
  const names = playerNames(points);
  return [...ids].map(id => {
    const b = balances(points, id, now);
    const s = all.find(r => r.playerId === id) || { claims: 0, firsts: 0 };
    return { player: names.get(id) || id, playerId: id, wallet: b.wallet, earned: b.earned, month: b.month, claims: s.claims, firsts: s.firsts };
  }).sort((a, b) => b.earned - a.earned || a.player.localeCompare(b.player));
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

function parseShop(rows) {
  return (rows || []).map(r => {
    const stockRaw = str(r.stock);
    return {
      item: str(r.item),
      cost: num(r.cost, 0),
      stock: stockRaw === '' ? null : num(stockRaw, null),
      active: r.active === true || /^(true|yes|1|x|✓|✔)$/i.test(str(r.active)),
      description: str(r.description),
      // "wheel" in Delivered How = buying it spins the prize wheel.
      isWheel: /^wheel$/i.test(str(r.deliveredHow))
    };
  }).filter(r => r.item && r.cost > 0);
}

const inStock = item => item.stock === null || item.stock > 0;

// ---------------------------------------------------------------------------
// Prize wheel
// ---------------------------------------------------------------------------

const WHEEL_KINDS = ['points', 'item', 'nothing'];

/**
 * Wheel tab rows → prizes. Weight is relative (weights 40/10/1 = 40:10:1).
 * Kind: "points" (added to the wallet automatically), "item" (an admin delivers it)
 * or "nothing". Empty Kind = points when Points > 0, otherwise item.
 */
function parseWheel(rows) {
  return (rows || []).map(r => {
    const points = Math.max(0, Math.round(num(r.points, 0)));
    let kind = str(r.kind).toLowerCase();
    if (!WHEEL_KINDS.includes(kind)) kind = points > 0 ? 'points' : 'item';
    if (kind === 'points' && points <= 0) kind = 'nothing';
    const activeRaw = str(r.active);
    return {
      prize: str(r.prize),
      weight: Math.max(0, num(r.weight, 0)),
      points: kind === 'points' ? points : 0,
      kind,
      active: activeRaw === '' || r.active === true || /^(true|yes|1|x|✓|✔)$/i.test(activeRaw),
      description: str(r.description)
    };
  }).filter(p => p.prize && p.weight > 0 && p.active);
}

/** Chance of each prize in percent (same order). */
function wheelOdds(prizes) {
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  return prizes.map(p => (total ? (p.weight / total) * 100 : 0));
}

/** Weighted pick. `rand` returns a number in [0, 1). Returns the prize index. */
function pickPrize(prizes, rand = Math.random) {
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let r = rand() * total;
  for (let i = 0; i < prizes.length; i++) {
    r -= prizes[i].weight;
    if (r < 0) return i;
  }
  return prizes.length - 1;
}

// How far the pointer jumps on each edit, and the wait before each edit (ms).
// Discord allows ~5 edits per 5 s per channel, so never go below 1000 ms.
const SPIN_STEPS = [3, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const SPIN_DELAYS = [1000, 1000, 1000, 1000, 1100, 1200, 1400, 1700, 2000, 2400];

/**
 * Frames for the message-edit animation: the pointer starts somewhere random
 * and the LAST frame lands on `winner`. Returns { start, frames: [{ index, delay }] }.
 */
function spinPlan(count, winner, rand = Math.random) {
  const extra = count > 1 ? Math.floor(rand() * count) : 0; // so the start doesn't give the winner away
  const steps = SPIN_STEPS.map((s, i) => (i === 0 ? s + extra : s));
  const total = steps.reduce((a, s) => a + s, 0);
  const start = (((winner - total) % count) + count) % count;
  let index = start;
  const frames = steps.map((s, i) => {
    index = (index + s) % count;
    return { index, delay: SPIN_DELAYS[i] };
  });
  return { start, frames };
}

// ---------------------------------------------------------------------------
// Discord helpers that are still pure
// ---------------------------------------------------------------------------

/** Message id from a Discord message link or a bare id. */
function messageIdFrom(text) {
  const t = str(text);
  const link = /channels\/\d+\/\d+\/(\d{15,22})/.exec(t);
  if (link) return link[1];
  return /^\d{15,22}$/.test(t) ? t : null;
}

module.exports = {
  HOUR, DAY, TYPE_FIRST, TYPE_CLAIM, TYPE_SHOP, TYPE_ADMIN, TYPE_VOID, TYPE_WHEEL,
  parseWheel, wheelOdds, pickPrize, spinPlan,
  num, readSettings,
  isoDate, dayMs, mondayOf, monthKey, monthRange, hash, scheduledPostTime, CODE_WORDS, codeWordFor,
  parsePart, describePart, parseBounty, parseBounties,
  postedBounties, currentBounty, closesAt, openBounties, dueBounty, nextUnposted,
  activeSubmissions, isMessageApproved, progressFor, isComplete, assignPart, bountyItems, inProgressCount,
  claimRef, uniquePoints, activeClaims, multiplierStartsAt, multiplierActive, claimPoints,
  balances, playerNames, standings, rankOf, playerSummary,
  parseShop, inStock, messageIdFrom
};
