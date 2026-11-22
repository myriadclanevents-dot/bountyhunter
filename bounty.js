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
const TYPE_DONATION = 'donation'; // points given to the clan (−): wallet only
const TYPE_GIFT = 'gift'; // points sent (−) / received (+): wallet only, so gifts can't boost a rank
const TYPE_SPONSOR = 'sponsor'; // stake on a bounty pot (−) and pot won/refunded (+): wallet only
const TYPE_DUEL = 'duel'; // duel stake (−) and pot won/refunded (+): wallet only

// Types that move the wallet but never count as "earned".
const TYPE_PRIZE = 'gp prize'; // 0-point record of a Grand Bounty / monthly draw GP win (see prizes.js)
const WALLET_ONLY = new Set([TYPE_SHOP, TYPE_WHEEL, TYPE_DONATION, TYPE_GIFT, TYPE_SPONSOR, TYPE_DUEL, TYPE_PRIZE]);
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
    // Posted bounties shut by hand (History Week Of dates, comma separated). They take no claims,
    // /bhbounty doesn't show them, but they still count as that week's post (no early new bounty).
    closedWeeks: closedWeeksFrom(raw.Closed_Bounties),
    lastMonthlyPost: str(raw.Last_Monthly_Post),
    wheelChannelId: str(raw.Wheel_Channel_ID),
    adminLogChannelId: str(raw.Admin_Log_Channel_ID) || str(raw.Shop_Admin_Channel_ID),
    // Random order: a boss can't come back until this many weeks have passed.
    repeatCooldownWeeks: Math.max(0, Math.floor(num(raw.Repeat_Cooldown_Weeks, 8))),
    // "Pick next week's bounty": how many bounties the buyer chooses from (Discord allows 25 max).
    pickOptions: Math.min(25, Math.max(1, Math.floor(num(raw.Pick_Options, 20)))),
    // Most points one player can gift per week (Monday 00:00 UTC to Sunday). 0 = gifts off.
    giftWeeklyLimit: Math.max(0, Math.floor(num(raw.Gift_Weekly_Limit, 25))),
    // Most points in one sponsorship / one duel stake.
    sponsorMax: Math.max(1, Math.floor(num(raw.Sponsor_Max, 50))),
    duelMaxStake: Math.max(1, Math.floor(num(raw.Duel_Max_Stake, 25))),
    // Written by the bot: where the clan goal's count starts, and a bought code word.
    goalBase: num(raw.Clan_Goal_Base, null),
    nextCodeWord: str(raw.Next_Code_Word),
    nextCodeWordWeek: str(raw.Next_Code_Word_Week),
    // Grand Bounty (M GP, paid in game): bounties with First Points >= grandMinFirst. 0 = off.
    grandPrize: Math.max(0, num(raw.Grand_Bounty_Prize, 150)),
    grandRollover: Math.max(0, num(raw.Grand_Bounty_Rollover, 50)),
    grandMax: Math.max(0, num(raw.Grand_Bounty_Max, 300)),
    grandMinFirst: Math.max(1, num(raw.Grand_Bounty_Min_First_Points, 100)),
    grandSince: num(raw.Grand_Bounty_Since, null), // written by the bot on first start
    // Monthly draw (M GP, paid in game): 1 ticket per claim. 0 = off.
    drawPrize: Math.max(0, num(raw.Monthly_Draw_Prize, 100)),
    drawSince: num(raw.Monthly_Draw_Since, null), // written by the bot on first start
    // Role pings: a new bounty always pings Bounty_Ping_Role_ID (if set); the two others only when TRUE.
    pingRoleId: (str(raw.Bounty_Ping_Role_ID).match(/\d{5,}/) || [''])[0],
    pingOnMultiplier: /^(true|yes|1|x|✓|✔)$/i.test(str(raw.Ping_On_Multiplier)),
    pingOnFirstClaim: /^(true|yes|1|x|✓|✔)$/i.test(str(raw.Ping_On_First_Claim)),
    // Self-service role: react with Role_Emoji on Role_Message (a message link) to get Bounty_Ping_Role_ID.
    // Several messages allowed: links (or ids) separated by commas / spaces / new lines.
    roleMessages: roleMessagesFrom(raw.Role_Message),
    roleMessageId: (roleMessagesFrom(raw.Role_Message)[0] || {}).messageId || '',
    roleChannelId: (roleMessagesFrom(raw.Role_Message)[0] || {}).channelId || '',
    roleEmoji: str(raw.Role_Emoji) || '🎯',
    // Tidy channels (days, 0 = off): small bot messages, closed bounty posts one-line / deleted.
    cleanupDays: Math.max(0, num(raw.Cleanup_After_Days, 7)),
    bountyCompactDays: Math.max(0, num(raw.Bounty_Compact_After_Days, 14)),
    bountyDeleteDays: Math.max(0, num(raw.Bounty_Delete_After_Days, 30))
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
    // Grand Bounty tick box: null = the tab has no such column (then First Points decide).
    grand: row.grand === undefined ? null : row.grand === true || /^(true|yes|1|x|✓|✔)$/i.test(str(row.grand)),
    postedAt: Number(row.postedAt) || null,
    messageId: str(row.messageId),
    codeWord: str(row.codeWord),
    chosenBy: str(row.chosenBy),
    chosenById: str(row.chosenById),
    rawParts: (row.parts || []).map(str),
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
  if ((settings.closedWeeks || []).includes(bounty.weekOf)) return bounty.postedAt || 0;
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

