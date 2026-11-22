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
  assert.equal(b.dueWeek(rows, monday - 1000, S), null);
  assert.equal(b.dueWeek(rows, monday, S), '2026-11-30');
  assert.equal(b.nextOpenWeek(rows, now), '2026-11-30');
});

// --- random order ---------------------------------------------------------
const hist = (weekOf, boss, extra = {}) => ({ weekOf, boss, parts: ['Kerapac'], active: true, postedAt: Date.parse(`${weekOf}T10:00:00Z`), ...extra });
const poolOf = names => b.parseBounties(names.map(n => ({ boss: n, parts: ['Kerapac'], active: true })), drops);

test('settings: cooldown 8 weeks and 20 pick options by default, capped at 25', () => {
  assert.equal(S.repeatCooldownWeeks, 8);
  assert.equal(S.pickOptions, 20);
  assert.equal(b.readSettings({ Pick_Options: 99, Repeat_Cooldown_Weeks: '3' }).pickOptions, 25);
  assert.equal(b.readSettings({ Repeat_Cooldown_Weeks: '3' }).repeatCooldownWeeks, 3);
});

test('a Monday is done only by a bounty posted on/after it: an extra /bhpost never skips Monday', () => {
  // Live data: Araxxor (id 11-23) went up Sun 11-15, Ghrazi (id 11-30) went up Tue 11-17.
  const h = b.parseBounties([
    hist('2026-11-23', 'Araxxor', { postedAt: Date.parse('2026-11-15T19:27:00Z') }),
    hist('2026-11-30', 'Ghrazi', { postedAt: Date.parse('2026-11-17T21:57:00Z') })
  ], drops);
  assert.equal(b.dueWeek(h, Date.parse('2026-11-18T23:00:00Z'), S), null);       // this week is done
  assert.equal(b.nextOpenWeek(h, Date.parse('2026-11-18T12:00:00Z')), '2026-11-23'); // NOT 7 Dec
  assert.equal(b.dueWeek(h, Date.parse('2026-11-23T23:59:00Z'), S), '2026-11-23');
  assert.equal(b.freeKey(h, '2026-11-23'), '2026-11-24'); // id 11-23 is Araxxor's: next free day
  // An extra post on Wed 11-18 does not cover Monday 11-23.
  const more = [...h, hist('2026-11-18', 'Vorago', { postedAt: Date.parse('2026-11-18T10:00:00Z') })];
  assert.equal(b.nextOpenWeek(more, Date.parse('2026-11-18T12:00:00Z')), '2026-11-23');
});

test('plan: a player pick wins, then a forced Week Of, then random; extra posts skip the pick', () => {
  const pool = b.parseBounties([
    { boss: 'Vorago', parts: ['Nex'], active: true },
    { boss: 'Telos', parts: ['Nex'], active: true, weekOf: '2026-11-30' }
  ], drops);
  assert.equal(b.planWeek(pool, [], '2026-11-30', S).source, 'forced');
  assert.equal(b.planWeek(pool, [], '2026-11-30', S).bounty.boss, 'Telos');
  assert.equal(b.planWeek(pool, [], '2026-11-30', S).bounty.weekOf, '2026-11-30');
  const picked = b.parseBounties([{ weekOf: '2026-11-30', boss: 'Zuk', parts: ['Nex'], active: true, chosenBy: 'Donini' }], drops);
  assert.equal(b.planWeek(pool, picked, '2026-11-30', S).bounty.boss, 'Zuk');
  // Extra /bhpost on Wed 11-25: random, never the pick, never the forced row; its id = that day.
  const extra = b.planWeek(pool, picked, '2026-11-25', S, Math.random, { extra: true });
  assert.equal(extra.source, 'extra');
  assert.equal(extra.bounty.boss, 'Vorago'); // Zuk is waiting as a pick → excluded too
  assert.equal(extra.bounty.weekOf, '2026-11-25');
});

test('cooldown counts the day a bounty really went up', () => {
  const pool = poolOf(['Araxxor', 'Vorago']);
  const h = b.parseBounties([hist('2026-11-23', 'Araxxor', { postedAt: Date.parse('2026-11-15T19:27:00Z') })], drops);
  assert.deepEqual(b.eligiblePool(pool, h, '2026-11-23', S).map(p => p.boss), ['Vorago']);
  assert.equal(b.waitingPick(h), null);
});

