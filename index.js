// Bounty Hunter — Myriad Events Bot, always-on module.
//
// Runs as its OWN process next to whichever event bot (bingo / drop race) is
// live, using the same Discord application. To share it safely:
//   • it only touches commands whose names start with "bh" (never a bulk overwrite);
//   • it re-adds its commands every few minutes, because the event bots DO bulk
//     overwrite when they start;
//   • it only reads the channels named in the Settings tab.

require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials, Events, REST, Routes, SlashCommandBuilder,
  MessageFlags, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, escapeMarkdown
} = require('discord.js');

const sheet = require('./sheet');
const b = require('./bounty');
const e = require('./embeds');
const x = require('./extras');
const pz = require('./prizes');
const cl = require('./cleanup');
const { MESSAGE_MAX, NOTE_MAX, donateModal, giftModal, sponsorModal, duelModal, wordModal, emojiModal } = require('./donations');
const { parseSubmission, buildMatcher, findItem } = require('./matching');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const SHEET_URL = process.env.SHEET_URL;

for (const [k, v] of Object.entries({ DISCORD_TOKEN: TOKEN, CLIENT_ID, GUILD_ID, SHEET_URL })) {
  if (!v) { console.error(`❌ ${k} is not set (see .env.example).`); process.exit(1); }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
});

const TARGET = '🎯';
const QUESTION = '❓';
const DELIVERED = '✅';
const NO_PINGS = { parse: [] };

// Secret salt for the bot's code words: derived from the token, so it never
// appears in the code or the sheet and can't be guessed before a bounty is posted.
// An admin-typed Code Word in the Bounties tab always wins.
const CODE_SALT = require('crypto').createHash('sha256').update(String(TOKEN)).digest('hex').slice(0, 16);
const withCode = bounty => ({ ...bounty, codeWord: bounty.codeWord || b.codeWordFor(bounty.weekOf, CODE_SALT) });

// Every write runs one at a time, so two approvals can never both be "first".
let chain = Promise.resolve();
function queue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const S = () => sheet.getSettings();
const now = () => Date.now();
let playersDirty = false;

// ---------------------------------------------------------------------------
// Small Discord helpers
// ---------------------------------------------------------------------------

async function displayName(guild, user) {
  const member = await guild?.members.fetch(user.id).catch(() => null);
  return member?.displayName || user.globalName || user.username;
}

async function isAdmin(guild, userId) {
  if (sheet.isApproverId(userId)) return true;
  const member = await guild?.members.fetch(userId).catch(() => null);
  return Boolean(member?.permissions.has(PermissionFlagsBits.ManageGuild));
}

function sameEmoji(emoji, wanted) {
  const w = String(wanted || '').trim();
  return emoji.name === w || emoji.toString() === w || (emoji.id && emoji.id === w);
}

async function fetchChannel(id) {
  if (!id) return null;
  return client.channels.fetch(id).catch(err => { console.error(`⚠️ Can't open channel ${id}: ${err.message}`); return null; });
}

async function removeOwnReaction(message, emoji) {
  await message.reactions.cache.get(emoji)?.users.remove(client.user.id).catch(() => {});
}

const crypto = require('crypto');
const fairRandom = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32; // [0, 1), not predictable
const sleep = ms => new Promise(r => setTimeout(r, ms));

const reply = (message, content) => message.reply({ content, allowedMentions: NO_PINGS }).catch(err =>
  console.error(`⚠️ Could not reply in submissions: ${err.message}`));

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

