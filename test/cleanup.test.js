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

test('role message: a message link gives channel + message, emoji defaults to 🎯', () => {
  const s = b.readSettings({ Role_Message: 'https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333' });
  assert.equal(s.roleMessageId, '333333333333333333');
  assert.equal(s.roleChannelId, '222222222222222222');
  assert.equal(s.roleEmoji, '🎯');
  const id = b.readSettings({ Role_Message: '333333333333333333', Role_Emoji: '🏹' });
  assert.equal(id.roleMessageId, '333333333333333333');
  assert.equal(id.roleChannelId, '');           // just an id: the bot looks in the board channel
  assert.equal(id.roleEmoji, '🏹');
  assert.equal(b.readSettings({}).roleMessageId, '');
  const two = b.readSettings({ Role_Message: 'https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333, 444444444444444444\nhttps://discord.com/channels/111111111111111111/555555555555555555/666666666666666666 444444444444444444' });
  assert.deepEqual(two.roleMessages, [
    { channelId: '222222222222222222', messageId: '333333333333333333' },
    { channelId: '', messageId: '444444444444444444' },
    { channelId: '555555555555555555', messageId: '666666666666666666' }
  ]);
  assert.equal(two.roleMessageId, '333333333333333333');
  assert.deepEqual(b.readSettings({}).roleMessages, []);
});

test('role replies: welcome, funny "already", removed', () => {
  const s = b.readSettings({});
  assert.equal(e.roleGivenText('Ana', s).startsWith('🎯 **Welcome to the hunt, Ana!**'), true);
  assert.equal(e.roleGivenText('Ana', s).includes('Remove your 🎯 reaction'), true);
  assert.equal(e.roleAlreadyText(0), e.ROLE_ALREADY[0]);
  assert.equal(e.roleAlreadyText(0.9999), e.ROLE_ALREADY[e.ROLE_ALREADY.length - 1]);
  assert.equal(e.roleAlreadyText(1), e.ROLE_ALREADY[e.ROLE_ALREADY.length - 1]); // never undefined
  assert.equal(e.roleRemovedText(s).includes('React 🎯 again'), true);
});

test('role pings: new bounty always (when a role is set), the others only when TRUE', () => {
  const R = '1407815148286251119';
  const bounty = { boss: 'Nex' };
  assert.deepEqual(e.rolePing('new', S, { bounty }), {});                       // no role set: no ping
  const on = b.readSettings({ Bounty_Ping_Role_ID: R, Multiplier: '1,5' });
  assert.equal(on.pingRoleId, R);
  assert.equal(b.readSettings({ Bounty_Ping_Role_ID: '<@&' + R + '>' }).pingRoleId, R); // pasted as a mention
  const n = e.rolePing('new', on, { bounty });
  assert.equal(n.content, '<@&' + R + '> 🎯 A new bounty is up: **Nex**!');
  assert.deepEqual(n.allowedMentions, { parse: [], roles: [R] });
  assert.equal(e.rolePing('new', on, { bounty, grand: 200 }).content.includes('GRAND BOUNTY** is up: **Nex** · 200M GP'), true);
  assert.deepEqual(e.rolePing('multiplier', on, { bounty }), {});               // off by default
  assert.deepEqual(e.rolePing('first', on, { bounty, player: 'Ana' }), {});
  const all = b.readSettings({ Bounty_Ping_Role_ID: R, Multiplier: '1,5', Ping_On_Multiplier: 'TRUE', Ping_On_First_Claim: 'TRUE' });
  assert.match(e.rolePing('multiplier', all, { bounty }).content, /×1,5/);
  assert.equal(e.rolePing('first', all, { bounty, player: 'Ana' }).content.includes('**Ana** claimed the **Nex** bounty first'), true);
});

console.log(`cleanup: ${passed} tests passed`);