test('cooldown is per boss: a boss used in the last 8 weeks is skipped, even as another task', () => {
  const pool = b.parseBounties([
    { boss: 'Nakatra', parts: ['Kerapac'], active: true },
    { boss: 'nakatra ', parts: ['Nex'], active: true }, // same boss, other task
    { boss: 'Vorago', parts: ['Nex'], active: true },
    { boss: 'Empty', parts: [''], active: true },      // no parts: never used
    { boss: 'Off', parts: ['Nex'], active: false }
  ], drops);
  const h = b.parseBounties([hist('2026-10-05', 'Nakatra')], drops); // 8 weeks before 11-30
  assert.deepEqual(b.eligiblePool(pool, h, '2026-11-30', S).map(p => p.boss), ['Vorago']);
  // 9 weeks later it may come back.
  assert.deepEqual(b.eligiblePool(pool, h, '2026-12-07', S).map(p => p.boss), ['Nakatra', 'nakatra', 'Vorago']);
});

test('everything cooling down: the boss used longest ago comes back', () => {
  const pool = poolOf(['A', 'B', 'C']);
  const h = b.parseBounties([hist('2026-11-02', 'B'), hist('2026-11-09', 'C'), hist('2026-11-16', 'A')], drops);
  assert.deepEqual(b.eligiblePool(pool, h, '2026-11-23', S).map(p => p.boss), ['B']);
});

test('pick choices: random, no repeats, at most Pick_Options', () => {
  const pool = poolOf(Array.from({ length: 30 }, (_, i) => `Boss${i}`));
  const choices = b.pickChoices(pool, [], '2026-11-30', S);
  assert.equal(choices.length, 20);
  assert.equal(new Set(choices.map(c => c.boss)).size, 20);
});

test('history row is a full copy of the bounty with who chose it', () => {
  const [p] = b.parseBounties([{ boss: 'Telos', parts: ['Nex', '', ''], firstPoints: 15, laterPoints: 10, active: true }], drops);
  assert.deepEqual(b.historyRow(p, '2026-11-30', { chosenBy: 'Donini', chosenById: '1' }), {
    weekOf: '2026-11-30', boss: 'Telos', firstPoints: 15, laterPoints: 10, parts: ['Nex', '', ''],
    codeWord: '', grand: false, chosenBy: 'Donini', chosenById: '1'
  });
});

