const assert = require('node:assert/strict');
const b = require('../bounty');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (err) { console.error(`✗ ${name}`); throw err; }
};

const drops = [
  ...['Wraps', 'Codex', 'Gem', 'Symbol', 'Shaft'].map(item => ({ boss: 'Kerapac', item })),
  ...['Torva helm', 'Pernix cowl', 'Virtus mask', 'Zaryte bow'].map(item => ({ boss: 'Nex', item }))
];
const S = b.readSettings({ Multiplier: '2', Multiplier_After_Hours: 72, Default_First_Points: 10, Default_Later_Points: 5 });

// --- settings -------------------------------------------------------------
test('settings read Spanish decimals and defaults', () => {
  const s = b.readSettings({ Multiplier: '1,5', Post_Hour_From: 20, Post_Hour_To: 4 });
  assert.equal(s.multiplier, 1.5);
  assert.equal(s.postHourFrom, 4);
  assert.equal(s.postHourTo, 20);
  assert.equal(s.approveEmoji, '✅');
  assert.equal(s.defaultFirst, 10);
});

// --- dates ----------------------------------------------------------------
test('mondayOf', () => {
  assert.equal(b.mondayOf(Date.parse('2026-11-23T00:00:00Z')), '2026-11-23');
  assert.equal(b.mondayOf(Date.parse('2026-11-29T23:59:00Z')), '2026-11-23');
  assert.equal(b.mondayOf(Date.parse('2026-11-30T00:00:01Z')), '2026-11-30');
});

test('scheduled post time is stable and inside the window', () => {
  const s = b.readSettings({ Post_Hour_From: 6, Post_Hour_To: 9 });
  for (const w of ['2026-11-23', '2026-11-30', '2026-12-07', '2027-01-04']) {
    const t = b.scheduledPostTime(w, s);
    assert.equal(t, b.scheduledPostTime(w, s));
    const h = new Date(t).getUTCHours();
    assert.ok(h >= 6 && h <= 9, `hour ${h}`);
    assert.equal(b.isoDate(t), w);
  }
});

// --- parts ----------------------------------------------------------------
test('boss name expands to its drops', () => {
  const p = b.parsePart('Kerapac', drops);
  assert.equal(p.need, 1);
  assert.equal(p.items.length, 5);
  assert.equal(b.describePart(p), 'Any Kerapac drop');
});

test('"2 of:" mixes bosses and needs different items', () => {
  const p = b.parsePart('2 of: Kerapac, Nex', drops);
  assert.equal(p.need, 2);
  assert.equal(p.items.length, 9);
  assert.equal(b.describePart(p), '2 different items from: any Kerapac drop, any Nex drop');
});

test('plain item list', () => {
  const p = b.parsePart('Spider leg top, Spider leg middle', drops);
  assert.deepEqual(p.items, ['Spider leg top', 'Spider leg middle']);
  assert.equal(b.describePart(p), 'One of: Spider leg top, Spider leg middle');
});

test('need larger than list is capped with a warning', () => {
  const p = b.parsePart('3 of: A, B', drops);
  assert.equal(p.need, 2);
  assert.equal(p.warnings.length, 1);
});

test('empty part is skipped', () => {
  assert.equal(b.parsePart('  ', drops), null);
  const bounty = b.parseBounty({ weekOf: '2026-11-23', boss: 'X', parts: ['Kerapac', '', 'Nex'], active: true }, drops);
  assert.equal(bounty.parts.length, 2);
});

// --- progress -------------------------------------------------------------
const bounty = b.parseBounty({
  weekOf: '2026-11-23', boss: 'Kerapac + Nex', parts: ['Kerapac', '2 of: Nex'],
  firstPoints: '', laterPoints: '', active: true, postedAt: Date.parse('2026-11-23T14:00:00Z')
}, drops);

const sub = (messageId, playerId, part, item, status = 'approved') =>
  ({ messageId, playerId, player: `P${playerId}`, part, item, status, weekOf: '2026-11-23' });

