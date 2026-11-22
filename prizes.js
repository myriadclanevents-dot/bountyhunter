// Big GP prizes on top of the points (pure, testable).
//
// GRAND BOUNTY: a bounty ticked in the Bounties tab's "Grand Bounty" column (or, when
// that column doesn't exist, one whose First Points are at least
// Grand_Bounty_Min_First_Points) pays the first finisher a GP prize as well. If such a bounty
// closes with nobody finishing it, the next one's prize grows by
// Grand_Bounty_Rollover, up to Grand_Bounty_Max.
//
// MONTHLY DRAW: on the 1st of the month one player wins Monthly_Draw_Prize.
// Every claim in the month just ended is 1 ticket, whatever the tier.
//
// Both are recorded as a 0-point Points row of type "gp prize" (ref grand:<week>
// or draw:<YYYY-MM>), so the sheet shows who won and the bot never pays twice.
// GP is paid in game by an admin; the bot only announces and pings.

const b = require('./bounty');

const TYPE_PRIZE = 'gp prize';
const str = v => String(v ?? '').trim();
const grandRef = weekOf => `grand:${weekOf}`;
const drawRef = month => `draw:${month}`;

const prizeRow = (points, ref) =>
  points.find(p => str(p.ref) === ref && str(p.type).toLowerCase() === TYPE_PRIZE) || null;

/** Does this posted bounty carry a Grand Bounty prize? */
function qualifies(bounty, s) {
  if (!(s.grandPrize > 0) || !s.grandSince || !bounty?.postedAt) return false;
  if (bounty.postedAt < s.grandSince) return false;
  // The Bounties tab has a "Grand Bounty" column: only ticked bounties count.
  if (s.grandManual) return bounty.grand === true;
  return (bounty.firstPoints ?? s.defaultFirst) >= s.grandMinFirst;
}

/**
 * The Grand Bounty prize (M GP) for `bounty`: the base prize, plus one rollover
 * for every earlier qualifying bounty that closed with nobody finishing it since
 * the last time the prize was won (or claimed).
 */
function grandPotFor(bounties, points, bounty, s, now) {
  const cap = Math.max(s.grandMax, s.grandPrize);
  let pot = s.grandPrize;
  for (const x of b.postedBounties(bounties)) {
    if (x.weekOf === bounty.weekOf) break;
    if (!qualifies(x, s)) continue;
    if (prizeRow(points, grandRef(x.weekOf)) || b.activeClaims(points, x.weekOf).length) { pot = s.grandPrize; continue; }
    if (now >= b.closesAt(bounties, x, s)) pot = Math.min(pot + s.grandRollover, cap);
  }
  return pot;
}

/** What the next qualifying bounty would pay if posted now (for /bhhelp-style hints). */
function nextGrandPot(bounties, points, s, now) {
  return grandPotFor(bounties, points, { weekOf: '￿' }, s, now);
}

/** Tickets for a month: one per active claim made in it (and after Monthly_Draw_Since). */
function drawTickets(points, { from, to }, since = 0) {
  const byPlayer = new Map();
  for (const c of b.activeClaims(points)) {
    const t = Number(c.time);
    if (!(t >= from && t < to && t >= since)) continue;
    const id = str(c.playerId);
    const e = byPlayer.get(id) || { playerId: id, player: str(c.player), tickets: 0 };
    e.tickets++;
    e.player = str(c.player) || e.player;
    byPlayer.set(id, e);
  }
  return [...byPlayer.values()].sort((a, b2) => b2.tickets - a.tickets || a.player.localeCompare(b2.player));
}

/** Weighted pick: `rand` in [0, 1). Returns null when nobody has a ticket. */
function drawWinner(entries, rand) {
  const total = entries.reduce((n, e) => n + e.tickets, 0);
  if (!total) return null;
  let r = Math.floor(rand * total);
  for (const e of entries) { if (r < e.tickets) return e; r -= e.tickets; }
  return entries[entries.length - 1];
}

module.exports = { TYPE_PRIZE, grandRef, drawRef, prizeRow, qualifies, grandPotFor, nextGrandPot, drawTickets, drawWinner };