test('shop: Delivered How "pick" marks the pick item', () => {
  const [pick] = b.parseShop([{ item: "Pick next week's bounty", cost: 50, stock: '', active: true, deliveredHow: 'pick' }]);
  assert.equal(pick.isPick, true);
  assert.equal(pick.isWheel, false);
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

// --- donations and gifts ---------------------------------------------------
test('shop marks donate and gift rows; Cost is the minimum', () => {
  const [d, g] = b.parseShop([
    { item: 'Donate', cost: 1, active: true, deliveredHow: 'donate' },
    { item: 'Gift', cost: '2,5', active: true, deliveredHow: ' GIFT ' }
  ]);
  assert.equal(d.isDonate, true);
  assert.equal(g.isGift, true);
  assert.equal(b.minTransfer(d), 1);
  assert.equal(b.minTransfer(g), 3);
});

test('gifts and donations move the wallet but never earned or leaderboards', () => {
  const t = Date.UTC(2026, 10, 18);
  const pts = [
    { time: t, player: 'A', playerId: '1', change: 20, type: 'claim', opId: 'a' },
    { time: t, player: 'A', playerId: '1', change: -5, type: 'gift', opId: 'b-out' },
    { time: t, player: 'B', playerId: '2', change: 5, type: 'gift', opId: 'b-in' },
    { time: t, player: 'A', playerId: '1', change: -3, type: 'donation', opId: 'c' }
  ];
  assert.deepEqual(b.balances(pts, '1', t), { wallet: 12, earned: 20, month: 20 });
  assert.deepEqual(b.balances(pts, '2', t), { wallet: 5, earned: 0, month: 0 });
  assert.deepEqual(b.standings(pts).map(r => r.playerId), ['1']);
});

test('weekly gift total resets on Monday 00:00 UTC and ignores gifts received', () => {
  const monday = Date.UTC(2026, 10, 16);
  const pts = [
    { time: monday - 1, playerId: '1', change: -20, type: 'gift', opId: 'old' },
    { time: monday, playerId: '1', change: -7, type: 'gift', opId: 'new' },
    { time: monday, playerId: '1', change: -7, type: 'gift', opId: 'new' },
    { time: monday + 1, playerId: '1', change: 9, type: 'gift', opId: 'in' },
    { time: monday + 1, playerId: '1', change: -4, type: 'shop', opId: 'shop' }
  ];
  assert.equal(b.giftedThisWeek(pts, '1', monday + b.DAY), 7);
  assert.equal(b.readSettings({}).giftWeeklyLimit, 25);
  assert.equal(b.readSettings({ Gift_Weekly_Limit: 0 }).giftWeeklyLimit, 0);
});

test('transfer amounts are whole, above the minimum and affordable', () => {
  assert.equal(b.parseAmount(' 12 '), 12);
  for (const bad of ['1.5', '-3', 'ten', '']) assert.equal(b.parseAmount(bad), null);
  const check = (amount, giftLeft = null) => b.transferProblem({ amount, min: 2, wallet: 10, giftLeft });
  assert.equal(check(5), null);
  assert.match(check(null), /whole number/);
  assert.match(check(1), /minimum/);
  assert.match(check(11), /only have/);
  assert.match(check(5, 4), /4 more/);
  assert.equal(b.cleanText(' a\n\n  b ', 10), 'a b');
  assert.equal(b.cleanText('a\n\n\n\nb', 10, { lines: true }), 'a\n\nb');
});

// --- shop extras ------------------------------------------------------------
{
  const x = require('../extras');
  const T0 = Date.UTC(2026, 10, 23, 12);
  const week = '2026-11-23';
  const open = [{ weekOf: week, boss: 'Nex', postedAt: T0, parts: [] }];
  const closed = [...open, { weekOf: '2026-11-30', boss: 'Zuk', postedAt: T0 + 7 * b.DAY, parts: [] }];
  const stake = (id, n, ref, type = 'sponsor') => ({ time: T0 + 1, player: `P${id}`, playerId: id, change: -n, type, ref, opId: `s${id}${ref}` });
  const claim = (id, t, first = true) => ({ time: t, player: `P${id}`, playerId: id, change: 10, type: first ? 'first claim' : 'claim', weekOf: week, ref: b.claimRef(week, id), opId: `c${id}` });
  const voidOf = id => ({ time: T0 + 9, player: `P${id}`, playerId: id, change: -10, type: 'void', weekOf: week, ref: b.claimRef(week, id), opId: `v${id}` });
  const pay = (pts, bounties, at = T0 + 5) => x.settlements(pts, bounties, S, at);
  const apply = (pts, rows) => [...pts, ...rows.map(r => ({ ...r, time: T0 + 8 }))];

  test('sponsor pot: waits, goes to the first claimer, once only', () => {
    let pts = [stake('1', 5, x.sponsorRef(week)), stake('2', 10, x.sponsorRef(week))];
    assert.equal(x.potOf(pts, week), 15);
    assert.deepEqual(pay(pts, open), []);
    pts.push(claim('3', T0 + 2));
    const rows = pay(pts, open);
    assert.deepEqual(rows.map(r => [r.playerId, r.change]), [['3', 15]]);
    pts = apply(pts, rows);
    assert.deepEqual(pay(pts, open), []);
    assert.equal(b.balances(pts, '3', T0).earned, 10); // the pot is never "earned"
    assert.match(x.sponsorProblem(open[0], pts, open, S, T0 + 5), /already been claimed/);
  });

  test('sponsor pot: refunded when the bounty closes unclaimed', () => {
    const pts = [stake('1', 5, x.sponsorRef(week)), stake('2', 10, x.sponsorRef(week))];
    assert.deepEqual(pay(pts, closed, T0 + 8 * b.DAY).map(r => [r.playerId, r.change]), [['1', 5], ['2', 10]]);
  });

  test('sponsor pot: a voided winner loses it and the next claimer gets it', () => {
    let pts = [stake('1', 5, x.sponsorRef(week)), claim('3', T0 + 2), claim('4', T0 + 3, false)];
    pts = apply(pts, pay(pts, open));
    pts.push(voidOf('3'));
    const rows = pay(pts, open);
    assert.deepEqual(rows.map(r => [r.playerId, r.change]).sort(), [['3', -5], ['4', 5]]);
    assert.equal(new Set(rows.map(r => r.opId)).size, 2);
    assert.deepEqual(pay(apply(pts, rows), open), []);
  });

  test('duel: unanswered or declined refunds, accepted pays the first claimer', () => {
    const ref = x.duelRef({ weekOf: week, a: '1', b: '2', stake: 5, created: T0 });
    const a = stake('1', 5, ref, 'duel');
    assert.equal(x.openDuelOf('2', [a], open, S, T0 + 1).ref, ref);
    assert.deepEqual(pay([a], open), []);
    assert.deepEqual(pay([a], open, T0 + 25 * b.HOUR).map(r => [r.playerId, r.change]), [['1', 5]]);
    const no = { time: T0 + 2, playerId: '2', change: 0, type: 'duel', ref: `duelend:${x.duelTail(ref)}`, opId: 'no' };
    assert.deepEqual(pay([a, no], open).map(r => [r.playerId, r.change]), [['1', 5]]);
    const both = [a, stake('2', 5, ref, 'duel')];
    assert.deepEqual(pay(both, open, T0 + 30 * b.HOUR), []); // accepted: no time limit
    assert.deepEqual(pay(both, closed, T0 + 8 * b.DAY).map(r => [r.playerId, r.change]), [['1', 5], ['2', 5]]);
    const won = [...both, claim('9', T0 + 2), claim('2', T0 + 3, false)];
    assert.deepEqual(pay(won, open).map(r => [r.playerId, r.change]), [['2', 10]]);
    assert.equal(x.openDuelOf('1', won, open, S, T0 + 5), null);
  });

  test('clan goal counts donations from its start point; the goal row is not for sale', () => {
    const shop = b.parseShop([{ item: 'Party', cost: 100, active: true, deliveredHow: 'goal' }]);
    assert.equal(shop[0].isGoal, true);
    const pts = [{ time: 1, playerId: '1', change: -30, type: 'donation', opId: 'd' }];
    assert.equal(x.goalState(shop, pts, { goalBase: null }).progress, 0);
    assert.deepEqual([x.goalState(shop, pts, { goalBase: 10 }).progress, x.goalState(shop, pts, { goalBase: 10 }).target], [20, 100]);
    assert.equal(x.progressBar(50, 100), '▰▰▰▰▰▱▱▱▱▱');
    assert.equal(x.progressBar(500, 100), '▰'.repeat(10));
  });

  test('bought code word gets digits and only applies to its week', () => {
    assert.ok(x.validWord('Banana'));
    for (const bad of ['ab', 'two words', 'abc1']) assert.equal(x.validWord(bad), false);
    assert.match(x.boughtCodeWord('banana', week, 'salt'), /^Banana\d\d$/);
    const s = { nextCodeWord: 'Banana', nextCodeWordWeek: week };
    assert.equal(x.wordForPost(s, T0), 'Banana');
    assert.equal(x.wordForPost(s, T0 + 7 * b.DAY), '');
    assert.equal(x.wordTaken(s, week), true);
    assert.equal(x.wordTaken(s, '2026-11-30'), false);
  });

  test("winner's emoji: one emoji only, lasts 30 days, newest wins", () => {
    assert.equal(x.parseEmoji('🐉'), '🐉');
    assert.equal(x.parseEmoji('🐉🐉'), null);
    assert.equal(x.parseEmoji('hello'), null);
    const custom = '<:gz:123456789012345678>';
    assert.equal(x.parseEmoji(custom), null);
    assert.equal(x.parseEmoji(custom, id => id === '123456789012345678'), custom);
    const row = (d, t) => ({ time: t, playerId: '1', change: -15, type: 'shop', detail: `Emoji: ${d}`, ref: x.emojiRef('1'), opId: d });
    const pts = [row('🐉', T0), row('🔥', T0 + 1)];
    assert.equal(x.activeEmoji(pts, '1', T0 + 2), '🔥');
    assert.equal(x.activeEmoji(pts, '1', T0 + 31 * b.DAY), null);
  });
}

test("Closed_Bounties shuts a posted bounty but it still counts as that week's post", () => {
  const s1 = b.readSettings({ Closed_Bounties: "2026-11-16, 9/11/2026" });
  assert.deepEqual(s1.closedWeeks, ["2026-11-16", "2026-11-09"]);
  assert.deepEqual(b.readSettings({}).closedWeeks, []);
  const at = Date.parse("2026-11-22T10:55:00Z");
  const list = [{ weekOf: "2026-11-16", boss: "Gate", postedAt: at, messageId: "" }];
  assert.equal(b.openBounties(list, at + 3600e3, b.readSettings({})).length, 1);
  assert.equal(b.openBounties(list, at + 3600e3, s1).length, 0);
  assert.equal(b.closesAt(list, list[0], s1), at);
});

console.log(`bounty: ${passed} tests passed`);