test('assignPart picks the first part that lists the item', () => {
  const prog = b.progressFor(bounty, [], '1');
  assert.deepEqual(b.assignPart(prog, 'Wraps'), { index: 1 });
  assert.deepEqual(b.assignPart(prog, 'zaryte bow'), { index: 2 });
  assert.deepEqual(b.assignPart(prog, 'Dragon hatchet'), { error: 'not-in-bounty' });
});

test('same item twice in a part is refused; finished part is refused', () => {
  const active = [sub('m1', '1', 1, 'Wraps'), sub('m2', '1', 2, 'Zaryte bow')];
  const prog = b.progressFor(bounty, active, '1');
  assert.deepEqual(b.assignPart(prog, 'Zaryte bow'), { error: 'duplicate' });
  assert.deepEqual(b.assignPart(prog, 'Codex'), { error: 'part-done' });
  assert.deepEqual(b.assignPart(prog, 'Torva helm'), { index: 2 });
});

test('complete only when every part is done', () => {
  let active = [sub('m1', '1', 1, 'Wraps'), sub('m2', '1', 2, 'Zaryte bow')];
  assert.equal(b.isComplete(b.progressFor(bounty, active, '1')), false);
  active = [...active, sub('m3', '1', 2, 'Torva helm')];
  assert.equal(b.isComplete(b.progressFor(bounty, active, '1')), true);
});

test('a void row cancels the approval of that message', () => {
  const rows = [sub('m1', '1', 1, 'Wraps'), sub('m1', '1', 1, 'Wraps', 'void')];
  assert.equal(b.activeSubmissions(rows).length, 0);
  assert.equal(b.isMessageApproved(rows, 'm1'), false);
  rows.push(sub('m1', '1', 1, 'Wraps'));
  assert.equal(b.isMessageApproved(rows, 'm1'), true);
});

// --- points ---------------------------------------------------------------
const posted = bounty.postedAt;

test('first claim before 72h: base points', () => {
  const r = b.claimPoints(bounty, S, { isFirst: true, completedAt: posted + 71 * b.HOUR });
  assert.deepEqual(r, { points: 10, multiplied: false, base: 10 });
});

test('first claim after 72h: multiplied', () => {
  const r = b.claimPoints(bounty, S, { isFirst: true, completedAt: posted + 72 * b.HOUR });
  assert.equal(r.points, 20);
  assert.equal(r.multiplied, true);
});

test('later claims are never multiplied', () => {
  const r = b.claimPoints(bounty, S, { isFirst: false, completedAt: posted + 100 * b.HOUR });
  assert.equal(r.points, 5);
});

test('per-bounty points override defaults; 1,5 multiplier rounds half up', () => {
  const s = b.readSettings({ Multiplier: '1,5' });
  const hard = { ...bounty, firstPoints: 15 };
  assert.equal(b.claimPoints(hard, s, { isFirst: true, completedAt: posted + 80 * b.HOUR }).points, 23);
});

const pts = [
  { time: 1, playerId: '1', player: 'Valxen', change: 20, type: 'first claim', weekOf: 'w1', ref: 'claim:w1:1', opId: 'a' },
  { time: 2, playerId: '2', player: 'Donini', change: 5, type: 'claim', weekOf: 'w1', ref: 'claim:w1:2', opId: 'b' },
  { time: 2, playerId: '2', player: 'Donini', change: 5, type: 'claim', weekOf: 'w1', ref: 'claim:w1:2', opId: 'b' }, // retried write
  { time: 3, playerId: '1', player: 'Valxen', change: -15, type: 'shop', ref: 'P1', opId: 'c' },
  { time: 4, playerId: '3', player: 'Diodegro', change: 5, type: 'claim', weekOf: 'w1', ref: 'claim:w1:3', opId: 'd' },
  { time: 5, playerId: '3', player: 'Diodegro', change: -5, type: 'void', weekOf: 'w1', ref: 'claim:w1:3', opId: 'e' }
];

test('claims: duplicates ignored, voids cancel', () => {
  const c = b.activeClaims(pts, 'w1');
  assert.deepEqual(c.map(x => x.playerId), ['1', '2']);
});