// ---------------------------------------------------------------------------
// Random order
//
// "history" = the History tab (one row per week: posted, or picked by a
// player and waiting for Monday). "pool" = the Bounties tab (the list of
// bounties to choose from; Week Of is optional and forces that week).
// ---------------------------------------------------------------------------

const addDays = (iso, n) => isoDate(dayMs(iso) + n * DAY);
const bossKey = name => str(name).toLowerCase().replace(/\s+/g, ' ');

// The History "Week Of" is the bounty's unique id (claims and submissions are
// saved under it): the Monday for a normal post, the day for an extra /bhpost.
// WHEN a bounty ran is always taken from its Posted At.

/** The day a bounty went up (a waiting pick: its id). */
const ranOn = h => (h.postedAt ? isoDate(h.postedAt) : h.weekOf);

/** A Monday is done once a bounty went up on or after it. An earlier /bhpost never skips a Monday. */
const weekCovered = (history, weekOf) => history.some(h => h.postedAt && h.postedAt >= dayMs(weekOf));

/** The next Monday that still needs its bounty: this week's, or next week's if this one is done. */
function nextOpenWeek(history, now) {
  let week = mondayOf(now);
  for (let i = 0; i < 520 && weekCovered(history, week); i++) week = addDays(week, 7);
  return week;
}

/** The Monday whose bounty should go up right now, if any (its random time reached). */
function dueWeek(history, now, settings) {
  const week = mondayOf(now);
  if (weekCovered(history, week)) return null;
  return now >= scheduledPostTime(week, settings) ? week : null;
}

/** An id not used yet: the date itself, else the next free day. */
function freeKey(history, date) {
  let key = date;
  for (let i = 0; i < 366 && history.some(h => h.weekOf === key); i++) key = addDays(key, 1);
  return key;
}

/** A player's pick waiting for the next Monday post (at most one at a time). */
const waitingPick = history => history.find(h => !h.postedAt) || null;

const usablePool = pool => pool.filter(p => p.active && p.parts.length);

/**
 * Bounties that may go up on `date`: bosses that did NOT run in the previous
 * Repeat_Cooldown_Weeks weeks (and not the boss of a waiting pick). If every
 * boss is cooling down, the ones used longest ago, so there is always a bounty.
 */
function eligiblePool(pool, history, date, settings) {
  const usable = usablePool(pool);
  const from = addDays(date, -7 * settings.repeatCooldownWeeks);
  const recent = new Set(history
    .filter(h => !h.postedAt || (ranOn(h) < date && ranOn(h) >= from))
    .map(h => bossKey(h.boss)));
  const fresh = usable.filter(p => !recent.has(bossKey(p.boss)));
  if (fresh.length || !usable.length) return fresh;
  const last = new Map();
  for (const h of history) {
    const k = bossKey(h.boss);
    if (h.postedAt && ranOn(h) < date && (last.get(k) || '') < ranOn(h)) last.set(k, ranOn(h));
  }
  const lastOf = p => last.get(bossKey(p.boss)) || '';
  const oldest = usable.map(lastOf).sort()[0];
  return usable.filter(p => lastOf(p) === oldest);
}