// Admin commands are hidden from members without "Manage Server". Server settings →
// Integrations overrides don't last: event bots re-create our commands (new ids) and
// per-command overrides are lost. The bot still checks isAdmin() on every use.
const ADMIN_ONLY = PermissionFlagsBits.ManageGuild;
const commands = [
  new SlashCommandBuilder().setName('bhbounty').setDescription("This week's bounty and your progress"),
  new SlashCommandBuilder().setName('bhme').setDescription('Your wallet, points earned and rank')
    .addUserOption(o => o.setName('player').setDescription('Look up someone else').setRequired(false)),
  new SlashCommandBuilder().setName('bhtop').setDescription('Bounty Hunter leaderboard')
    .addStringOption(o => o.setName('period').setDescription('Which leaderboard').setRequired(false)
      .addChoices({ name: 'This month', value: 'month' }, { name: 'All time', value: 'all' })),
  new SlashCommandBuilder().setName('bhshop').setDescription('What you can buy with bounty points'),
  new SlashCommandBuilder().setName('bhbuy').setDescription('Spend bounty points in the shop'),
  new SlashCommandBuilder().setName('bhpast').setDescription('Earlier bounties and who claimed them first'),
  new SlashCommandBuilder().setName('bhvoid').setDescription('ADMIN: undo an approved bounty submission').setDefaultMemberPermissions(ADMIN_ONLY)
    .addStringOption(o => o.setName('message').setDescription('Link (or ID) of the submission message').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Why it is undone (shown in the admin log)').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder().setName('bhgive').setDescription('ADMIN: add or remove points by hand').setDefaultMemberPermissions(ADMIN_ONLY)
    .addUserOption(o => o.setName('player').setDescription('Who').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Points (negative to remove)').setRequired(true).setMinValue(-1000).setMaxValue(1000))
    .addStringOption(o => o.setName('reason').setDescription('Shown in the Points tab').setRequired(true)),
  new SlashCommandBuilder().setName('bhpost').setDescription('ADMIN: post a bounty now (next Monday\'s bounty still comes as normal)').setDefaultMemberPermissions(ADMIN_ONLY),
  new SlashCommandBuilder().setName('bhreload').setDescription('ADMIN: re-read the Google Sheet and refresh the bounty post').setDefaultMemberPermissions(ADMIN_ONLY),
  new SlashCommandBuilder().setName('bhhelp').setDescription('How Bounty Hunter works and all its commands')
].map(c => c.toJSON());

const optShape = opts => JSON.stringify((opts || []).map(o => [o.type, o.name, o.description, Boolean(o.required),
  (o.choices || []).map(c => [c.name, c.value]), o.min_value ?? null, o.max_value ?? null]));

/**
 * Creates/updates only OUR commands (POST upserts one command by name and
 * leaves every other command alone). Never a bulk overwrite.
 */
const commandIds = {}; // name -> id; changes when an event bot wipes + we re-add
async function ensureCommands({ quiet = false } = {}) {
  const helpBefore = commandIds.bhhelp;
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID);
  try {
    const existing = await rest.get(route);
    let changed = 0;
    for (const cmd of commands) {
      const have = existing.find(c => c.name === cmd.name);
      const samePerms = String(have?.default_member_permissions ?? '') === String(cmd.default_member_permissions ?? '');
      if (have && samePerms && have.description === cmd.description && optShape(have.options) === optShape(cmd.options)) { commandIds[cmd.name] = have.id; continue; }
      const made = await rest.post(route, { body: cmd });
      commandIds[cmd.name] = made.id;
      changed++;
    }
    for (const c of existing) {
      if (c.name.startsWith('bh') && !commands.some(x => x.name === c.name)) {
        await rest.delete(Routes.applicationGuildCommand(CLIENT_ID, GUILD_ID, c.id));
        changed++;
      }
    }
    if (changed) console.log(`✅ Bounty commands: ${changed} added/updated (another bot may have reset them).`);
    if (helpBefore && helpBefore !== commandIds.bhhelp) await refreshBoards(); // re-link /bhhelp in the pinned post
    else if (!quiet) console.log(`✅ Bounty commands already registered (${commands.length}).`);
  } catch (err) {
    console.error(`❌ Could not register commands: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// The pinned bounty post
// ---------------------------------------------------------------------------

function viewFor(bounty, at = now()) {
  const points = sheet.getPoints();
  const claims = b.activeClaims(points, bounty.weekOf);
  const inProgress = b.inProgressCount(bounty, b.activeSubmissions(sheet.getSubmissions()), claims);
  const closed = at >= b.closesAt(sheet.getBounties(), bounty, S());
  return e.bountyView(bounty, { claims, inProgress, settings: S(), now: at, closed, pot: x.potOf(points, bounty.weekOf), grand: grandFor(bounty, at) });
}

/** Grand Bounty prize (M GP) for this bounty, or 0 when it doesn't carry one. */
function grandFor(bounty, at = now()) {
  const s = S();
  return pz.qualifies(bounty, s) ? pz.grandPotFor(sheet.getBounties(), sheet.getPoints(), bounty, s, at) : 0;
}

const lastRendered = new Map();

/** Re-renders the open bounty posts (and the one just closed), editing only what changed. */
/**
 * Keeps ONE pinned "how it works" guide in the board channel: finds the bot's
 * own pinned guide and edits it if the text changed, else posts + pins a new one.
 */
let lastGuide = '';
let guideUrl = null;
/** Links shown in bounty posts: the pinned guide + a clickable /bhhelp. */
const links = () => ({ guideUrl, helpCmd: commandIds.bhhelp ? `</bhhelp:${commandIds.bhhelp}>` : null });
async function ensureGuide() {
  const channel = await fetchChannel(S().boardChannelId);
  if (!channel) return;
  const embed = e.helpEmbed(S(), { pinned: true });
  const json = JSON.stringify(embed);
  if (json === lastGuide) return;
  try {
    const pins = await channel.messages.fetchPins();
    const old = pins.items.map(p => p.message)
      .find(m => m.author?.id === client.user.id && m.embeds[0]?.title === e.GUIDE_TITLE);
    if (old) {
      await old.edit({ embeds: [embed], allowedMentions: NO_PINGS });
      guideUrl = old.url;
    } else {
      const msg = await channel.send({ embeds: [embed], allowedMentions: NO_PINGS });
      await msg.pin();
      guideUrl = msg.url;
      console.log('📌 Posted and pinned the Bounty Hunter guide.');
    }
    lastGuide = json;
  } catch (err) {
    console.error(`⚠️ Could not post/pin the guide (needs Pin Messages + Read History): ${err.message}`);
  }
}

const goneBoards = new Set(); // bounty post ids already deleted (no need to fetch them again)

/**
 * Deletes the bot's small messages (claim announcements, alerts, gift notes, duels,
 * wheel spins, replies…) once they are older than Cleanup_After_Days. Pinned
 * messages, bounty posts and the big moments stay (cleanup.js decides).
 */
let cleaning = false;
async function cleanupChannels() {
  const s = S();
  if (cleaning || !(s.cleanupDays > 0)) return;
  cleaning = true;
  try {
    const ids = [...new Set([s.boardChannelId, s.awardsChannelId, s.submissionsChannelId, s.wheelChannelId].filter(Boolean))];
    const keepIds = new Set([...sheet.getBounties().map(x => x.messageId), ...s.roleMessages.map(r => r.messageId)].filter(Boolean));
    const t = now();
    const stopAt = t - (s.cleanupDays + 60) * b.DAY; // older than this was cleaned long ago
    let deleted = 0;
    for (const id of ids) {
      const channel = await fetchChannel(id);
      if (!channel?.messages) continue;
      let before;
      for (let page = 0; page < 5; page++) { // newest 500 messages at most
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
        if (!batch?.size) break;
        for (const m of batch.values()) {
          const msg = { id: m.id, authorId: m.author?.id, createdAt: m.createdTimestamp, pinned: m.pinned, titles: m.embeds.map(x => x.title) };
          if (!cl.shouldDelete(msg, { botId: client.user.id, now: t, days: s.cleanupDays, keepIds })) continue;
          if (await m.delete().then(() => true).catch(() => false)) deleted++;
        }
        const oldest = batch.last();
        if (!oldest || oldest.createdTimestamp < stopAt) break;
        before = oldest.id;
      }
    }
    if (deleted) console.log(`🧹 Cleaned up ${deleted} old bot message${deleted === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error(`⚠️ Channel cleanup failed: ${err.message}`);
  } finally {
    cleaning = false;
  }
}

async function refreshBoards() {
  const s = S();
  const posted = b.postedBounties(sheet.getBounties());
  if (!posted.length || !s.boardChannelId) return;
  const t = now();
  const open = b.openBounties(sheet.getBounties(), t, s);
  // Closed posts go short → one line → deleted (see cleanup.js). Only the last
  // 12 closed posts are looked at, so old ones aren't fetched again and again.
  const closed = posted.filter(x => !open.includes(x) && x.messageId && !goneBoards.has(x.messageId)).slice(-12);
  const targets = [...open.filter(x => x.messageId), ...closed];
  if (!targets.length) return;

  const channel = await fetchChannel(s.boardChannelId);
  if (!channel) return;
  for (const bounty of targets) {
    const stage = open.includes(bounty) ? 'open' : cl.closedStage(b.closesAt(sheet.getBounties(), bounty, s), t, s);
    if (stage === 'delete') {
      try {
        const msg = await channel.messages.fetch(bounty.messageId);
        await msg.delete();
        console.log(`🧹 Deleted the old bounty post for ${bounty.weekOf} (${bounty.boss}).`);
      } catch (err) {
        if (err.code !== 10008) { console.error(`⚠️ Could not delete the old bounty post for ${bounty.weekOf}: ${err.message}`); continue; }
      }
      goneBoards.add(bounty.messageId);
      continue;
    }
    const embed = e.boardEmbed(withCode(bounty), { ...viewFor(bounty), oneLine: stage === 'line' }, s, links());
    const key = JSON.stringify(embed);
    if (lastRendered.get(bounty.messageId) === key) continue;
    try {
      const msg = await channel.messages.fetch(bounty.messageId);
      // A closed post drops its "@role new bounty is up" line (editing never pings again).
      await msg.edit({ embeds: [embed], ...(stage !== 'open' && msg.content ? { content: '' } : {}) });
      lastRendered.set(bounty.messageId, key);
    } catch (err) {
      if (err.code === 10008 && open.includes(bounty)) { // post was deleted: put it back (same post time)
        try {
          const msg = await channel.send({ embeds: [embed] });
          await msg.pin().catch(() => {});
          await sheet.markPosted(bounty, bounty.postedAt, msg.id, bounty.codeWord || '');
          lastRendered.set(msg.id, key);
          console.log(`📌 Bounty post for ${bounty.weekOf} was deleted, re-posted it.`);
        } catch (e2) {
          console.error(`⚠️ Could not re-post the bounty for ${bounty.weekOf}: ${e2.message}`);
        }
      } else if (err.code === 10008) {
        goneBoards.add(bounty.messageId); // a closed post someone deleted: leave it
      } else {
        console.error(`⚠️ Could not update the bounty post for ${bounty.weekOf}: ${err.message}`);
      }
    }
  }
}

const warnedPost = new Set();
const warnedEmptyList = new Set();

/**
 * Monday post (`week` = that Monday): a player's pick, else a Bounties row
 * forced to that week, else random (no boss repeated within Repeat_Cooldown_Weeks).
 * Extra post (/bhpost after this Monday's bounty is up): random, NOW; it
 * never moves next Monday and a waiting pick stays for Monday.
 */
async function postWeek(week, { extra = false } = {}) {
  const history = sheet.getBounties();
  if (!extra && b.weekCovered(history, week)) return { ok: false, error: 'that week already has a bounty' };
  const date = extra ? b.isoDate(now()) : week;
  const plan = b.planWeek(sheet.getPool(), history, date, S(), fairRandom, { extra });
  if (!plan) {
    if (!warnedEmptyList.has(date)) console.warn(`⚠️ Nothing to post for ${date}: no active Bounties row has parts filled in. The current bounty stays open.`);
    warnedEmptyList.add(date);
    return { ok: false, error: 'the Bounties tab has no active bounty with parts filled in' };
  }
  const res = await postBounty(plan.bounty, plan.source);
  return { ...res, bounty: plan.bounty, extra };
}

async function postBounty(bounty, source = '') {
  const s = S();
  if (!bounty || bounty.postedAt) return { ok: false, error: 'nothing to post' };
  if (!bounty.parts.length) {
    if (!warnedPost.has(bounty.weekOf)) console.error(`❌ Bounty ${bounty.weekOf} has no parts filled in — not posting.`);
    warnedPost.add(bounty.weekOf);
    return { ok: false, error: `the ${bounty.weekOf} row has no parts filled in` };
  }
  const channel = await fetchChannel(s.boardChannelId);
  if (!channel) return { ok: false, error: 'Board_Channel_ID is missing or the bot cannot see that channel' };

  const previous = b.currentBounty(sheet.getBounties());
  const postedAt = now();
  const draft = withCode({ ...bounty, postedAt });
  // A code word a player bought for this week replaces the usual one.
  const boughtWord = x.wordForPost(s, postedAt);
  if (boughtWord) {
    draft.codeWord = x.boughtCodeWord(boughtWord, s.nextCodeWordWeek, CODE_SALT);
    bounty.codeWord = draft.codeWord;
  }
  const grand = grandFor(draft, postedAt);
  const view = e.bountyView(draft, { claims: [], inProgress: 0, settings: s, now: postedAt, closed: false, grand });
  const msg = await channel.send({ embeds: [e.boardEmbed(draft, view, s, links())], ...e.rolePing('new', s, { bounty: draft, grand }) });
  await msg.pin().catch(err => console.error(`⚠️ Could not pin the bounty (needs Pin Messages permission): ${err.message}`));
  await sheet.markPosted(bounty, postedAt, msg.id, draft.codeWord);
  if (boughtWord) await sheet.setSetting('Next_Code_Word', '');
  console.log(`🎯 Posted bounty ${bounty.weekOf}: ${bounty.boss}${source ? ` (${source}${bounty.chosenBy ? ` by ${bounty.chosenBy}` : ''})` : ''}`);

  if (previous?.messageId) {
    const old = await channel.messages.fetch(previous.messageId).catch(() => null);
    await old?.unpin().catch(() => {});
  }
  if (s.awardsChannelId && s.awardsChannelId !== s.boardChannelId) {
    const awards = await fetchChannel(s.awardsChannelId);
    await awards?.send({ embeds: [e.newBountyEmbed(draft, msg.url, s, links(), grand)] }).catch(() => {});
  }
  await refreshBoards();
  return { ok: true, url: msg.url };
}

// ---------------------------------------------------------------------------
// Approving a submission (admin reacts in the submissions channel)
// ---------------------------------------------------------------------------

const PART_ERRORS = {
  duplicate: 'already counted that item for this bounty (each part needs different items)',
  'part-done': 'already finished the part(s) that item counts for'
};

async function handleApproval(message, approverUser) {
  if (message.author.bot) return;
  if (!sheet.isAvailable()) { console.error('⚠️ Approval ignored: the sheet is not reachable.'); return; }
  if (b.isMessageApproved(sheet.getSubmissions(), message.id)) return; // already counted

  const s = S();
  const t = now();
  const player = await displayName(message.guild, message.author);
  const playerId = message.author.id;
  const approver = await displayName(message.guild, approverUser);

  const parsed = parseSubmission(message.content);
  if (parsed.error) {
    await reply(message, `${QUESTION} I couldn't find an item name in this message (${parsed.error}). Edit the message to say which drop it is, then remove and re-add ${s.approveEmoji}. (Help: /bhhelp)`);
    await message.react(QUESTION).catch(() => {});
    return;
  }

  const candidates = b.openBounties(sheet.getBounties(), t, s).filter(x => x.postedAt <= message.createdTimestamp);
  if (!candidates.length) {
    await reply(message, `${QUESTION} This was posted before the current bounty went up, so it can't count. (Help: /bhhelp)`);
    await message.react(QUESTION).catch(() => {});
    return;
  }

  let chosen = null;
  let problem = null;
  const active = b.activeSubmissions(sheet.getSubmissions());
  for (const bounty of candidates) {
    const match = findItem(buildMatcher(b.bountyItems(bounty).map(name => ({ name }))), parsed.itemName);
    if (!match) continue;
    if (b.activeClaims(sheet.getPoints(), bounty.weekOf).some(c => String(c.playerId) === playerId)) {
      problem ??= `${player} has already claimed the ${bounty.boss} bounty (one claim per player).`;
      continue;
    }
    const slot = b.assignPart(b.progressFor(bounty, active, playerId), match.item.name);
    if (slot.error) { problem ??= `${player} ${PART_ERRORS[slot.error] || 'cannot use that item here'}: **${match.item.name}**.`; continue; }
    chosen = { bounty, match, slot };
    break;
  }

  if (!chosen) {
    const current = candidates[0];
    await reply(message, `${QUESTION} ${problem || `"${parsed.itemName}" isn't part of the **${current.boss}** bounty. Check the spelling (see /bhbounty), edit the message, then remove and re-add ${s.approveEmoji}.`} (Help: /bhhelp)`);
    await message.react(QUESTION).catch(() => {});
    return;
  }

  const { bounty, match, slot } = chosen;
  await sheet.addSubmission({
    submittedAt: message.createdTimestamp, approvedAt: t, weekOf: bounty.weekOf, part: slot.index,
    item: match.item.name, player, playerId, approver, approverId: approverUser.id,
    messageLink: message.url, messageId: message.id, status: 'approved'
  });
  await removeOwnReaction(message, QUESTION);
  await message.react(TARGET).catch(() => {});
  const ownEmoji = x.activeEmoji(sheet.getPoints(), playerId, t);
  if (ownEmoji) await message.react(ownEmoji).catch(err => console.error(`⚠️ Could not add ${player}'s emoji: ${err.message}`));

  const readAs = match.exact ? '' : ` (read as **${match.item.name}**)`;
  const progress = b.progressFor(bounty, b.activeSubmissions(sheet.getSubmissions()), playerId);
  if (b.isComplete(progress)) {
    await awardClaim(bounty, { player, playerId, completedAt: message.createdTimestamp, approver, message, readAs });
  } else {
    const done = progress.filter(p => p.done).length;
    const part = progress[slot.index - 1];
    const partNote = part.part.need > 1 && !part.done ? ` (${part.items.length}/${part.part.need} items for part ${slot.index})` : '';
    await reply(message, `Approved by **${approver}**${readAs}. **${player}**: ${done} of ${progress.length} parts done for the **${bounty.boss}** bounty${partNote}. Keep going!`);
  }
  await refreshBoards();
}

async function awardClaim(bounty, { player, playerId, completedAt, approver, message, readAs }) {
  const s = S();
  const isFirst = b.activeClaims(sheet.getPoints(), bounty.weekOf).length === 0;
  const { points, multiplied } = b.claimPoints(bounty, s, { isFirst, completedAt });
  await sheet.addPoints({
    time: now(), player, playerId, change: points, type: isFirst ? b.TYPE_FIRST : b.TYPE_CLAIM,
    detail: `${bounty.boss}${multiplied ? ` ×${s.multiplier}` : ''}`, by: approver,
    weekOf: bounty.weekOf, ref: b.claimRef(bounty.weekOf, playerId)
  });
  playersDirty = true;

  await reply(message, `🎉 Approved by **${approver}**${readAs}. **${player}** completed the **${bounty.boss}** bounty: **+${points} points**${isFirst ? ' 🥇 first claim!' : ''}`);

  const all = sheet.getPoints();
  const claimNumber = b.activeClaims(all, bounty.weekOf).length;
  const balance = b.balances(all, playerId, now());
  const rank = b.rankOf(b.standings(all, b.monthRange(now())), playerId);
  const awards = await fetchChannel(s.awardsChannelId);
  await awards?.send({ embeds: [e.claimEmbed({ player, points, isFirst, multiplied, bounty, settings: s, claimNumber, balance, rank })], ...(isFirst ? e.rolePing('first', s, { bounty, player }) : {}) })
    .catch(err => console.error(`⚠️ Could not post in awards: ${err.message}`));
  if (isFirst) await awardGrand(bounty, { player, playerId });
  await settleExtras();
}

/** First finisher of a Grand Bounty: record the GP win once, announce it, ping the admins. */
async function awardGrand(bounty, { player, playerId }) {
  const s = S();
  if (!pz.qualifies(bounty, s)) return;
  const ref = pz.grandRef(bounty.weekOf);
  if (pz.prizeRow(sheet.getPoints(), ref)) return; // already won
  const amount = pz.grandPotFor(sheet.getBounties(), sheet.getPoints(), bounty, s, now());
  await sheet.addPoints({
    opId: ref, time: now(), player, playerId, change: 0, type: pz.TYPE_PRIZE,
    detail: `Grand Bounty ${bounty.boss}: ${amount}M GP`, by: 'bot', weekOf: bounty.weekOf, ref
  });
  console.log(`🏆 Grand Bounty ${bounty.weekOf} (${bounty.boss}) won by ${player}: ${amount}M GP`);
  const awards = await fetchChannel(s.awardsChannelId);
  await awards?.send({ embeds: [e.grandWinEmbed({ player, playerId, amount, bounty })], allowedMentions: { users: [playerId] } })
    .catch(err => console.error(`⚠️ Could not announce the Grand Bounty: ${err.message}`));
  await prizeAdminPing({ what: `Grand Bounty, ${bounty.boss}`, player, playerId, amount });
}

async function prizeAdminPing({ what, player, playerId, amount }) {
  const admin = await fetchChannel(S().shopAdminChannelId);
  const ping = await admin?.send({ embeds: [e.prizeAdminEmbed({ what, player, playerId, amount })], allowedMentions: NO_PINGS }).catch(() => null);
  if (ping) await ping.react(DELIVERED).catch(() => {});
  else console.error(`⚠️ ${player} won ${amount}M GP (${what}), but the admin ping could not be posted (check Shop_Admin_Channel_ID).`);
}

/** The monthly draw for the month that just ended. True when done (or nothing to do). */
async function runDraw(prevMs, prevKey) {
  const s = S();
  if (!(s.drawPrize > 0) || !s.drawSince) return true;
  const ref = pz.drawRef(prevKey);
  if (pz.prizeRow(sheet.getPoints(), ref)) return true;
  const entries = pz.drawTickets(sheet.getPoints(), b.monthRange(prevMs), s.drawSince);
  const winner = pz.drawWinner(entries, fairRandom());
  if (!winner) return true; // no claims that month: nothing to draw
  const amount = s.drawPrize;
  const res = await sheet.addPoints({
    opId: ref, time: now(), player: winner.player, playerId: winner.playerId, change: 0, type: pz.TYPE_PRIZE,
    detail: `Monthly draw ${prevKey}: ${amount}M GP (${winner.tickets} of ${entries.reduce((n, x2) => n + x2.tickets, 0)} tickets)`, by: 'bot', ref
  });
  // Kept in memory even if the sheet write failed (it was retried), so the draw is never run twice.
  if (res && res.ok === false) console.error(`❌ Monthly draw ${prevKey}: could not save the winner to the sheet. Add it by hand: ${winner.player}, ${amount}M GP.`);
  const monthName = new Date(prevMs).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  console.log(`🎟️ Monthly draw ${prevKey}: ${winner.player} wins ${amount}M GP`);
  const awards = await fetchChannel(s.awardsChannelId);
  await awards?.send({ embeds: [e.drawEmbed({ monthName, winner, amount, entries })], allowedMentions: { users: [winner.playerId] } })
    .catch(err => console.error(`⚠️ Could not announce the monthly draw: ${err.message}`));
  await prizeAdminPing({ what: `monthly draw, ${monthName}`, player: winner.player, playerId: winner.playerId, amount });
  return true;
}

/** First start with a prize switched on: remember when it began, so older bounties/claims don't count. */
async function startPrizes(t) {
  const s = S();
  if (s.grandPrize > 0 && !s.grandSince) {
    await sheet.setSetting('Grand_Bounty_Since', String(t));
    console.log('🏆 Grand Bounty switched on: bounties posted from now on can carry it.');
  }
  if (s.drawPrize > 0 && !s.drawSince) {
    await sheet.setSetting('Monthly_Draw_Since', String(t));
    console.log('🎟️ Monthly draw switched on: claims from now on are tickets.');
  }
}

// ---------------------------------------------------------------------------
// Shop: delivered ✅ in the admin channel
// ---------------------------------------------------------------------------

async function handleDelivered(message, user) {
  const footerId = /Purchase (\S+)/.exec(message.embeds[0]?.footer?.text || '')?.[1];
  const purchase = sheet.getPurchases().find(p => p.adminMessageId === message.id || p.id === footerId);
  if (!purchase || purchase.deliveredBy) return;
  const who = await displayName(message.guild, user);
  await sheet.setPurchaseDelivered(purchase.id, who);
  await message.edit({ embeds: [e.adminPurchaseEmbed(purchase, who)] }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Self-service role: react on the Role_Message to get the Bounty Hunter role
// ---------------------------------------------------------------------------

const isRoleReaction = (message, reaction, s) =>
  Boolean(s.pingRoleId && s.roleMessages.some(r => r.messageId === message.id) && sameEmoji(reaction.emoji, s.roleEmoji));

/**
 * Tells the player what happened: a DM, or (DMs closed) a short reply under the
 * role message that deletes itself after 20 seconds.
 */
async function tellPlayer(message, user, text) {
  const sent = await user.send({ content: text, allowedMentions: NO_PINGS }).then(() => true).catch(() => false);
  if (sent) return;
  const reply = await message.channel.send({ content: `<@${user.id}> ${text}`, allowedMentions: { users: [user.id] } }).catch(() => null);
  if (reply) setTimeout(() => reply.delete().catch(() => {}), 20 * 1000);
}

/** Gives (on = true) or takes away the Bounty_Ping_Role_ID role and tells the player. Needs "Manage Roles". */
async function setHunterRole(message, user, on) {
  const roleId = S().pingRoleId;
  try {
    const member = await message.guild.members.fetch(user.id);
    const has = member.roles.cache.has(roleId);
    if (on && has) { await tellPlayer(message, user, e.roleAlreadyText(Math.random())); return; }
    if (!on && !has) return;
    if (on) await member.roles.add(roleId, 'Reacted on the Bounty Hunter role message');
    else await member.roles.remove(roleId, 'Removed their reaction on the Bounty Hunter role message');
    console.log(`🎭 ${on ? 'Gave' : 'Removed'} the Bounty Hunter role ${on ? 'to' : 'from'} ${member.displayName}.`);
    await tellPlayer(message, user, on ? e.roleGivenText(member.displayName, S()) : e.roleRemovedText(S()));
  } catch (err) {
    console.error(`⚠️ Could not ${on ? 'give' : 'remove'} the Bounty Hunter role (needs Manage Roles, bot role above it): ${err.message}`);
  }
}

/** Makes sure every role message carries the bot's own reaction, so players only have to click it. */
let roleReactionDone = '';
async function ensureRoleReaction() {
  const s = S();
  const key = `${JSON.stringify(s.roleMessages)}/${s.roleEmoji}/${s.pingRoleId}`;
  if (!s.roleMessages.length || !s.pingRoleId || key === roleReactionDone) return;
  roleReactionDone = key; // don't retry every 5 minutes; /bhreload or a Settings change tries again
  for (const [n, r] of s.roleMessages.entries()) {
    const label = s.roleMessages.length > 1 ? ` ${n + 1}` : '';
    try {
      const channel = await fetchChannel(r.channelId || s.boardChannelId);
      const msg = await channel?.messages.fetch(r.messageId);
      if (!msg) throw new Error('message not found (paste the full message link in Role_Message)');
      const mine = msg.reactions.cache.find(x => sameEmoji(x.emoji, s.roleEmoji));
      if (!mine?.me) await msg.react(s.roleEmoji);
      console.log(`🎭 Role message${label} ready: react ${s.roleEmoji} to get the Bounty Hunter role.`);
    } catch (err) {
      console.error(`⚠️ Role message${label}: ${err.message}`);
    }
  }
}

/** True if the player still has the role emoji on ANOTHER role message (then removing one keeps the role). */
async function stillReactedElsewhere(messageId, userId, s) {
  for (const r of s.roleMessages) {
    if (r.messageId === messageId) continue;
    try {
      const channel = await fetchChannel(r.channelId || s.boardChannelId);
      const msg = await channel?.messages.fetch(r.messageId);
      const re = msg?.reactions.cache.find(x => sameEmoji(x.emoji, s.roleEmoji));
      if (re && (await re.users.fetch({ limit: 100 })).has(userId)) return true;
    } catch { /* message gone: ignore */ }
  }
  return false;
}

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    if (user.bot) return;
    const s = S();
    if (!s.roleMessages.length) return;
    if (reaction.partial) await reaction.fetch().catch(() => {});
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (isRoleReaction(message, reaction, s) && !(await stillReactedElsewhere(message.id, user.id, s))) await setHunterRole(message, user, false);
  } catch (err) {
    console.error(`❌ Reaction-remove handler failed: ${err.message}`);
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    const s = S();
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (isRoleReaction(message, reaction, s)) { await setHunterRole(message, user, true); return; }
    const ch = message.channel;
    const inSubs = s.submissionsChannelId && (ch.id === s.submissionsChannelId || ch.parentId === s.submissionsChannelId);
    const inShop = s.shopAdminChannelId && ch.id === s.shopAdminChannelId;
    if (!inSubs && !inShop) return;

    if (inShop && message.author.id === client.user.id && sameEmoji(reaction.emoji, DELIVERED)) {
      if (await isAdmin(message.guild, user.id)) await queue(() => handleDelivered(message, user));
      return;
    }
    if (inSubs && sameEmoji(reaction.emoji, s.approveEmoji)) {
      if (await isAdmin(message.guild, user.id)) await queue(() => handleApproval(message, user));
    }
  } catch (err) {
    console.error(`❌ Reaction handler failed: ${err.message}`);
    console.error(err.stack);
  }
});

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const ephemeral = payload => ({ ...payload, flags: MessageFlags.Ephemeral, allowedMentions: NO_PINGS });

async function needSheet(i) {
  if (sheet.isAvailable()) return true;
  await i.reply(ephemeral({ content: '⚠️ The Google Sheet can\'t be reached right now. Try again in a minute.' }));
  return false;
}

async function needAdmin(i) {
  if (await isAdmin(i.guild, i.user.id)) return true;
  await i.reply(ephemeral({ content: '⛔ Only bounty admins can use this.' }));
  return false;
}

/** Posts a manual admin action in the admin log channel (Admin_Log_Channel_ID, else the shop admin channel). */
async function logAdmin(i, action, text, reason = '') {
  const channel = await fetchChannel(S().adminLogChannelId);
  const admin = await displayName(i.guild, i.user);
  const sent = await channel?.send({ embeds: [e.adminLogEmbed({ admin, adminId: i.user.id, action, text, reason })], allowedMentions: NO_PINGS })
    .catch(err => console.error(`⚠️ Could not post in the admin log: ${err.message}`));
  if (!sent) console.log(`🛠️ ${admin} /${action}: ${text}${reason ? ` (reason: ${reason})` : ''}`);
}

function nextMondayText() {
  const nextMonday = b.dayMs(b.mondayOf(now())) + 7 * b.DAY;
  return `Monday ${e.weekLabel(b.isoDate(nextMonday))}`;
}

const handlers = {
  async bhhelp(i) {
    const admin = await isAdmin(i.guild, i.user.id).catch(() => false);
    return i.reply(ephemeral({ embeds: [e.helpEmbed(S(), { admin })] }));
  },

  async bhbounty(i) {
    if (!(await needSheet(i))) return;
    const bounty = b.currentBounty(sheet.getBounties());
    if (!bounty) return i.reply(ephemeral({ content: `No bounty has been posted yet. The next one goes up on ${nextMondayText()} (random hour, UTC).` }));
    if (now() >= b.closesAt(sheet.getBounties(), bounty, S()) && (S().closedWeeks || []).includes(bounty.weekOf)) {
      return i.reply(ephemeral({ content: `There is no open bounty right now. The next one goes up on ${nextMondayText()} (random hour, UTC).` }));
    }
    const view = viewFor(bounty);
    const progress = b.progressFor(bounty, b.activeSubmissions(sheet.getSubmissions()), i.user.id);
    const claim = view.claims.find(c => String(c.playerId) === i.user.id) || null;
    return i.reply(ephemeral({ embeds: [e.progressEmbed(withCode(bounty), view, progress, claim, S())] }));
  },

  async bhme(i) {
    if (!(await needSheet(i))) return;
    const user = i.options.getUser('player') || i.user;
    const points = sheet.getPoints();
    const t = now();
    const all = b.standings(points);
    const month = b.standings(points, b.monthRange(t));
    const stats = all.find(r => r.playerId === user.id) || { claims: 0, firsts: 0 };
    const recent = b.uniquePoints(points).filter(p => String(p.playerId) === user.id).slice(-5).reverse()
      .map(p => `${{ [b.TYPE_SHOP]: '🛒 ', [b.TYPE_WHEEL]: '🎡 ', [b.TYPE_DONATION]: '💝 ', [b.TYPE_GIFT]: '🎁 ', [b.TYPE_SPONSOR]: '💰 ', [b.TYPE_DUEL]: '⚔️ ' }[String(p.type).toLowerCase()] || ''}${p.detail || p.type} · ${Number(p.change) > 0 ? '+' : ''}${p.change}`);
    const name = b.playerNames(points).get(user.id) || await displayName(i.guild, user);
    return i.reply(ephemeral({ embeds: [e.meEmbed({
      player: name, balance: b.balances(points, user.id, t),
      monthRank: b.rankOf(month, user.id), allRank: b.rankOf(all, user.id), stats, recent
    })] }));
  },

  async bhtop(i) {
    if (!(await needSheet(i))) return;
    const period = i.options.getString('period') || 'month';
    const t = now();
    const points = sheet.getPoints();
    let rows, title, footer;
    if (period === 'all') {
      rows = b.standings(points);
      title = 'Bounty Hunters · All time';
      footer = `${rows.length} hunters in total`;
    } else {
      const range = b.monthRange(t);
      rows = b.standings(points, range);
      const monthName = new Date(t).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      title = `Bounty Hunters · ${monthName}`;
      footer = `Resets ${e.weekLabel(b.isoDate(range.to))} 00:00 UTC · ${rows.length} hunters scored`;
    }
    const me = b.rankOf(rows, i.user.id);
    return i.reply(ephemeral({ embeds: [e.leaderboardEmbed(rows, { title, footer: `${footer}${me ? ` · You: #${me}` : ''}` })] }));
  },

  async bhshop(i) {
    if (!(await needSheet(i))) return;
    const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
    const goal = x.goalState(sheet.getShop(), sheet.getPoints(), S());
    return i.reply(ephemeral({ embeds: [e.shopEmbed(forSale(), wallet, goal)] }));
  },

  async bhbuy(i) {
    if (!(await needSheet(i))) return;
    const items = forSale();
    if (!items.length) return i.reply(ephemeral({ content: 'The shop is empty right now.' }));
    const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
    // Discord allows 25 items per menu and 5 menus per message.
    const pages = [];
    for (let n = 0; n < items.length && pages.length < 5; n += 25) pages.push(items.slice(n, n + 25));
    const components = pages.map((page, n) => new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`bh:menu:${n}`)
        .setPlaceholder(pages.length > 1 ? `Pick an item (list ${n + 1} of ${pages.length})` : 'Pick an item')
        .addOptions(page.map(it => ({
          label: `${it.item} — ${e.priceText(it)}`.slice(0, 100),
          value: it.item.slice(0, 100),
          description: (b.inStock(it) ? it.description || ' ' : 'Sold out').slice(0, 100)
        })))));
    return i.reply(ephemeral({ content: `Your wallet: **${wallet} pts**. What would you like?`, components }));
  },

  async bhpast(i) {
    if (!(await needSheet(i))) return;
    const shut = S().closedWeeks || []; // Closed_Bounties = hidden (e.g. a test bounty)
    const posted = b.postedBounties(sheet.getBounties()).filter(x => !shut.includes(x.weekOf)).reverse().slice(0, 12);
    const rows = posted.map(x => {
      const claims = b.activeClaims(sheet.getPoints(), x.weekOf);
      const first = claims.find(c => String(c.type).toLowerCase() === b.TYPE_FIRST);
      return `**${e.weekLabel(e.shownWeek(x))}** · ${x.boss} — ${first ? `🥇 ${first.player} · ${claims.length} claims` : 'no claims'}`;
    });
    return i.reply(ephemeral({ embeds: [e.pastEmbed(rows)] }));
  },

  async bhvoid(i) {
    if (!(await needAdmin(i)) || !(await needSheet(i))) return;
    const id = b.messageIdFrom(i.options.getString('message'));
    if (!id) return i.reply(ephemeral({ content: 'Give me the message link (right-click the message → Copy Message Link) or its ID.' }));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = i.options.getString('reason');
    const result = await queue(() => voidSubmission(id, i, reason));
    if (result.startsWith('🗑️')) await logAdmin(i, 'bhvoid', result, reason);
    return i.editReply({ content: result });
  },

  async bhgive(i) {
    if (!(await needAdmin(i)) || !(await needSheet(i))) return;
    const user = i.options.getUser('player');
    const amount = i.options.getInteger('amount');
    const reason = i.options.getString('reason');
    if (!amount) return i.reply(ephemeral({ content: 'The amount can\'t be 0.' }));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const player = await displayName(i.guild, user);
    const by = await displayName(i.guild, i.user);
    await queue(() => sheet.addPoints({ time: now(), player, playerId: user.id, change: amount, type: b.TYPE_ADMIN, detail: reason, by, ref: `admin:${now()}` }));
    playersDirty = true;
    const bal = b.balances(sheet.getPoints(), user.id, now());
    await logAdmin(i, 'bhgive', `${amount > 0 ? '➕' : '➖'} **${amount > 0 ? '+' : ''}${amount} pts** for **${player}** (<@${user.id}>) · wallet now ${bal.wallet} pts`, reason);
    return i.editReply({ content: `${amount > 0 ? '➕' : '➖'} ${amount > 0 ? '+' : ''}${amount} pts for **${player}** (${reason}). Wallet ${bal.wallet} · earned ${bal.earned}.` });
  },

  async bhpost(i) {
    if (!(await needAdmin(i)) || !(await needSheet(i))) return;
    if (!sheet.hasHistory()) return i.reply(ephemeral({ content: '❌ The sheet has no History tab yet: paste the new Apps Script, run setupBountyHunter and redeploy it first.' }));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    // This Monday's bounty not up yet → post it now (pick / forced / random).
    // Already up → an extra random bounty now; next Monday still comes as normal.
    const res = await queue(() => {
      const thisMonday = b.mondayOf(now());
      return postWeek(thisMonday, { extra: b.weekCovered(sheet.getBounties(), thisMonday) });
    });
    if (!res.ok) return i.editReply({ content: `❌ Not posted: ${res.error}` });
    const next = e.weekLabel(b.nextOpenWeek(sheet.getBounties(), now()));
    const what = `the **${res.bounty.boss}** bounty${res.bounty.chosenBy ? ` (picked by ${res.bounty.chosenBy})` : ''}`;
    await logAdmin(i, 'bhpost', `Posted ${what} early: ${res.url}\nNext bounty: Monday ${next} as normal.`);
    return i.editReply({ content: `✅ Posted ${what}: ${res.url}\nThe next bounty still goes up on **Monday ${next}**.` });
  },

  async bhreload(i) {
    if (!(await needAdmin(i))) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const ok = await sheet.loadAll();
    lastRendered.clear();
    if (ok) { lastGuide = ''; roleReactionDone = ''; await ensureGuide(); await ensureRoleReaction(); await refreshBoards(); }
    const warns = sheet.warnings();
    return i.editReply({ content: ok
      ? `✅ Sheet re-read. ${b.usablePool(sheet.getPool()).length} bounties to pick from, ${sheet.getShop().length} shop items.${warns.length ? `\n⚠️ ${warns.slice(0, 5).join('\n⚠️ ')}` : ''}`
      : '❌ Could not read the sheet. Check the SHEET_URL deployment.' });
  }
};

async function voidSubmission(messageId, i, reason = '') {
  const active = b.activeSubmissions(sheet.getSubmissions());
  const row = active.find(s => String(s.messageId) === messageId);
  if (!row) return 'That message is not an approved bounty submission (or it was already voided).';
  const by = await displayName(i.guild, i.user);
  const bounty = sheet.getBounties().find(x => x.weekOf === row.weekOf);
  const claim = b.activeClaims(sheet.getPoints(), row.weekOf).find(c => String(c.playerId) === String(row.playerId));

  await sheet.addSubmission({ ...row, approvedAt: now(), approver: by, approverId: i.user.id, status: 'void' });
  let extra = '';
  if (claim) {
    await sheet.addPoints({ time: now(), player: row.player, playerId: row.playerId, change: -Number(claim.change), type: b.TYPE_VOID,
      detail: `Voided claim: ${bounty?.boss || row.weekOf}${reason ? ` (${reason})` : ''}`, by, weekOf: row.weekOf, ref: claim.ref });
    playersDirty = true;
    extra = ` Their claim (${claim.change} pts) was taken back.`;
    if (String(claim.type).toLowerCase() === b.TYPE_FIRST) extra += ' It was the FIRST claim: the bonus does not move to anyone else automatically (use /bhgive if needed).';
  }

  await settleExtras(); // a voided claim can move a sponsor pot or duel win

  const link = /channels\/\d+\/(\d+)\/\d+/.exec(row.messageLink || '');
  if (link) {
    const ch = await fetchChannel(link[1]);
    const msg = await ch?.messages.fetch(messageId).catch(() => null);
    if (msg) await removeOwnReaction(msg, TARGET);
  }
  await refreshBoards();
  return `🗑️ Voided **${row.item}** for **${row.player}** (${bounty?.boss || row.weekOf}, part ${row.part}).${extra}`;
}

// ---------------------------------------------------------------------------
// Shop buttons / menus
// ---------------------------------------------------------------------------

const pendingBuys = new Map(); // userId -> item name
const pendingPicks = new Map(); // userId -> { item, week, choices, choice, at }
const pendingTransfers = new Map(); // userId -> { kind, item, toId, toName, amount, text, at }
const PICK_TTL = 5 * 60 * 1000;
const done = content => ({ content, embeds: [], components: [] });

/** The shop, with "Pick next week's bounty" sold out (1 per week) once that week is picked. */
function shopItems() {
  const taken = Boolean(b.waitingPick(sheet.getBounties()));
  const wordGone = x.wordTaken(S(), b.nextOpenWeek(sheet.getBounties(), now()));
  return sheet.getShop().map(it => (it.isPick ? { ...it, stock: taken ? 0 : 1 }
    : it.isCodeWord ? { ...it, stock: wordGone ? 0 : 1 } : it));
}

/** What players can see and buy (the clan goal row is settings, not an item). */
const forSale = () => shopItems().filter(it => it.active && !it.isGoal);

/** Step 1 of a pick: up to Pick_Options random bounties (not used in the last Repeat_Cooldown_Weeks weeks). */
async function showPickMenu(i, item) {
  const s = S();
  if (!sheet.hasHistory()) return i.update(done('This item is not ready yet (the sheet needs its update). Ask an admin.'));
  const history = sheet.getBounties();
  const week = b.nextOpenWeek(history, now());
  const choices = b.pickChoices(sheet.getPool(), history, week, s, fairRandom);
  if (!choices.length) return i.update(done('There are no bounties to pick from right now. Ask an admin. Nothing was spent.'));
  pendingPicks.set(i.user.id, { item: item.item, week, choices, at: now() });
  const menu = new StringSelectMenuBuilder().setCustomId('bh:pick').setPlaceholder('Choose the bounty')
    .addOptions(choices.map((c, n) => ({
      label: `${c.boss} — 1st ${c.firstPoints ?? s.defaultFirst} / later ${c.laterPoints ?? s.defaultLater} pts`.slice(0, 100),
      value: String(n),
      description: (c.parts.map(p => b.describePart(p)).join(' · ') || ' ').slice(0, 100)
    })));
  return i.update({
    content: `🎯 **${item.item}** (${item.cost} pts) · week of **${e.weekLabel(week)}**\n` +
      `Choose from these ${choices.length} random bounties. Only you can see this list, and your choice stays secret until it goes up.\n` +
      'You only pay after you confirm.',
    embeds: [], components: [new ActionRowBuilder().addComponents(menu)]
  });
}

/** Public note (buyer pinged, boss NOT shown) + info for the admins. */
async function announcePick({ player, playerId, item, week, bounty, cost }) {
  const s = S();
  const channel = await fetchChannel(s.awardsChannelId || s.boardChannelId);
  await channel?.send({
    content: `🎯 <@${playerId}> bought **${item}**! Their choice stays secret until it goes up on Monday ${e.weekLabel(week)}.`,
    allowedMentions: { users: [playerId] }
  }).catch(err => console.error(`⚠️ Could not announce the pick: ${err.message}`));
  const admin = await fetchChannel(s.shopAdminChannelId);
  await admin?.send({ embeds: [e.pickAdminEmbed({ player, playerId, bounty, weekOf: week, cost, settings: s })], allowedMentions: NO_PINGS })
    .catch(err => console.error(`⚠️ Could not post the pick in the shop admin channel: ${err.message}`));
  console.log(`🎯 ${player} picked ${bounty.boss} for the week of ${week}.`);
}

const giftLeftFor = userId => Math.max(0, S().giftWeeklyLimit - b.giftedThisWeek(sheet.getPoints(), userId, now()));

/** The waiting donation/gift of this user, or null if it expired or left the shop. */
function liveTransfer(userId) {
  const p = pendingTransfers.get(userId);
  if (!p) return null;
  const item = shopItems().find(x => x.item === p.item && x.active);
  if (now() - p.at > PICK_TTL || !item) { pendingTransfers.delete(userId); return null; }
  return { p, item };
}

const EXPIRED_TRANSFER = 'That expired. Run /bhbuy again. Nothing was spent.';

/** The form was sent: check it, then ask for confirmation. Nothing is paid yet. */
async function handleModal(i) {
  if (EXTRA_MODALS.has(i.customId)) return handleExtraModal(i);
  if (i.customId !== 'bh:donatemodal' && i.customId !== 'bh:giftmodal') return;
  const live = liveTransfer(i.user.id);
  if (!live) return i.update(done(EXPIRED_TRANSFER));
  const { p, item } = live;
  const isGift = p.kind === 'gift';
  const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
  const giftLeft = isGift ? giftLeftFor(i.user.id) : null;
  const amount = b.parseAmount(i.fields.getTextInputValue('amount'));
  const problem = b.transferProblem({ amount, min: b.minTransfer(item), wallet, giftLeft });
  if (problem) { pendingTransfers.delete(i.user.id); return i.update(done(`❌ ${problem} Run /bhbuy to try again. Nothing was spent.`)); }

  const text = isGift
    ? b.cleanText(i.fields.getTextInputValue('note'), NOTE_MAX)
    : b.cleanText(i.fields.getTextInputValue('message'), MESSAGE_MAX, { lines: true });
  if (!isGift && !text) { pendingTransfers.delete(i.user.id); return i.update(done('❌ Please write a message for the admin team. Nothing was spent.')); }
  Object.assign(p, { amount, text, at: now() });
  const shown = escapeMarkdown(text);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bh:xferok').setStyle(ButtonStyle.Success).setLabel(`${isGift ? 'Gift' : 'Donate'} ${amount} pts`),
    new ButtonBuilder().setCustomId('bh:buyno').setStyle(ButtonStyle.Secondary).setLabel('Cancel'));
  const embed = isGift
    ? e.confirmGiftEmbed({ toId: p.toId, amount, wallet, note: shown, giftLeft })
    : e.confirmDonateEmbed({ amount, wallet, message: shown });
  return i.update({ content: '', embeds: [embed], components: [row] });
}

/** Confirmed: the sheet moves the points, then the admins (and for gifts, everyone) are told. */
async function finishTransfer(i) {
  const live = liveTransfer(i.user.id);
  pendingTransfers.delete(i.user.id);
  if (!live) return i.update(done(EXPIRED_TRANSFER));
  const { p } = live;
  if (p.kind !== 'gift' && p.kind !== 'donate') return finishExtra(i, live);
  const isGift = p.kind === 'gift';
  const shown = escapeMarkdown(p.text);
  await i.update(done('⏳ Sending…'));
  const player = await displayName(i.guild, i.user);
  const s = S();
  if (!isGift) await queue(checkGoal); // a goal switched on just now starts counting before this donation
  const res = await queue(() => sheet.transfer({
    kind: p.kind, item: p.item, player, playerId: i.user.id, amount: p.amount,
    ...(isGift
      ? { toPlayer: p.toName, toPlayerId: p.toId, weekStart: b.dayMs(b.mondayOf(now())), weeklyLimit: s.giftWeeklyLimit }
      : { message: p.text })
  }));
  if (!res.ok) {
    const why = /unknown action/.test(res.error) ? 'the sheet needs its Apps Script update, so tell an admin' : res.error;
    return i.editReply(done(`❌ Not sent: ${why}. Check your wallet with /bhme before trying again.`));
  }
  playersDirty = true;

  if (isGift) {
    // The DM tells them; the public post only pings if their DMs are closed.
    const toWallet = b.balances(sheet.getPoints(), p.toId, now()).wallet;
    const dmSent = await client.users.send(p.toId, {
      content: e.giftDm({ from: escapeMarkdown(player), amount: p.amount, note: shown, wallet: toWallet }), allowedMentions: NO_PINGS
    }).then(() => true).catch(() => false);
    const publicChannel = await fetchChannel(s.submissionsChannelId || s.awardsChannelId || s.boardChannelId);
    await publicChannel?.send({
      content: e.giftAnnouncement({ fromId: i.user.id, toId: p.toId, amount: p.amount, note: shown }),
      allowedMentions: dmSent ? NO_PINGS : { users: [p.toId] }
    }).catch(err => console.error(`⚠️ Could not announce gift ${res.id}: ${err.message}`));
    const log = await fetchChannel(s.adminLogChannelId);
    await log?.send({
      embeds: [e.giftLogEmbed({ player, playerId: i.user.id, toPlayer: p.toName, toId: p.toId, amount: p.amount, note: shown, id: res.id })],
      allowedMentions: NO_PINGS
    }).catch(err => console.error(`⚠️ Could not log gift ${res.id}: ${err.message}`));
    return i.editReply(done(`🎁 You gifted **${p.amount} pts** to <@${p.toId}>. Wallet now: **${res.wallet} pts**. Gift limit left this week: **${res.giftLeft} pts**.`));
  }

  const admin = await fetchChannel(s.shopAdminChannelId);
  await admin?.send({
    embeds: [e.donationAdminEmbed({ player, playerId: i.user.id, amount: p.amount, message: shown, id: res.id })],
    allowedMentions: NO_PINGS
  }).catch(err => console.error(`⚠️ Donation ${res.id} saved, but the admin post failed: ${err.message}`));
  const goal = x.goalState(sheet.getShop(), sheet.getPoints(), S());
  if (goal) {
    await publicPost(e.goalProgressLine(escapeMarkdown(player), p.amount, goal));
    await queue(checkGoal);
  }
  return i.editReply(done(`💝 Thank you! You donated **${p.amount} pts** and your message went to the admin team. Wallet now: **${res.wallet} pts**.`));
}

// ---------------------------------------------------------------------------
// Shop extras: sponsor pots, duels, clan goal, code word, emoji
// ---------------------------------------------------------------------------

const EXTRA_MODALS = new Set(['bh:sponsormodal', 'bh:duelmodal', 'bh:wordmodal', 'bh:emojimodal']);

/** A message everyone can see in the submissions thread. Pings nobody unless `ping` is given. */
async function publicPost(content, { ping = [], components } = {}) {
  const s = S();
  const channel = await fetchChannel(s.submissionsChannelId || s.awardsChannelId || s.boardChannelId);
  return channel?.send({ content, components, allowedMentions: { users: ping } })
    .catch(err => { console.error(`⚠️ Could not post in the submissions channel: ${err.message}`); return null; });
}

/** Pays, refunds or takes back whatever sponsor pots and duels now require. Run it inside queue(). */
async function settleExtras() {
  if (!sheet.isAvailable()) return;
  const rows = x.settlements(sheet.getPoints(), sheet.getBounties(), S(), now());
  for (const row of rows) {
    await sheet.addPoints({ ...row, time: now() });
    playersDirty = true;
    if (row.change > 0) await publicPost(`💰 <@${row.playerId}> ${escapeMarkdown(row.detail)}: **+${row.change} pts**`, { ping: [row.playerId] });
    else {
      const log = await fetchChannel(S().adminLogChannelId);
      await log?.send({ content: `↩️ **${escapeMarkdown(row.player)}** (<@${row.playerId}>) ${escapeMarkdown(row.detail)}: **${row.change} pts**`, allowedMentions: NO_PINGS }).catch(() => {});
    }
  }
  if (rows.length) await refreshBoards();
}

/** Starts the clan goal's count when it is switched on, and celebrates when it is reached. Run it inside queue(). */
async function checkGoal() {
  if (!sheet.isAvailable()) return;
  const s = S();
  const points = sheet.getPoints();
  const goal = x.goalState(sheet.getShop(), points, s);
  if (!goal) return;
  if (s.goalBase === null) { await sheet.setSetting('Clan_Goal_Base', x.totalDonated(points)); return; }
  if (goal.progress < goal.target) return;
  const times = Math.floor(goal.progress / goal.target);
  await sheet.setSetting('Clan_Goal_Base', s.goalBase + times * goal.target);
  const embed = e.goalReachedEmbed(goal, times);
  const awards = await fetchChannel(s.awardsChannelId || s.boardChannelId);
  await awards?.send({ embeds: [embed], allowedMentions: NO_PINGS }).catch(err => console.error(`⚠️ Could not announce the clan goal: ${err.message}`));
  const admin = await fetchChannel(s.shopAdminChannelId);
  await admin?.send({ content: `🎯 Clan goal **${escapeMarkdown(goal.name)}** was reached. Time to organise it!`, allowedMentions: NO_PINGS }).catch(() => {});
}

/** Why these two can't duel on this bounty, or null. */
function duelProblem(aId, bId, bounty) {
  const points = sheet.getPoints();
  const all = sheet.getBounties();
  if (!bounty || now() >= b.closesAt(all, bounty, S())) return 'There is no open bounty to duel on right now.';
  const claimed = b.activeClaims(points, bounty.weekOf).map(c => String(c.playerId));
  if (claimed.includes(aId) || claimed.includes(bId)) return 'One of you has already claimed this bounty.';
  if (x.openDuelOf(aId, points, all, S(), now()) || x.openDuelOf(bId, points, all, S(), now())) return 'One of you is already in a duel.';
  return null;
}

/** A form was sent: check it and ask for confirmation. Nothing is paid yet. */
async function handleExtraModal(i) {
  const live = liveTransfer(i.user.id);
  if (!live) return i.update(done(EXPIRED_TRANSFER));
  const { p, item } = live;
  const s = S();
  const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
  const fail = text => { pendingTransfers.delete(i.user.id); return i.update(done(`❌ ${text} Run /bhbuy to try again. Nothing was spent.`)); };
  let title, text, label;

  if (p.kind === 'sponsor' || p.kind === 'duel') {
    const amount = b.parseAmount(i.fields.getTextInputValue('amount'));
    const max = p.kind === 'sponsor' ? s.sponsorMax : s.duelMaxStake;
    const problem = b.transferProblem({ amount, min: b.minTransfer(item), wallet }) || (amount > max ? `The maximum is **${max} pts**.` : null);
    if (problem) return fail(problem);
    p.amount = amount;
    if (p.kind === 'sponsor') {
      title = `Sponsor ${p.boss}`;
      text = `Add **${amount} pts** to the pot. The first player to claim this bounty wins the whole pot. If nobody claims it, you get your points back.\n\nWallet after: **${wallet - amount} pts**`;
      label = `Sponsor ${amount} pts`;
    } else {
      title = `Duel ${p.toName}`;
      text = `Stake **${amount} pts** against <@${p.toId}> on the **${p.boss}** bounty. The first of you to claim it takes **${amount * 2} pts**.\n` +
        `They have ${x.DUEL_ACCEPT_HOURS} hours to accept. If they don't, or nobody claims, your stake comes back.\n\nWallet after: **${wallet - amount} pts**`;
      label = `Challenge for ${amount} pts`;
    }
  } else if (p.kind === 'word') {
    const word = i.fields.getTextInputValue('word');
    if (!x.validWord(word)) return fail('Use 3 to 12 letters only, with no spaces or numbers.');
    p.word = x.tidyWord(word);
    title = "Next week's code word";
    text = `Your word: **${p.word}**. The bot adds 2 secret digits when the bounty goes up (like **${p.word}42**), so everyone starts equal.\nThe admins can see it and may replace it if it isn't suitable.\n\nCost **${item.cost} pts** · wallet after: **${wallet - item.cost} pts**`;
    label = `Buy for ${item.cost} pts`;
  } else {
    const emoji = x.parseEmoji(i.fields.getTextInputValue('emoji'), id => i.guild?.emojis.cache.has(id));
    if (!emoji) return fail('Please send exactly one emoji (a standard one or one from this server).');
    p.emoji = emoji;
    title = "Winner's emoji";
    text = `${emoji} will be added to your approved submissions for **${x.EMOJI_DAYS} days**. Buying again replaces it.\n\nCost **${item.cost} pts** · wallet after: **${wallet - item.cost} pts**`;
    label = `Buy for ${item.cost} pts`;
  }
  p.at = now();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bh:xferok').setStyle(ButtonStyle.Success).setLabel(label),
    new ButtonBuilder().setCustomId('bh:buyno').setStyle(ButtonStyle.Secondary).setLabel('Cancel'));
  return i.update({ content: '', embeds: [e.confirmEmbed(title, text)], components: [row] });
}

/** Confirmed: re-check, pay through the sheet, then do what was bought. Runs inside queue(). */
async function runExtra(i, p, player) {
  const s = S();
  const base = { item: p.item, player, playerId: i.user.id };
  if (p.kind === 'sponsor') {
    const bounty = sheet.getBounties().find(y => y.weekOf === p.weekOf);
    const problem = x.sponsorProblem(bounty, sheet.getPoints(), sheet.getBounties(), s, now());
    if (problem) return { ok: false, error: problem };
    const res = await sheet.spend({ ...base, how: 'sponsor', amount: p.amount, max: s.sponsorMax, detail: `Sponsored ${bounty.boss}`, ref: x.sponsorRef(p.weekOf) });
    if (!res.ok) return res;
    const pot = x.potOf(sheet.getPoints(), p.weekOf);
    await publicPost(`💰 <@${i.user.id}> added **${p.amount} pts** to the **${escapeMarkdown(bounty.boss)}** bounty. The pot is now **${pot} pts** for the first claim!`);
    await refreshBoards();
    return { ok: true, text: `💰 You sponsored **${bounty.boss}** with **${p.amount} pts**. Wallet now: **${res.wallet} pts**.` };
  }
  if (p.kind === 'duel') {
    const bounty = sheet.getBounties().find(y => y.weekOf === p.weekOf);
    const problem = duelProblem(i.user.id, p.toId, bounty);
    if (problem) return { ok: false, error: problem };
    const created = now();
    const ref = x.duelRef({ weekOf: p.weekOf, a: i.user.id, b: p.toId, stake: p.amount, created });
    const res = await sheet.spend({ ...base, how: 'duel', amount: p.amount, max: s.duelMaxStake, detail: `Duel stake against ${p.toName}`, ref });
    if (!res.ok) return res;
    const id = `${created}:${i.user.id}`;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bh:duelyes:${id}`).setStyle(ButtonStyle.Success).setLabel(`Accept (${p.amount} pts)`),
      new ButtonBuilder().setCustomId(`bh:duelno:${id}`).setStyle(ButtonStyle.Secondary).setLabel('Decline'));
    const posted = await publicPost(e.duelChallenge({ a: i.user.id, b: p.toId, stake: p.amount, boss: escapeMarkdown(bounty.boss), hours: x.DUEL_ACCEPT_HOURS }), { ping: [p.toId], components: [row] });
    if (!posted) {
      await sheet.addPoints({ time: now(), player, playerId: i.user.id, change: 0, type: b.TYPE_DUEL, detail: 'Duel cancelled (could not post it)', ref: `duelend:${x.duelTail(ref)}` });
      await settleExtras();
      return { ok: false, error: 'the challenge could not be posted, so your stake was returned' };
    }
    return { ok: true, text: `⚔️ Challenge sent to <@${p.toId}>. Wallet now: **${res.wallet} pts**.` };
  }
  if (p.kind === 'word') {
    const week = b.nextOpenWeek(sheet.getBounties(), now());
    if (x.wordTaken(s, week)) return { ok: false, error: "someone already chose next week's code word" };
    const res = await sheet.spend({ ...base, how: 'codeword', detail: p.item, ref: `codeword:${week}`, note: p.word });
    if (!res.ok) return res;
    await sheet.setSetting('Next_Code_Word_Week', week);
    await sheet.setSetting('Next_Code_Word', p.word);
    const admin = await fetchChannel(s.shopAdminChannelId);
    await admin?.send({ content: `🔑 **${escapeMarkdown(player)}** (<@${i.user.id}>) chose the code word **${p.word}** for the week of ${e.weekLabel(week)}. The bot adds 2 digits when it is posted.\nNot suitable? Change or clear \`Next_Code_Word\` in Settings, then /bhreload. Use /bhgive for a refund.`, allowedMentions: NO_PINGS })
      .catch(err => console.error(`⚠️ Could not post the code word for admins: ${err.message}`));
    return { ok: true, text: `🔑 **${p.word}** is booked for the week of **${e.weekLabel(week)}**. Keep it secret! Wallet now: **${res.wallet} pts**.` };
  }
  const res = await sheet.spend({ ...base, how: 'emoji', detail: `Emoji: ${p.emoji}`, ref: x.emojiRef(i.user.id), note: p.emoji });
  if (!res.ok) return res;
  return { ok: true, text: `${p.emoji} is yours for **${x.EMOJI_DAYS} days**. Wallet now: **${res.wallet} pts**.` };
}

async function finishExtra(i, { p }) {
  await i.update(done('⏳ Working…'));
  const player = await displayName(i.guild, i.user);
  const res = await queue(() => runExtra(i, p, player));
  if (!res.ok) {
    const why = /unknown action/.test(res.error) ? 'the sheet needs its Apps Script update, so tell an admin' : res.error;
    return i.editReply(done(`❌ Not done: ${why}. Check your wallet with /bhme before trying again.`));
  }
  playersDirty = true;
  return i.editReply(done(res.text));
}

/** Accept / Decline buttons on a public duel challenge. */
async function handleDuelButton(i) {
  const [, action, created, a] = i.customId.split(':');
  const duel = x.listDuels(sheet.getPoints()).find(d => String(d.created) === created && d.a === a);
  if (!duel) return i.reply(ephemeral({ content: 'That duel no longer exists.' }));
  if (i.user.id !== duel.b) return i.reply(ephemeral({ content: 'Only the challenged player can answer this.' }));
  await i.deferUpdate();
  const player = await displayName(i.guild, i.user);
  const tell = content => i.followUp(ephemeral({ content }));
  const result = await queue(async () => {
    const fresh = x.listDuels(sheet.getPoints()).find(d => d.ref === duel.ref);
    const { state, bounty } = x.duelOutcome(fresh, sheet.getPoints(), sheet.getBounties(), S(), now());
    if (state !== 'waiting') return { ok: false, closed: true, error: 'This duel is already over or was already answered.' };
    if (action === 'duelno') {
      await sheet.addPoints({ time: now(), player, playerId: i.user.id, change: 0, type: b.TYPE_DUEL, detail: 'Duel declined', ref: `duelend:${x.duelTail(duel.ref)}` });
      await settleExtras();
      return { ok: true, text: `🏳️ <@${duel.b}> declined the duel. <@${duel.a}>'s stake was returned.` };
    }
    const claimed = b.activeClaims(sheet.getPoints(), duel.weekOf).map(c => String(c.playerId));
    if (claimed.includes(duel.a) || claimed.includes(duel.b)) return { ok: false, error: 'One of you has already claimed this bounty.' };
    const item = sheet.getShop().find(it => it.isDuel && it.active);
    if (!item) return { ok: false, error: 'Duels are switched off right now.' };
    const res = await sheet.spend({ how: 'duel', item: item.item, player, playerId: i.user.id, amount: duel.stake, detail: 'Duel stake accepted', ref: duel.ref, onceOnly: true });
    if (!res.ok) return { ok: false, error: `Not accepted: ${res.error}.` };
    return { ok: true, text: `⚔️ <@${duel.b}> accepted! First of <@${duel.a}> and <@${duel.b}> to claim **${escapeMarkdown(bounty.boss)}** takes **${duel.stake * 2} pts**.` };
  });
  if (result.ok) playersDirty = true;
  if (result.ok || result.closed) await i.editReply({ content: result.ok ? result.text : `${i.message.content}\n\n*This duel is closed.*`, components: [], allowedMentions: NO_PINGS });
  if (!result.ok) await tell(`❌ ${result.error}`);
}

/** The player chose an extra in /bhbuy. Returns false when it isn't one. */
function startExtra(i, item, wallet) {
  const s = S();
  const min = b.minTransfer(item);
  const stop = text => i.update(done(`${text} Nothing was spent.`));
  const remember = extra => pendingTransfers.set(i.user.id, { item: item.item, at: now(), ...extra });
  if (item.isSponsor) {
    const bounty = b.currentBounty(sheet.getBounties());
    const problem = x.sponsorProblem(bounty, sheet.getPoints(), sheet.getBounties(), s, now());
    if (problem) return stop(problem);
    remember({ kind: 'sponsor', weekOf: bounty.weekOf, boss: bounty.boss });
    return i.showModal(sponsorModal({ boss: bounty.boss, min, max: Math.min(wallet, s.sponsorMax) }));
  }
  if (item.isDuel) {
    const bounty = b.currentBounty(sheet.getBounties());
    const problem = duelProblem(i.user.id, i.user.id, bounty);
    if (problem) return stop(problem);
    remember({ kind: 'duel', weekOf: bounty.weekOf, boss: bounty.boss });
    const picker = new UserSelectMenuBuilder().setCustomId('bh:duelto').setPlaceholder('Choose your opponent').setMinValues(1).setMaxValues(1);
    return i.update({ content: `⚔️ Who do you challenge on the **${bounty.boss}** bounty? You only pay after you confirm.`, embeds: [], components: [new ActionRowBuilder().addComponents(picker)] });
  }
  if (item.isCodeWord) { remember({ kind: 'word' }); return i.showModal(wordModal()); }
  if (item.isEmoji) { remember({ kind: 'emoji' }); return i.showModal(emojiModal()); }
  return false;
}

async function handleComponent(i) {
  if (i.customId.startsWith('bh:duelyes:') || i.customId.startsWith('bh:duelno:')) return handleDuelButton(i);

  if (i.customId === 'bh:buy' || i.customId.startsWith('bh:menu:')) {
    const name = i.values[0];
    const item = shopItems().find(x => x.item.slice(0, 100) === name && x.active);
    const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
    if (!item) return i.update({ content: 'That item is no longer for sale.', components: [], embeds: [] });
    if (!b.inStock(item)) {
      return i.update(done(item.isPick
        ? `**${item.item}** is sold out: someone already picked the next bounty. It's back after that one goes up.`
        : `**${item.item}** is sold out.`));
    }
    const isTransfer = item.isDonate || item.isGift || item.isSponsor || item.isDuel;
    if (wallet < (isTransfer ? b.minTransfer(item) : item.cost)) {
      return i.update(done(`You have **${wallet} pts**; **${item.item}** ${isTransfer ? `starts at **${b.minTransfer(item)} pts**` : `costs **${item.cost} pts**`}.`));
    }
    if (item.isSponsor || item.isDuel || item.isCodeWord || item.isEmoji) return startExtra(i, item, wallet);
    if (item.isDonate) {
      pendingTransfers.set(i.user.id, { kind: 'donate', item: item.item, at: now() });
      return i.showModal(donateModal({ min: b.minTransfer(item), wallet }));
    }
    if (item.isGift) {
      const left = giftLeftFor(i.user.id);
      if (left < b.minTransfer(item)) return i.update(done(`You have used your gift limit for this week (**${S().giftWeeklyLimit} pts**). It resets on Monday at 00:00 UTC.`));
      pendingTransfers.set(i.user.id, { kind: 'gift', item: item.item, at: now() });
      const picker = new UserSelectMenuBuilder().setCustomId('bh:giftto').setPlaceholder('Choose a clannie').setMinValues(1).setMaxValues(1);
      return i.update({ content: `🎁 Who gets the gift? You can gift up to **${Math.min(wallet, left)} pts** right now. You only pay after you confirm.`, embeds: [], components: [new ActionRowBuilder().addComponents(picker)] });
    }
    if (item.isPick) return showPickMenu(i, item);
    const prizes = sheet.getWheel();
    if (item.isWheel && !prizes.length) return i.update({ content: 'The prize wheel has no prizes set up yet. Ask an admin.', components: [], embeds: [] });
    pendingBuys.set(i.user.id, item.item);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bh:buyok').setStyle(ButtonStyle.Success).setLabel(`Buy for ${item.cost} pts`),
      new ButtonBuilder().setCustomId('bh:buyno').setStyle(ButtonStyle.Secondary).setLabel('Cancel'));
    return i.update({ content: '', embeds: [e.confirmBuyEmbed(item, wallet, item.isWheel ? prizes : null)], components: [row] });
  }

  // A gift: the clannie is chosen, now ask how much.
  if (i.customId === 'bh:giftto') {
    const live = liveTransfer(i.user.id);
    if (!live) return i.update(done(EXPIRED_TRANSFER));
    const target = i.users.first();
    const member = i.members?.get(target.id);
    const refuse = target.id === i.user.id ? "You can't gift points to yourself."
      : target.bot ? "You can't gift points to a bot."
        : !member ? 'That person is not in this server.' : null;
    if (refuse) { pendingTransfers.delete(i.user.id); return i.update(done(`❌ ${refuse} Run /bhbuy to try again. Nothing was spent.`)); }
    const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
    const toName = member.displayName || target.globalName || target.username;
    Object.assign(live.p, { toId: target.id, toName, at: now() });
    return i.showModal(giftModal({ toName, min: b.minTransfer(live.item), max: Math.min(wallet, giftLeftFor(i.user.id)) }));
  }

  // A duel: the opponent is chosen, now ask for the stake.
  if (i.customId === 'bh:duelto') {
    const live = liveTransfer(i.user.id);
    if (!live) return i.update(done(EXPIRED_TRANSFER));
    const target = i.users.first();
    const member = i.members?.get(target.id);
    const bounty = sheet.getBounties().find(y => y.weekOf === live.p.weekOf);
    const refuse = target.id === i.user.id ? "You can't duel yourself."
      : target.bot ? "You can't duel a bot."
        : !member ? 'That person is not in this server.' : duelProblem(i.user.id, target.id, bounty);
    if (refuse) { pendingTransfers.delete(i.user.id); return i.update(done(`❌ ${refuse} Run /bhbuy to try again. Nothing was spent.`)); }
    const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
    const toName = member.displayName || target.globalName || target.username;
    Object.assign(live.p, { toId: target.id, toName, at: now() });
    return i.showModal(duelModal({ toName, min: b.minTransfer(live.item), max: Math.min(wallet, S().duelMaxStake) }));
  }

  if (i.customId === 'bh:xferok') return finishTransfer(i);

  if (i.customId === 'bh:buyno') {
    pendingTransfers.delete(i.user.id);
    pendingBuys.delete(i.user.id);
    pendingPicks.delete(i.user.id);
    return i.update({ content: 'Cancelled. Nothing was spent.', embeds: [], components: [] });
  }

  // Step 2 of a pick: confirm the chosen bounty.
  if (i.customId === 'bh:pick') {
    const p = pendingPicks.get(i.user.id);
    if (!p || now() - p.at > PICK_TTL) { pendingPicks.delete(i.user.id); return i.update(done('That list expired. Run /bhbuy again. Nothing was spent.')); }
    const item = shopItems().find(x => x.item === p.item && x.active);
    if (!item) return i.update(done('That item is no longer for sale.'));
    p.choice = p.choices[Number(i.values[0])];
    if (!p.choice) return i.update(done('Something went wrong with that choice. Run /bhbuy again. Nothing was spent.'));
    const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bh:pickok').setStyle(ButtonStyle.Success).setLabel(`Buy for ${item.cost} pts`),
      new ButtonBuilder().setCustomId('bh:buyno').setStyle(ButtonStyle.Secondary).setLabel('Cancel'));
    return i.update({ content: '', embeds: [e.confirmPickEmbed(p.choice, p.week, item, wallet, S())], components: [row] });
  }

  // Step 3 of a pick: pay + save it in History (the sheet refuses a 2nd pick for the same week).
  if (i.customId === 'bh:pickok') {
    const p = pendingPicks.get(i.user.id);
    pendingPicks.delete(i.user.id);
    if (!p?.choice || now() - p.at > PICK_TTL) return i.update(done('That choice expired. Run /bhbuy again. Nothing was spent.'));
    await i.update(done('⏳ Buying…'));
    const player = await displayName(i.guild, i.user);
    const res = await queue(async () => {
      const history = sheet.getBounties();
      const week = b.nextOpenWeek(history, now());
      if (week !== p.week) return { ok: false, error: 'the bounty for that week has just gone up. Run /bhbuy again' };
      if (b.waitingPick(history)) return { ok: false, error: 'someone else just picked the next bounty' };
      return sheet.buy({ item: p.item, player, playerId: i.user.id,
        pick: b.historyRow(p.choice, b.freeKey(history, week), { chosenBy: player, chosenById: i.user.id }) });
    });
    if (!res.ok) return i.editReply(done(`❌ Not bought: ${res.error}.${res.charged ? '' : ' Nothing was spent.'}`));
    playersDirty = true;
    await announcePick({ player, playerId: i.user.id, item: p.item, week: p.week, bounty: p.choice, cost: res.purchase.cost });
    const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
    return i.editReply(done(`✅ You picked **${p.choice.boss}** for the week of **${e.weekLabel(p.week)}**. ` +
      `It stays secret until it goes up on Monday, and you can claim it too. Wallet now: **${wallet} pts**.`));
  }

  if (i.customId === 'bh:buyok') {
    const itemName = pendingBuys.get(i.user.id);
    if (!itemName) return i.update({ content: 'That purchase expired. Run /bhbuy again.', embeds: [], components: [] });
    pendingBuys.delete(i.user.id);
    await i.update({ content: '⏳ Buying…', embeds: [], components: [] });
    const player = await displayName(i.guild, i.user);

    // A wheel spin: the prize is picked NOW and saved together with the purchase.
    const shopItem = sheet.getShop().find(x => x.item === itemName);
    const prizes = shopItem?.isWheel ? [...sheet.getWheel()] : null;
    if (shopItem?.isWheel && !prizes.length) return i.editReply({ content: '❌ The prize wheel has no prizes set up yet. Nothing was spent.' });
    const winner = prizes ? b.pickPrize(prizes, fairRandom) : -1;
    const wheelPrize = prizes ? prizes[winner] : null;

    const res = await queue(() => sheet.buy({ item: itemName, player, playerId: i.user.id, wheelPrize }));
    if (!res.ok) return i.editReply({ content: `❌ Not bought: ${res.error}. Nothing was spent.` });
    playersDirty = true;

    if (wheelPrize) {
      if (res.wheelPurchase) await pingAdmins(res.wheelPurchase);
      const url = await spinWheel({ prizes, winner, player, playerId: i.user.id, fallback: i.channel });
      const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
      return i.editReply({ content: `🎡 You bought a spin for ${res.purchase.cost} pts. ${url ? `It's spinning here: ${url}` : 'You won'} → **${wheelPrize.prize}**. Wallet now: **${wallet} pts**.` });
    }

    await pingAdmins(res.purchase);
    const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
    return i.editReply({ content: `✅ You bought **${res.purchase.item}** for ${res.purchase.cost} pts. An admin will deliver it. Wallet now: **${wallet} pts**.` });
  }
}

/** Posts a purchase (or a wheel prize to hand out) in the shop admin channel, with ✅ to mark it delivered. */
async function pingAdmins(purchase) {
  const admin = await fetchChannel(S().shopAdminChannelId);
  const ping = await admin?.send({ embeds: [e.adminPurchaseEmbed(purchase)], allowedMentions: NO_PINGS }).catch(() => null);
  if (ping) {
    await ping.react(DELIVERED).catch(() => {});
    await sheet.setPurchaseMessage(purchase.id, ping.id);
  } else {
    console.error(`⚠️ Purchase ${purchase.id} saved, but the admin ping could not be posted (check Shop_Admin_Channel_ID).`);
  }
}

// ---------------------------------------------------------------------------
// Prize wheel animation (one message, edited ~10 times, slowing down)
// ---------------------------------------------------------------------------

// Spins in the same channel run one after another, so they never share Discord's
// edit limit (about 5 edits per 5 seconds per channel).
const spinChains = new Map();

function spinWheel({ prizes, winner, player, playerId, fallback }) {
  const s = S();
  const channelId = s.wheelChannelId || s.submissionsChannelId || fallback?.id;
  const prev = spinChains.get(channelId) || Promise.resolve();
  const run = prev.then(() => animateSpin({ channelId, prizes, winner, player, playerId, fallback }));
  spinChains.set(channelId, run.catch(() => null));
  return run.catch(err => { console.error(`⚠️ Wheel animation failed: ${err.message}`); return null; });
}

async function animateSpin({ channelId, prizes, winner, player, playerId, fallback }) {
  const found = await fetchChannel(channelId);
  const channel = found?.isTextBased?.() ? found : fallback; // a forum itself can't take messages
  if (!channel?.send) throw new Error(`can't post in channel ${channelId} (set Wheel_Channel_ID)`);
  const plan = b.spinPlan(prizes.length, winner, fairRandom);
  const content = `🎡 <@${playerId}> bought a spin of the prize wheel!`;
  const msg = await channel.send({ content, embeds: [e.spinFrameEmbed(prizes, plan.start, { player })], allowedMentions: NO_PINGS });
  for (let n = 0; n < plan.frames.length; n++) {
    const { index, delay } = plan.frames[n];
    const done = n === plan.frames.length - 1;
    await sleep(delay);
    try {
      await msg.edit({ content, embeds: [e.spinFrameEmbed(prizes, index, { player, done })], allowedMentions: NO_PINGS });
    } catch (err) {
      console.error(`⚠️ Wheel frame ${n + 1} failed: ${err.message}`);
      if (done) { // the result must show: one more try
        await sleep(3000);
        await msg.edit({ content, embeds: [e.spinFrameEmbed(prizes, index, { player, done })], allowedMentions: NO_PINGS });
      }
    }
  }
  console.log(`🎡 ${player} spun the wheel: ${prizes[winner].prize}`);
  return msg.url;
}

client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isChatInputCommand()) {
      const handler = i.commandName.startsWith('bh') ? handlers[i.commandName] : null;
      if (handler) await handler(i);
      return; // not ours — the event bot answers it
    }
    if ((i.isStringSelectMenu() || i.isUserSelectMenu() || i.isButton()) && i.customId.startsWith('bh:')) await handleComponent(i);
    else if (i.isModalSubmit() && i.customId.startsWith('bh:')) await handleModal(i);
  } catch (err) {
    console.error(`❌ Interaction ${i.commandName || i.customId} failed: ${err.message}`);
    console.error(err.stack);
    const content = '❌ Something went wrong. It has been logged — tell an admin if it keeps happening.';
    try {
      if (i.deferred || i.replied) await i.followUp(ephemeral({ content }));
      else if (i.isRepliable()) await i.reply(ephemeral({ content }));
    } catch { /* token expired */ }
  }
});

