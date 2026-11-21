// Rules for the optional shop extras (pure, testable): sponsor pots, duels,
// the clan goal, bought code words and winner's emojis.
//
// Pots and duels live entirely in the Points tab:
//   sponsor:<week>                              a player's stake (−)
//   sponsorpay:<week>                           payouts, refunds and take-backs
//   duel:<week>:<a>:<b>:<stake>:<created>       each side's stake (−)
//   duelpay:…  payouts · duelend:…  declined
// settlements() compares what SHOULD have been paid with what WAS paid and
// returns only the difference, so it is safe to run again at any time, and a
// voided claim simply moves or takes back the money on the next run.

const b = require('./bounty');

const DUEL_ACCEPT_HOURS = 24;
const EMOJI_DAYS = 30;

const str = v => String(v ?? '').trim();
const rowsOf = points => b.uniquePoints(points);
const typeOf = p => str(p.type).toLowerCase();
const isClosed = (bounty, bounties, settings, now) =>
  !bounty || !bounty.postedAt || now >= b.closesAt(bounties, bounty, settings);

// ---------------------------------------------------------------------------
// Paying out
// ---------------------------------------------------------------------------

/** Rows that bring the credits under `payRef` to exactly `desired` (playerId → points). */
function diffRows(rows, payRef, type, desired, names, label) {
  const paid = new Map();
  const count = new Map();
  for (const p of rows) {
    if (str(p.ref) !== payRef) continue;
    const id = str(p.playerId);
    paid.set(id, (paid.get(id) || 0) + b.num(p.change, 0));
    count.set(id, (count.get(id) || 0) + 1);
  }
  const out = [];
  for (const id of new Set([...paid.keys(), ...desired.keys()])) {
    const delta = (desired.get(id) || 0) - (paid.get(id) || 0);
    if (!delta) continue;
    out.push({ player: names.get(id) || id, playerId: id, change: delta, type, detail: label(id, delta), ref: payRef,
      opId: `${payRef}:${id}:${count.get(id) || 0}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sponsored bounties
// ---------------------------------------------------------------------------

const sponsorRef = weekOf => `sponsor:${weekOf}`;

function sponsorStakes(points, weekOf) {
  const out = new Map();
  for (const p of rowsOf(points)) {
    if (typeOf(p) !== b.TYPE_SPONSOR || str(p.ref) !== sponsorRef(weekOf) || b.num(p.change, 0) >= 0) continue;
    out.set(str(p.playerId), (out.get(str(p.playerId)) || 0) - b.num(p.change, 0));
  }
  return out;
}

const potOf = (points, weekOf) => [...sponsorStakes(points, weekOf).values()].reduce((a, n) => a + n, 0);

/** Can this bounty still be sponsored? Returns a reason when it can't. */
function sponsorProblem(bounty, points, bounties, settings, now) {
  if (isClosed(bounty, bounties, settings, now)) return 'There is no open bounty to sponsor right now.';
  if (b.activeClaims(points, bounty.weekOf).length) return 'This bounty has already been claimed, so its pot is decided.';
  return null;
}

// ---------------------------------------------------------------------------
// Duels
// ---------------------------------------------------------------------------

const duelRef = ({ weekOf, a, b: opponent, stake, created }) => `duel:${weekOf}:${a}:${opponent}:${stake}:${created}`;
const duelTail = ref => ref.slice('duel:'.length);

function listDuels(points) {
  const rows = rowsOf(points);
  const map = new Map();
  for (const p of rows) {
    const ref = str(p.ref);
    if (typeOf(p) !== b.TYPE_DUEL || !ref.startsWith('duel:') || b.num(p.change, 0) >= 0) continue;
    const [, weekOf, a, opponent, stake, created] = ref.split(':');
    if (!map.has(ref)) map.set(ref, { ref, weekOf, a, b: opponent, stake: Number(stake), created: Number(created), aPaid: false, bPaid: false, ended: false });
    const d = map.get(ref);
    if (str(p.playerId) === a) d.aPaid = true;
    if (str(p.playerId) === opponent) d.bPaid = true;
  }
  for (const d of map.values()) d.ended = rows.some(p => str(p.ref) === `duelend:${duelTail(d.ref)}`);
  return [...map.values()];
}

/** state: waiting (for the opponent) · live · over. `desired` = what each player should end up with. */
function duelOutcome(d, points, bounties, settings, now) {
  const bounty = bounties.find(x => x.weekOf === d.weekOf);
  const closed = isClosed(bounty, bounties, settings, now);
  const desired = new Map();
  if (!d.bPaid) {
    const lapsed = d.ended || closed || now >= d.created + DUEL_ACCEPT_HOURS * b.HOUR;
    if (!lapsed) return { state: 'waiting', desired, winner: null, bounty };
    desired.set(d.a, d.stake);
    return { state: 'over', desired, winner: null, bounty };
  }
  const first = b.activeClaims(points, d.weekOf).find(c => [d.a, d.b].includes(str(c.playerId)));
  if (first) {
    desired.set(str(first.playerId), d.stake * 2);
    return { state: 'over', desired, winner: str(first.playerId), bounty };
  }
  if (!closed) return { state: 'live', desired, winner: null, bounty };
  desired.set(d.a, d.stake);
  desired.set(d.b, d.stake);
  return { state: 'over', desired, winner: null, bounty };
}

/** The duel this player is still part of, if any (one at a time). */
function openDuelOf(playerId, points, bounties, settings, now) {
  return listDuels(points).find(d => [d.a, d.b].includes(str(playerId)) &&
    duelOutcome(d, points, bounties, settings, now).state !== 'over') || null;
}

// ---------------------------------------------------------------------------
// Everything still to pay
// ---------------------------------------------------------------------------

/** Points rows needed right now to settle every sponsor pot and duel. */
function settlements(points, bounties, settings, now) {
  const rows = rowsOf(points);
  const names = b.playerNames(points);
  const out = [];

  const weeks = new Set(rows.filter(p => typeOf(p) === b.TYPE_SPONSOR && str(p.ref).startsWith('sponsor:'))
    .map(p => str(p.ref).slice('sponsor:'.length)));
  for (const weekOf of weeks) {
    const stakes = sponsorStakes(points, weekOf);
    const pot = [...stakes.values()].reduce((a, n) => a + n, 0);
    const bounty = bounties.find(x => x.weekOf === weekOf);
    const boss = bounty?.boss || weekOf;
    const first = b.activeClaims(points, weekOf)[0];
    const closed = isClosed(bounty, bounties, settings, now);
    const desired = first ? new Map([[str(first.playerId), pot]]) : closed ? stakes : new Map();
    out.push(...diffRows(rows, `sponsorpay:${weekOf}`, b.TYPE_SPONSOR, desired, names, (id, delta) =>
      (delta < 0 ? `Sponsor pot taken back: ${boss}` : first ? `Sponsor pot won: ${boss}` : `Sponsor refund: ${boss}`)));
  }

  for (const d of listDuels(points)) {
    const { state, desired, winner } = duelOutcome(d, points, bounties, settings, now);
    if (state !== 'over') continue;
    const other = id => names.get(id === d.a ? d.b : d.a) || 'your opponent';
    out.push(...diffRows(rows, `duelpay:${duelTail(d.ref)}`, b.TYPE_DUEL, desired, names, (id, delta) =>
      (delta < 0 ? 'Duel pot taken back' : winner ? `Duel won against ${other(id)}` : 'Duel refund')));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clan goal (a Shop row with Delivered How = goal; Cost = the target)
// ---------------------------------------------------------------------------

const totalDonated = points => rowsOf(points).reduce((sum, p) =>
  (typeOf(p) === b.TYPE_DONATION ? sum - b.num(p.change, 0) : sum), 0);

function goalState(shop, points, settings) {
  const row = shop.find(it => it.isGoal && it.active);
  if (!row) return null;
  const target = Math.max(1, Math.ceil(row.cost));
  const progress = settings.goalBase === null ? 0 : Math.max(0, totalDonated(points) - settings.goalBase);
  return { name: row.item, description: row.description, target, progress };
}

function progressBar(progress, target, width = 10) {
  const full = Math.min(width, Math.floor((progress / target) * width));
  return `${'▰'.repeat(full)}${'▱'.repeat(width - full)}`;
}

// ---------------------------------------------------------------------------
// Bought code word: the buyer's word + 2 digits only revealed when it is posted,
// so nobody can prepare a screenshot in advance.
// ---------------------------------------------------------------------------

const validWord = text => /^[A-Za-z]{3,12}$/.test(str(text));
const tidyWord = text => { const w = str(text).toLowerCase(); return w.charAt(0).toUpperCase() + w.slice(1); };

const boughtCodeWord = (word, weekOf, salt) => `${tidyWord(word)}${10 + (b.hash(`bought:${salt}:${weekOf}:${word}`) % 90)}`;

/** The bought word that applies to a bounty posted at `postedAt`, or ''. */
const wordForPost = (settings, postedAt) =>
  (settings.nextCodeWord && settings.nextCodeWordWeek === b.mondayOf(postedAt) ? settings.nextCodeWord : '');

const wordTaken = (settings, nextWeek) => Boolean(settings.nextCodeWord && settings.nextCodeWordWeek >= nextWeek);

// ---------------------------------------------------------------------------
// Winner's emoji
// ---------------------------------------------------------------------------

const emojiRef = playerId => `emoji:${playerId}`;

/** A single standard emoji, or a custom emoji `isServerEmoji(id)` accepts. Null otherwise. */
function parseEmoji(text, isServerEmoji = () => false) {
  const t = str(text);
  const custom = /^<a?:\w{2,32}:(\d{15,22})>$/.exec(t);
  if (custom) return isServerEmoji(custom[1]) ? t : null;
  return /^\p{RGI_Emoji}$/v.test(t) ? t : null;
}

/** This player's emoji while it lasts, else null. The newest purchase wins. */
function activeEmoji(points, playerId, now) {
  const row = rowsOf(points).filter(p => str(p.ref) === emojiRef(playerId) && b.num(p.change, 0) < 0)
    .sort((x, y) => Number(y.time) - Number(x.time))[0];
  if (!row || now >= Number(row.time) + EMOJI_DAYS * b.DAY) return null;
  return str(row.detail).replace(/^Emoji:\s*/, '') || null;
}

module.exports = {
  DUEL_ACCEPT_HOURS, EMOJI_DAYS,
  sponsorRef, sponsorStakes, potOf, sponsorProblem,
  duelRef, duelTail, listDuels, duelOutcome, openDuelOf,
  settlements, totalDonated, goalState, progressBar,
  validWord, tidyWord, boughtCodeWord, wordForPost, wordTaken,
  emojiRef, parseEmoji, activeEmoji
};