test('balances: shop lowers wallet, not earned', () => {
  assert.deepEqual(b.balances(pts, '1', 10), { wallet: 5, earned: 20, month: 20 });
  assert.deepEqual(b.balances(pts, '2', 10), { wallet: 5, earned: 5, month: 5 });
  assert.deepEqual(b.balances(pts, '3', 10), { wallet: 0, earned: 0, month: 0 });
});

test('standings rank by earned, voided player drops out', () => {
  const rows = b.standings(pts);
  assert.deepEqual(rows.map(r => [r.player, r.points, r.claims, r.firsts]),
    [['Valxen', 20, 1, 1], ['Donini', 5, 1, 0]]);
  assert.equal(b.rankOf(rows, '2'), 2);
  assert.equal(b.rankOf(rows, '3'), null);
});

test('standings for a month only count that month', () => {
  const nov = Date.parse('2026-11-10T00:00:00Z');
  const oct = Date.parse('2026-10-10T00:00:00Z');
  const rows = b.standings([
    { time: oct, playerId: '1', player: 'A', change: 10, type: 'first claim', ref: 'claim:o:1', weekOf: 'o' },
    { time: nov, playerId: '2', player: 'B', change: 5, type: 'claim', ref: 'claim:n:2', weekOf: 'n' }
  ], b.monthRange(nov));
  assert.deepEqual(rows.map(r => r.player), ['B']);
});

// --- timeline -------------------------------------------------------------
test('current, open and due bounties', () => {
  const rows = b.parseBounties([
    { weekOf: '2026-11-16', boss: 'A', parts: ['Kerapac'], active: true, postedAt: Date.parse('2026-11-16T10:00:00Z') },
    { weekOf: '2026-11-23', boss: 'B', parts: ['Nex'], active: true, postedAt: Date.parse('2026-11-23T05:00:00Z') },
    { weekOf: '2026-11-30', boss: 'C', parts: ['Nex'], active: true }
  ], drops);
  assert.equal(b.currentBounty(rows).boss, 'B');

  const late = b.readSettings({ Late_Claim_Hours: 24 });
  const now = Date.parse('2026-11-23T20:00:00Z');
  assert.deepEqual(b.openBounties(rows, now, late).map(x => x.boss), ['B', 'A']);
  assert.deepEqual(b.openBounties(rows, now, S).map(x => x.boss), ['B']);

  const monday = b.scheduledPostTime('2026-11-30', S);
  assert.equal(b.dueBounty(rows, monday - 1000, S), null);
  assert.equal(b.dueBounty(rows, monday, S).boss, 'C');
  assert.equal(b.nextUnposted(rows, now).boss, 'C');
});

test('message id from link or id', () => {
  assert.equal(b.messageIdFrom('https://discord.com/channels/1/2/1571601800295878656'), '1571601800295878656');
  assert.equal(b.messageIdFrom('1571601800295878656'), '1571601800295878656');
  assert.equal(b.messageIdFrom('hello'), null);
});

test('shop parsing', () => {
  const shop = b.parseShop([
    { item: 'Ticket', cost: 15, stock: '', active: true },
    { item: 'GP', cost: '60', stock: 0, active: 'TRUE' },
    { item: '', cost: 5 }
  ]);
  assert.equal(shop.length, 2);
  assert.equal(b.inStock(shop[0]), true);
  assert.equal(b.inStock(shop[1]), false);
});

test('code words: stable per week, differ by week and salt, look like Word12', () => {
  const a = b.codeWordFor('2026-11-23', 'salt1');
  assert.equal(a, b.codeWordFor('2026-11-23', 'salt1'));
  assert.match(a, /^[A-Z][a-z]+\d{2}$/);
  const weeks = ['2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21'].map(w => b.codeWordFor(w, 'salt1'));
  assert.ok(new Set(weeks).size >= 4);
  assert.notEqual(b.codeWordFor('2026-11-23', 'salt2'), a);
});

test('admin code word is read from the row', () => {
  const x = b.parseBounty({ weekOf: '2026-11-23', boss: 'X', parts: ['Kerapac'], codeWord: ' Hydra7 ' }, drops);
  assert.equal(x.codeWord, 'Hydra7');
});

