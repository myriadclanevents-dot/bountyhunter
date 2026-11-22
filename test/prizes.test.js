const assert = require('node:assert/strict');
const b = require('../bounty');
const pz = require('../prizes');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (err) { console.error(`✗ ${name}`); throw err; }
};

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 11, 1); // 1 Dec 2026
const S = b.readSettings({ Grand_Bounty_Since: String(T0 - 1) });
const bounty = (weekOf, day, first) => ({ weekOf, boss: `Boss ${weekOf}`, postedAt: T0 + day * DAY, firstPoints: first, laterPoints: 1, parts: [] });
const claim = (weekOf, playerId, time, type = b.TYPE_CLAIM) =>
  ({ time, player: `P${playerId}`, playerId, change: 10, type, weekOf, ref: b.claimRef(weekOf, playerId) });
const grandRow = weekOf => ({ type: pz.TYPE_PRIZE, ref: pz.grandRef(weekOf), change: 0 });

test('settings: defaults from the proposal, 0 switches off, Spanish decimals', () => {
  const s = b.readSettings({});
  assert.equal(s.grandPrize, 150); assert.equal(s.grandRollover, 50); assert.equal(s.grandMax, 300);
  assert.equal(s.grandMinFirst, 100); assert.equal(s.drawPrize, 100);
  assert.equal(s.grandSince, null); assert.equal(s.drawSince, null);
  assert.equal(b.readSettings({ Grand_Bounty_Prize: '0' }).grandPrize, 0);
  assert.equal(b.readSettings({ Monthly_Draw_Prize: '75,5' }).drawPrize, 75.5);
});

test('qualifies: Elite points, posted after the start, prize on', () => {
  assert.equal(pz.qualifies(bounty('a', 0, 100), S), true);
  assert.equal(pz.qualifies(bounty('a', 0, 45), S), false);           // Hard
  assert.equal(pz.qualifies({ ...bounty('a', 0, 100), postedAt: T0 - 5 * DAY }, S), false); // before the start
  assert.equal(pz.qualifies(bounty('a', 0, 100), { ...S, grandPrize: 0 }), false);
  assert.equal(pz.qualifies(bounty('a', 0, 100), { ...S, grandSince: null }), false);
  assert.equal(pz.qualifies({ ...bounty('a', 0, 100), postedAt: null }, S), false);
});

test('qualifies: with a Grand Bounty column only ticked bounties count, whatever their points', () => {
  const M = { ...S, grandManual: true };
  assert.equal(pz.qualifies({ ...bounty('a', 0, 20), grand: true }, M), true);
  assert.equal(pz.qualifies({ ...bounty('a', 0, 100), grand: false }, M), false);
  assert.equal(pz.qualifies({ ...bounty('a', 0, 100), grand: null }, M), false); // History row from before the column
  assert.equal(pz.qualifies({ ...bounty('a', 0, 20), grand: true, postedAt: T0 - 5 * DAY }, M), false);
  // parsing: tick box / TRUE / x count; no column = null
  const drops = [];
  assert.equal(b.parseBounty({ boss: 'X', grand: true }, drops).grand, true);
  assert.equal(b.parseBounty({ boss: 'X', grand: 'TRUE' }, drops).grand, true);
  assert.equal(b.parseBounty({ boss: 'X', grand: '' }, drops).grand, false);
  assert.equal(b.parseBounty({ boss: 'X' }, drops).grand, null);
  // the History copy keeps the tick
  assert.equal(b.historyRow({ boss: 'X', grand: true }, '2026-12-07').grand, true);
  assert.equal(b.historyRow({ boss: 'X', grand: null }, '2026-12-07').grand, false);
});

test('pot: rollover only counts ticked bounties in manual mode', () => {
  const M = { ...S, grandManual: true };
  const list = [{ ...bounty('w1', 0, 20), grand: true }, { ...bounty('w2', 7, 100), grand: false }, { ...bounty('w3', 14, 45), grand: true }];
  assert.equal(pz.grandPotFor(list, [], list[2], M, T0 + 60 * DAY), 200); // w1 unclaimed adds 50, w2 isn't one
});