function shuffled(list, rand = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * What goes up on `date`.
 * Monday post (extra = false): a player's pick, else a Bounties row with that
 * Week Of (forced by an admin), else random. Its id = that Monday (next free day if taken).
 * Extra /bhpost (extra = true): always random; a waiting pick stays for Monday.
 * Returns { bounty, source } with bounty.weekOf = its id, or null.
 */
function planWeek(pool, history, date, settings, rand = Math.random, { extra = false } = {}) {
  const picked = extra ? null : waitingPick(history);
  if (picked) return { bounty: picked, source: 'picked' };
  const fresh = b => ({ ...b, weekOf: freeKey(history, date), postedAt: null, messageId: '', chosenBy: '', chosenById: '' });
  const forced = extra ? null : usablePool(pool).find(p => p.weekOf === date);
  if (forced) return { bounty: fresh(forced), source: 'forced' };
  // A row forced for a LATER week waits for that week (never picked at random before it).
  const eligible = eligiblePool(pool, history, date, settings).filter(p => !p.weekOf || p.weekOf <= date);
  if (!eligible.length) return null;
  return { bounty: fresh(eligible[Math.floor(rand() * eligible.length)]), source: extra ? 'extra' : 'random' };
}

/** The bounties a "Pick next week's bounty" buyer chooses from (for the Monday `weekOf`). */
const pickChoices = (pool, history, weekOf, settings, rand = Math.random) =>
  shuffled(eligiblePool(pool, history, weekOf, settings), rand).slice(0, settings.pickOptions);

/** The History row for a bounty going up in `weekOf` (a copy, so editing the Bounties tab later changes nothing). */
function historyRow(bounty, weekOf, extra = {}) {
  return {
    weekOf, boss: bounty.boss,
    firstPoints: bounty.firstPoints ?? '', laterPoints: bounty.laterPoints ?? '',
    parts: bounty.rawParts || [], codeWord: bounty.codeWord || '',
    grand: bounty.grand === true,
    chosenBy: bounty.chosenBy || '', chosenById: bounty.chosenById || '',
    ...extra
  };
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
      isWheel: /^wheel$/i.test(str(r.deliveredHow)),
      // "pick" in Delivered How = the buyer chooses next week's bounty (1 per week; the bot keeps that stock).
      isPick: /^pick$/i.test(str(r.deliveredHow)),
      // "donate" / "gift": the player chooses the amount; Cost is the minimum.
      isDonate: /^donate$/i.test(str(r.deliveredHow)),
      isGift: /^gift$/i.test(str(r.deliveredHow)),
      // "sponsor" / "duel": the player chooses the amount; Cost is the minimum.
      isSponsor: /^sponsor$/i.test(str(r.deliveredHow)),
      isDuel: /^duel$/i.test(str(r.deliveredHow)),
      isCodeWord: /^codeword$/i.test(str(r.deliveredHow)),
      isEmoji: /^emoji$/i.test(str(r.deliveredHow)),
      // "goal": not for sale. Item = the goal's name, Cost = the donated points it needs.
      isGoal: /^goal$/i.test(str(r.deliveredHow))
    };
  }).filter(r => r.item && r.cost > 0);
}

const inStock = item => item.stock === null || item.stock > 0;

// ---------------------------------------------------------------------------
// Donations and gifts
// ---------------------------------------------------------------------------

const minTransfer = item => Math.max(1, Math.ceil(item.cost));

/** Points this player has gifted since Monday 00:00 UTC. */
function giftedThisWeek(points, playerId, at) {
  const from = dayMs(mondayOf(at));
  return uniquePoints(points).reduce((sum, p) => {
    const sent = str(p.playerId) === str(playerId) && str(p.type).toLowerCase() === TYPE_GIFT &&
      num(p.change, 0) < 0 && Number(p.time) >= from;
    return sent ? sum - num(p.change, 0) : sum;
  }, 0);
}

