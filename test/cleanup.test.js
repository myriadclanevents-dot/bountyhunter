const assert = require('node:assert/strict');
const b = require('../bounty');
const e = require('../embeds');
const cl = require('../cleanup');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (err) { console.error(`✗ ${name}`); throw err; }
};
const DAY = b.DAY;
const S = b.readSettings({});
const T = Date.UTC(2026, 11, 1);

test('settings: 7 / 14 / 30 days by default, 0 = off', () => {
  assert.equal(S.cleanupDays, 7); assert.equal(S.bountyCompactDays, 14); assert.equal(S.bountyDeleteDays, 30);
  assert.equal(b.readSettings({ Cleanup_After_Days: '0' }).cleanupDays, 0);
});

test('closed stages: list, then one line after 14 days, deleted after 30', () => {
  assert.equal(cl.closedStage(Infinity, T, S), 'open');
  assert.equal(cl.closedStage(T + 1, T, S), 'open');
  assert.equal(cl.closedStage(T, T, S), 'list');
  assert.equal(cl.closedStage(T - 13 * DAY, T, S), 'list');
  assert.equal(cl.closedStage(T - 14 * DAY, T, S), 'line');
  assert.equal(cl.closedStage(T - 30 * DAY, T, S), 'delete');
  assert.equal(cl.closedStage(T - 90 * DAY, T, { ...S, bountyDeleteDays: 0 }), 'line');
  assert.equal(cl.closedStage(T - 90 * DAY, T, { ...S, bountyDeleteDays: 0, bountyCompactDays: 0 }), 'list');
});

test('cleanup: only the bot\'s own, unpinned, old messages that are not big moments', () => {
  const o = { botId: 'bot', now: T, days: 7, keepIds: new Set(['b1']) };
  const old = { id: 'm', authorId: 'bot', createdAt: T - 8 * DAY, pinned: false, titles: [] };
  assert.equal(cl.shouldDelete(old, o), true);
  assert.equal(cl.shouldDelete({ ...old, titles: ['🥇 First claim! Ana takes the Nex bounty'] }, o), true);
  assert.equal(cl.shouldDelete({ ...old, createdAt: T - 6 * DAY }, o), false);   // too new
  assert.equal(cl.shouldDelete({ ...old, authorId: 'player' }, o), false);       // a player's message
  assert.equal(cl.shouldDelete({ ...old, pinned: true }, o), false);             // guide / bounty pins
  assert.equal(cl.shouldDelete({ ...old, id: 'b1' }, o), false);                 // a bounty post
  assert.equal(cl.shouldDelete({ ...old, titles: ['🏆 GRAND BOUNTY WON! Ana wins 150M GP'] }, o), false);
  assert.equal(cl.shouldDelete({ ...old, titles: ['🎟️ Monthly draw for December 2026: Ana wins 150M GP!'] }, o), false);
  assert.equal(cl.shouldDelete({ ...old, titles: ['🏆 Bounty Hunters of December 2026'] }, o), false);
  assert.equal(cl.shouldDelete({ ...old, titles: [e.GUIDE_TITLE] }, o), false);
  assert.equal(cl.shouldDelete(old, { ...o, days: 0 }), false);                  // switched off
});

test('closed post: short, claim list; one line later', () => {
  const bounty = { weekOf: '2026-11-16', boss: 'Nex', parts: [{ label: 'x' }], codeWord: 'Wyvern37', postedAt: T };
  const claims = [{ player: 'Diodegro', change: 10 }, { player: 'Ana', change: 5 }, { player: 'Bo', change: 5 }];
  const view = { closed: true, first: claims[0], claims, pot: 0, grand: 0 };
  const full = e.boardEmbed(bounty, view, S);
  assert.equal(full.title, 'Nex · CLOSED');
  assert.match(full.author.name, /WEEK OF/);
  assert.match(full.description, /Diodegro\*\* claimed it first for \*\*10 points/);
  assert.equal(full.fields.length, 1); // no parts, no code word, no point fields
  assert.equal(full.fields[0].name, 'Claimed by (3)');
  assert.equal(full.fields[0].value, '🥇 Diodegro · +10\n2. Ana · +5\n3. Bo · +5');
  const line = e.boardEmbed(bounty, { ...view, oneLine: true }, S);
  assert.equal(line.fields[0].value, 'Diodegro, Ana, Bo');
  const none = e.boardEmbed(bounty, { ...view, first: null, claims: [] }, S);
  assert.equal(none.fields.length, 0);
  assert.match(none.description, /Nobody claimed/);
  const grand = e.boardEmbed(bounty, { ...view, grand: 200 }, S);
  assert.equal(grand.fields[0].value, '**200M GP** won by Diodegro');
});

console.log(`cleanup: ${passed} tests passed`);