test('pot: base, grows per unclaimed Elite, caps, resets after a win', () => {
  const list = [bounty('w1', 0, 100), bounty('w2', 7, 45), bounty('w3', 14, 100), bounty('w4', 21, 100), bounty('w5', 28, 100), bounty('w6', 35, 100), bounty('w7', 42, 100)];
  const now = T0 + 60 * DAY;
  assert.equal(pz.grandPotFor(list, [], list[0], S, now), 150);
  // w1 closed unclaimed -> w3 (next Elite; w2 is Hard and doesn't count) pays 200
  assert.equal(pz.grandPotFor(list, [], list[2], S, now), 200);
  assert.equal(pz.grandPotFor(list, [], list[3], S, now), 250);
  assert.equal(pz.grandPotFor(list, [], list[4], S, now), 300);
  assert.equal(pz.grandPotFor(list, [], list[5], S, now), 300); // capped
  // someone won w4 -> w5 back to base
  assert.equal(pz.grandPotFor(list, [grandRow('w4')], list[4], S, now), 150);
  // a claim without a prize row (e.g. voided winner) also resets
  assert.equal(pz.grandPotFor(list, [claim('w1', '1', T0 + DAY)], list[2], S, now), 150);
});

test('pot: a bounty still open does not roll over yet', () => {
  const list = [bounty('w1', 0, 100), bounty('w2', 7, 100)];
  // w1 is current (no later bounty posted): closesAt = Infinity
  assert.equal(pz.nextGrandPot([list[0]], [], S, T0 + 3 * DAY), 150);
  // once w2 is posted, w1 closed unclaimed -> w2 pays 200
  assert.equal(pz.grandPotFor(list, [], list[1], S, T0 + 8 * DAY), 200);
});

test('draw tickets: 1 per active claim in the month, voids and other months excluded', () => {
  const nov = b.monthRange(Date.UTC(2026, 10, 15));
  const t = Date.UTC(2026, 10, 10);
  const pts = [
    claim('a', '1', t, b.TYPE_FIRST), claim('b', '1', t + DAY), claim('a', '2', t + 2 * DAY),
    claim('c', '3', t + 3 * DAY), { type: b.TYPE_VOID, playerId: '3', weekOf: 'c', ref: b.claimRef('c', '3'), time: t + 4 * DAY, change: -10 },
    claim('d', '4', Date.UTC(2026, 11, 2)) // December
  ];
  const entries = pz.drawTickets(pts, nov);
  assert.deepEqual(entries.map(x => [x.playerId, x.tickets]), [['1', 2], ['2', 1]]);
  // claims before Monthly_Draw_Since don't count
  assert.deepEqual(pz.drawTickets(pts, nov, t + DAY).map(x => [x.playerId, x.tickets]), [['1', 1], ['2', 1]]);
});

test('draw winner: weighted by tickets, null when empty', () => {
  const entries = [{ playerId: '1', tickets: 3 }, { playerId: '2', tickets: 1 }];
  assert.equal(pz.drawWinner(entries, 0).playerId, '1');
  assert.equal(pz.drawWinner(entries, 0.74).playerId, '1');
  assert.equal(pz.drawWinner(entries, 0.75).playerId, '2');
  assert.equal(pz.drawWinner(entries, 0.9999).playerId, '2');
  assert.equal(pz.drawWinner([], 0.5), null);
  const wins = { 1: 0, 2: 0 };
  for (let i = 0; i < 40000; i++) wins[pz.drawWinner(entries, i / 40000).playerId]++;
  assert.equal(wins[1], 30000);
});

test('prize rows are wallet-only and change nothing', () => {
  const pts = [claim('a', '1', T0, b.TYPE_FIRST), { time: T0 + 1, player: 'P1', playerId: '1', change: 0, type: pz.TYPE_PRIZE, ref: pz.grandRef('a'), opId: 'grand:a' }];
  const bal = b.balances(pts, '1', T0 + DAY);
  assert.equal(bal.wallet, 10);
  assert.equal(bal.earned, 10);
  assert.equal(b.activeClaims(pts).length, 1);
  assert.ok(pz.prizeRow(pts, pz.grandRef('a')));
  assert.equal(pz.prizeRow(pts, pz.grandRef('b')), null);
});

console.log(`prizes: ${passed} tests passed`);