// ---------------------------------------------------------------------------
// Timers: Monday posting, multiplier, monthly winners, Players tab
// ---------------------------------------------------------------------------

const multiplierAnnounced = new Set();

async function checkMultiplier(t) {
  const s = S();
  const bounty = b.currentBounty(sheet.getBounties());
  if (!bounty || multiplierAnnounced.has(bounty.weekOf) || (s.closedWeeks || []).includes(bounty.weekOf)) return;
  const claims = b.activeClaims(sheet.getPoints(), bounty.weekOf);
  if (!b.multiplierActive(bounty, s, claims.length, t)) return;
  multiplierAnnounced.add(bounty.weekOf);
  const view = viewFor(bounty, t);
  const awards = await fetchChannel(s.awardsChannelId);
  await awards?.send({ embeds: [e.multiplierEmbed(bounty, s, view.firstNow, links())], ...e.rolePing('multiplier', s, { bounty }) }).catch(() => {});
  await refreshBoards();
}

async function checkMonthly(t) {
  const s = S();
  const thisMonth = b.monthRange(t);
  const prevMs = thisMonth.from - 1;
  const prevKey = b.monthKey(prevMs);
  if (s.lastMonthlyPost && s.lastMonthlyPost >= prevKey) return;
  if (!s.lastMonthlyPost) { // first run ever: start counting from now, don't announce the past
    await sheet.setSetting('Last_Monthly_Post', prevKey);
    return;
  }
  if (!(await runDraw(prevMs, prevKey))) return;
  const rows = b.standings(sheet.getPoints(), b.monthRange(prevMs));
  if (rows.length) {
    const monthName = new Date(prevMs).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const awards = await fetchChannel(s.awardsChannelId);
    const sent = await awards?.send({ embeds: [e.monthlyWinnersEmbed(rows, monthName)] }).catch(() => null);
    if (!sent) return; // try again next tick
  }
  await sheet.setSetting('Last_Monthly_Post', prevKey);
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!sheet.isAvailable() && !(await sheet.loadAll())) return;
    const t = now();
    await startPrizes(t);
    const s = S();
    // Old Apps Script (no History tab) = never post: the bot can't tell what already went up.
    const due = sheet.hasHistory() ? b.dueWeek(sheet.getBounties(), t, s) : null;
    if (due) await queue(() => postWeek(due));

    await checkMultiplier(t);
    await checkMonthly(t);
    await queue(settleExtras); // refunds for closed bounties and unanswered duels
    await queue(checkGoal);

    if (playersDirty) {
      playersDirty = false;
      const res = await sheet.writePlayers(b.playerSummary(sheet.getPoints(), t));
      if (!res.ok) playersDirty = true;
    }
  } catch (err) {
    console.error(`❌ Timer failed: ${err.message}`);
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag} (Bounty Hunter).`);
  sheet.configure(SHEET_URL);
  await sheet.loadAll();
  await ensureCommands();

  // Don't re-announce a multiplier that was already on before this restart.
  const current = b.currentBounty(sheet.getBounties());
  if (current && b.multiplierActive(current, S(), b.activeClaims(sheet.getPoints(), current.weekOf).length, now())) {
    multiplierAnnounced.add(current.weekOf);
  }

  const s = S();
  console.log(`👀 Submissions: ${s.submissionsChannelId || 'NOT SET'} · Board: ${s.boardChannelId || 'NOT SET'} · ` +
    `Awards: ${s.awardsChannelId || 'NOT SET'} · Shop admin: ${s.shopAdminChannelId || 'NOT SET'}`);
  if (sheet.hasHistory()) {
    const week = b.nextOpenWeek(sheet.getBounties(), now());
    const picked = b.waitingPick(sheet.getBounties());
    console.log(`🗓️ Next bounty: week of ${week}, due ${new Date(b.scheduledPostTime(week, s)).toISOString()} ` +
      `(${picked ? `${picked.boss}, picked by ${picked.chosenBy}` : `random from ${b.eligiblePool(sheet.getPool(), sheet.getBounties(), week, s).length} bounties`}).`);
  }

  await ensureGuide();
  await ensureRoleReaction();
  await refreshBoards();
  setInterval(tick, 60 * 1000);
  tick();
  setInterval(() => ensureCommands({ quiet: true }), 5 * 60 * 1000);
  setInterval(async () => { if (await sheet.refreshConfig()) { await ensureGuide(); await ensureRoleReaction(); await refreshBoards(); } }, 5 * 60 * 1000);
  setTimeout(cleanupChannels, 2 * 60 * 1000); // tidy old bot messages: soon after start, then every hour
  setInterval(cleanupChannels, 60 * 60 * 1000);
});

client.on(Events.Error, err => console.error(`❌ Discord client error: ${err.message}`));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));

client.login(TOKEN);
