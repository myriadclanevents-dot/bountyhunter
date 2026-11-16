const assert = require('node:assert/strict');
const b = require('../bounty');
const e = require('../embeds');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (err) { console.error(`✗ ${name}`); throw err; }
};

const drops = ['Wraps', 'Codex'].map(item => ({ boss: 'Kerapac', item }));
const S = b.readSettings({ Submissions_Channel_ID: '123' });
const bounty = b.parseBounty({ weekOf: '2026-11-23', boss: 'Kerapac', parts: ['Kerapac', 'Wraps, Codex'], active: true, postedAt: Date.parse('2026-11-23T14:00:00Z') }, drops);

test('fresh board shows parts, points and multiplier time', () => {
  const view = e.bountyView(bounty, { claims: [], inProgress: 0, settings: S, now: bounty.postedAt + 1000, closed: false });
  const emb = e.boardEmbed(bounty, view, S);
  assert.equal(emb.title, 'Kerapac');
  assert.match(emb.author.name, /WEEK OF 23 NOV 2026/);
  assert.ok(emb.fields.some(f => f.name === 'Part 2'));
  assert.ok(emb.fields.some(f => f.name.startsWith('×2')));
  assert.match(emb.description, /<#123>/);
});

test('multiplier state doubles the shown first-claim points', () => {
  const view = e.bountyView(bounty, { claims: [], inProgress: 2, settings: S, now: bounty.postedAt + 73 * b.HOUR, closed: false });
  const emb = e.boardEmbed(bounty, view, S);
  assert.match(emb.title, /×2 ACTIVE/);
  assert.match(emb.description, /20 points/);
  assert.ok(emb.fields.some(f => f.name === 'In progress'));
});

test('claimed state lists claimers with the first one', () => {
  const claims = [
    { player: 'Valxen', change: 20, type: 'first claim', time: bounty.postedAt + 80 * b.HOUR, detail: 'Kerapac ×2' },
    { player: 'Donini', change: 5, type: 'claim', time: bounty.postedAt + 90 * b.HOUR }
  ];
  const view = e.bountyView(bounty, { claims, inProgress: 0, settings: S, now: bounty.postedAt + 100 * b.HOUR, closed: false });
  const emb = e.boardEmbed(bounty, view, S);
  assert.match(emb.title, /FIRST CLAIM TAKEN/);
  const by = emb.fields.find(f => f.name.startsWith('Claimed by'));
  assert.equal(by.value, '🥇 Valxen · +20\n2. Donini · +5');
});

test('leaderboard table lines up', () => {
  const t = e.table([{ player: '1Shylybored', points: 120, claims: 13, firsts: 3 }, { player: 'Tune O', points: 5, claims: 1, firsts: 0 }]);
  const lines = t.split('\n').slice(1, -1);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /1Shylybored\s+120\s+13\s+3$/);
});

test('progress embed marks finished parts', () => {
  const view = e.bountyView(bounty, { claims: [], inProgress: 1, settings: S, now: bounty.postedAt, closed: false });
  const progress = b.progressFor(bounty, [{ messageId: 'm', playerId: '1', part: 1, item: 'Wraps', status: 'approved', weekOf: '2026-11-23' }], '1');
  const emb = e.progressEmbed(bounty, view, progress, null, S);
  assert.match(emb.description, /✅ Part 1/);
  assert.match(emb.description, /⬜ Part 2/);
});

test('code word shown on open bounties, hidden once closed', () => {
  const withWord = { ...bounty, codeWord: 'Wyvern37' };
  const open = e.boardEmbed(withWord, e.bountyView(withWord, { claims: [], inProgress: 0, settings: S, now: bounty.postedAt, closed: false }), S);
  assert.equal(open.fields[0].name, '🔑 Code word');
  assert.match(open.fields[0].value, /Wyvern37/);
  assert.match(open.description, /code word/);
  const closed = e.boardEmbed(withWord, e.bountyView(withWord, { claims: [], inProgress: 0, settings: S, now: bounty.postedAt, closed: true }), S);
  assert.ok(!closed.fields.some(f => f.name.includes('Code word')));
  const prog = e.progressEmbed(withWord, e.bountyView(withWord, { claims: [], inProgress: 0, settings: S, now: bounty.postedAt, closed: false }), b.progressFor(withWord, [], '1'), null, S);
  assert.match(prog.description, /Wyvern37/);
  assert.match(e.newBountyEmbed(withWord, 'u').description, /Wyvern37/);
});

test('wheel: odds in the buy confirmation, frames point at the right prize', () => {
  const prizes = b.parseWheel([
    { prize: '+5 pts', weight: 75, points: 5 },
    { prize: 'Bond', weight: 25, kind: 'item' }
  ]);
  const confirm = e.confirmBuyEmbed({ item: 'Spin', cost: 10, isWheel: true }, 50, prizes);
  assert.match(confirm.description, /`   75%` \+5 pts/);
  assert.match(confirm.description, /`   25%` Bond 🎁/);
  assert.doesNotMatch(e.confirmBuyEmbed({ item: 'GP', cost: 10 }, 50, prizes).description, /wheel/);

  const mid = e.spinFrameEmbed(prizes, 1, { player: 'Ana' });
  assert.match(mid.description, /▶️ \*\*Bond 🎁\*\*/);
  assert.match(mid.title, /Ana is spinning/);
  const end = e.spinFrameEmbed(prizes, 0, { player: 'Ana', done: true });
  assert.match(end.description, /Ana\*\* won \*\*\+5 pts/);
  assert.match(e.adminPurchaseEmbed({ id: 'W123', player: 'Ana', playerId: '1', item: 'Bond', cost: 0 }).description, /won \*\*Bond\*\* on the prize wheel/);
});

test('admin log shows who, what and the reason', () => {
  const d = e.adminLogEmbed({ admin: 'Mod', adminId: '9', action: 'bhgive', text: '➕ **+100 pts** for **Ana**', reason: 'Clan event win' }).description;
  assert.match(d, /\*\*Mod\*\* \(<@9>\) used `\/bhgive`/);
  assert.match(d, /\+100 pts/);
  assert.match(d, /Reason: Clan event win/);
  assert.equal(b.readSettings({ Shop_Admin_Channel_ID: '5' }).adminLogChannelId, '5');
  assert.equal(b.readSettings({ Shop_Admin_Channel_ID: '5', Admin_Log_Channel_ID: '7' }).adminLogChannelId, '7');
});

console.log(`embeds: ${passed} tests passed`);