/** A typed amount as a whole number, or null. */
function parseAmount(text) {
  const t = str(text);
  return /^\d{1,7}$/.test(t) ? Number(t) : null;
}

/** Why this amount can't be sent, or null when it is fine. `giftLeft` is only for gifts. */
function transferProblem({ amount, min, wallet, giftLeft = null }) {
  if (amount === null || amount < 1) return 'Please type a whole number of points, like 5.';
  if (amount < min) return `The minimum is **${min} pts**.`;
  if (amount > wallet) return `You only have **${wallet} pts**.`;
  if (giftLeft !== null && amount > giftLeft) return `You can only gift **${giftLeft} more pts** this week. The limit resets on Monday at 00:00 UTC.`;
  return null;
}

/** Player-typed text, tidied. Line breaks are kept only when `lines` is true. */
function cleanText(text, max, { lines = false } = {}) {
  const raw = String(text ?? '').replace(/\r/g, '');
  const tidy = lines ? raw.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n') : raw.replace(/\s+/g, ' ');
  return tidy.trim().slice(0, max);
}

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
/** Closed_Bounties cell → ISO dates. Takes 2026-11-16, 16/11/2026 or a date value; comma / space separated. */
function closedWeeksFrom(value) {
  if (value instanceof Date) return [isoDate(value.getTime() + 12 * HOUR)];
  const out = [];
  for (const part of str(value).split(/[\s,;]+/).filter(Boolean)) {
    // A date cell can arrive as a timestamp at local midnight (e.g. 2026-11-15T23:00:00.000Z): round to the day.
    if (/^\d{4}-\d{2}-\d{2}T/.test(part) && !isNaN(Date.parse(part))) {
      const iso = isoDate(Date.parse(part) + 12 * HOUR);
      if (!out.includes(iso)) out.push(iso);
      continue;
    }
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(part);
    const iso = m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
      : (m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(part)) ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
    if (iso && !out.includes(iso)) out.push(iso);
  }
  return out;
}

/** Role_Message cell → [{ channelId ('' = board channel), messageId }], duplicates removed. */
function roleMessagesFrom(text) {
  const out = [];
  for (const part of str(text).split(/[\s,;]+/).filter(Boolean)) {
    const link = /channels\/\d+\/(\d{15,22})\/(\d{15,22})/.exec(part);
    const m = link ? { channelId: link[1], messageId: link[2] } : /^\d{15,22}$/.test(part) ? { channelId: '', messageId: part } : null;
    if (m && !out.some(x => x.messageId === m.messageId)) out.push(m);
  }
  return out;
}

function messageIdFrom(text) {
  const t = str(text);
  const link = /channels\/\d+\/\d+\/(\d{15,22})/.exec(t);
  if (link) return link[1];
  return /^\d{15,22}$/.test(t) ? t : null;
}

module.exports = {
  HOUR, DAY, TYPE_FIRST, TYPE_CLAIM, TYPE_SHOP, TYPE_ADMIN, TYPE_VOID, TYPE_WHEEL, TYPE_DONATION, TYPE_GIFT, TYPE_SPONSOR, TYPE_DUEL,
  minTransfer, giftedThisWeek, parseAmount, transferProblem, cleanText,
  parseWheel, wheelOdds, pickPrize, spinPlan,
  num, readSettings,
  isoDate, dayMs, mondayOf, monthKey, monthRange, hash, scheduledPostTime, CODE_WORDS, codeWordFor,
  parsePart, describePart, parseBounty, parseBounties,
  postedBounties, currentBounty, closesAt, openBounties,
  addDays, bossKey, ranOn, weekCovered, nextOpenWeek, dueWeek, freeKey, waitingPick, usablePool, eligiblePool, shuffled, planWeek, pickChoices, historyRow,
  activeSubmissions, isMessageApproved, progressFor, isComplete, assignPart, bountyItems, inProgressCount,
  claimRef, uniquePoints, activeClaims, multiplierStartsAt, multiplierActive, claimPoints,
  balances, playerNames, standings, rankOf, playerSummary,
  parseShop, inStock, messageIdFrom
};