// --- prize wheel ------------------------------------------------------------
const WHEEL_ROWS = [
  { prize: '+5 pts', weight: 40, kind: 'points', points: 5, active: true },
  { prize: 'Nothing', weight: 25, kind: 'nothing', active: '' },
  { prize: '+20 pts', weight: '15', kind: '', points: 20 },
  { prize: '5m GP', weight: 15, kind: '', points: '' },
  { prize: 'Off prize', weight: 50, active: false },
  { prize: 'Zero weight', weight: 0 },
  { prize: 'Bond', weight: '1', kind: 'item' }
];

test('wheel parsing: kinds inferred, inactive and zero-weight rows dropped', () => {
  const w = b.parseWheel(WHEEL_ROWS);
  assert.deepEqual(w.map(p => p.prize), ['+5 pts', 'Nothing', '+20 pts', '5m GP', 'Bond']);
  assert.deepEqual(w.map(p => p.kind), ['points', 'nothing', 'points', 'item', 'item']);
  assert.equal(w[2].points, 20);
  assert.equal(w[3].points, 0);
});

test('wheel odds add up to 100', () => {
  const odds = b.wheelOdds(b.parseWheel(WHEEL_ROWS));
  assert.ok(Math.abs(odds.reduce((a, x) => a + x, 0) - 100) < 1e-9);
  assert.equal(Math.round(odds[0] * 10) / 10, 41.7); // 40 / 96
});

test('pickPrize follows the weights', () => {
  const w = b.parseWheel(WHEEL_ROWS); // total 96
  assert.equal(b.pickPrize(w, () => 0), 0);
  assert.equal(b.pickPrize(w, () => 39.9 / 96), 0);
  assert.equal(b.pickPrize(w, () => 40 / 96), 1);
  assert.equal(b.pickPrize(w, () => 0.99999), 4);
  const counts = [0, 0, 0, 0, 0];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let n = 0; n < 20000; n++) counts[b.pickPrize(w, rand)]++;
  assert.ok(Math.abs(counts[0] / 20000 - 40 / 96) < 0.02);
  assert.ok(counts[4] > 50 && counts[4] < 500);
});

test('spin plan always lands on the winner, ~10 edits, never faster than 1 per second', () => {
  for (const count of [1, 2, 5, 6, 12]) {
    for (let winner = 0; winner < count; winner++) {
      for (const r of [0, 0.3, 0.99]) {
        const plan = b.spinPlan(count, winner, () => r);
        assert.equal(plan.frames.at(-1).index, winner);
        assert.ok(plan.frames.length <= 12);
        assert.ok(plan.frames.every(f => f.delay >= 1000 && f.index >= 0 && f.index < count));
      }
    }
  }
});

test('shop: Delivered How "wheel" marks the spin item', () => {
  const shop = b.parseShop([{ item: 'Spin', cost: 10, active: true, deliveredHow: ' Wheel ' }, { item: 'GP', cost: 5, active: true, deliveredHow: 'in game' }]);
  assert.equal(shop[0].isWheel, true);
  assert.equal(shop[1].isWheel, false);
});

test('wheel rows move the wallet but never earned or leaderboards', () => {
  const t = Date.parse('2026-11-20T12:00:00Z');
  const pts = [
    { time: t, playerId: '1', player: 'A', change: 30, type: 'claim', weekOf: '2026-11-16', ref: 'claim:2026-11-16:1', opId: 'a' },
    { time: t, playerId: '1', player: 'A', change: -10, type: 'shop', detail: 'Prize wheel spin', ref: 'P1', opId: 'b' },
    { time: t, playerId: '1', player: 'A', change: 20, type: 'wheel', detail: 'Wheel: +20 pts', ref: 'P1', opId: 'b-win' }
  ];
  const bal = b.balances(pts, '1', t);
  assert.equal(bal.wallet, 40);
  assert.equal(bal.earned, 30);
  assert.equal(bal.month, 30);
  assert.equal(b.standings(pts)[0].points, 30);
});

console.log(`bounty: ${passed} tests passed`);
