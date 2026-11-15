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
  MessageFlags, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');

const sheet = require('./sheet');
const b = require('./bounty');
const e = require('./embeds');
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

const reply = (message, content) => message.reply({ content, allowedMentions: NO_PINGS }).catch(err =>
  console.error(`⚠️ Could not reply in submissions: ${err.message}`));

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

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
  new SlashCommandBuilder().setName('bhvoid').setDescription('ADMIN: undo an approved bounty submission')
    .addStringOption(o => o.setName('message').setDescription('Link (or ID) of the submission message').setRequired(true)),
  new SlashCommandBuilder().setName('bhgive').setDescription('ADMIN: add or remove points by hand')
    .addUserOption(o => o.setName('player').setDescription('Who').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Points (negative to remove)').setRequired(true).setMinValue(-1000).setMaxValue(1000))
    .addStringOption(o => o.setName('reason').setDescription('Shown in the Points tab').setRequired(true)),
  new SlashCommandBuilder().setName('bhpost').setDescription("ADMIN: post the next bounty now instead of waiting for Monday"),
  new SlashCommandBuilder().setName('bhreload').setDescription('ADMIN: re-read the Google Sheet and refresh the bounty post')
].map(c => c.toJSON());

const optShape = opts => JSON.stringify((opts || []).map(o => [o.type, o.name, o.description, Boolean(o.required),
  (o.choices || []).map(c => [c.name, c.value]), o.min_value ?? null, o.max_value ?? null]));

/**
 * Creates/updates only OUR commands (POST upserts one command by name and
 * leaves every other command alone). Never a bulk overwrite.
 */
async function ensureCommands({ quiet = false } = {}) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID);
  try {
    const existing = await rest.get(route);
    let changed = 0;
    for (const cmd of commands) {
      const have = existing.find(c => c.name === cmd.name);
      if (have && have.description === cmd.description && optShape(have.options) === optShape(cmd.options)) continue;
      await rest.post(route, { body: cmd });
      changed++;
    }
    for (const c of existing) {
      if (c.name.startsWith('bh') && !commands.some(x => x.name === c.name)) {
        await rest.delete(Routes.applicationGuildCommand(CLIENT_ID, GUILD_ID, c.id));
        changed++;
      }
    }
    if (changed) console.log(`✅ Bounty commands: ${changed} added/updated (another bot may have reset them).`);
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
  return e.bountyView(bounty, { claims, inProgress, settings: S(), now: at, closed });
}

const lastRendered = new Map();

/** Re-renders the open bounty posts (and the one just closed), editing only what changed. */
async function refreshBoards() {
  const s = S();
  const posted = b.postedBounties(sheet.getBounties());
  if (!posted.length || !s.boardChannelId) return;
  const open = b.openBounties(sheet.getBounties(), now(), s);
  const oldestOpen = open[open.length - 1];
  const justClosed = posted.filter(x => !open.includes(x) && (!oldestOpen || x.postedAt < oldestOpen.postedAt)).pop();
  const targets = [...open, ...(justClosed ? [justClosed] : [])].filter(x => x.messageId);
  if (!targets.length) return;

  const channel = await fetchChannel(s.boardChannelId);
  if (!channel) return;
  for (const bounty of targets) {
    const embed = e.boardEmbed(withCode(bounty), viewFor(bounty), s);
    const key = JSON.stringify(embed);
    if (lastRendered.get(bounty.messageId) === key) continue;
    try {
      const msg = await channel.messages.fetch(bounty.messageId);
      await msg.edit({ embeds: [embed] });
      lastRendered.set(bounty.messageId, key);
    } catch (err) {
      console.error(`⚠️ Could not update the bounty post for ${bounty.weekOf}: ${err.message}`);
    }
  }
}

const warnedPost = new Set();

async function postBounty(bounty) {
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
  const view = e.bountyView(draft, { claims: [], inProgress: 0, settings: s, now: postedAt, closed: false });
  const msg = await channel.send({ embeds: [e.boardEmbed(draft, view, s)] });
  await msg.pin().catch(err => console.error(`⚠️ Could not pin the bounty (needs Pin Messages permission): ${err.message}`));
  await sheet.markPosted(bounty.weekOf, postedAt, msg.id, draft.codeWord);
  console.log(`🎯 Posted bounty ${bounty.weekOf}: ${bounty.boss}`);

  if (previous?.messageId) {
    const old = await channel.messages.fetch(previous.messageId).catch(() => null);
    await old?.unpin().catch(() => {});
  }
  if (s.awardsChannelId && s.awardsChannelId !== s.boardChannelId) {
    const awards = await fetchChannel(s.awardsChannelId);
    await awards?.send({ embeds: [e.newBountyEmbed(draft, msg.url)] }).catch(() => {});
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
    await reply(message, `${QUESTION} I couldn't find an item name in this message (${parsed.error}). Edit the message to say which drop it is, then remove and re-add ${s.approveEmoji}.`);
    await message.react(QUESTION).catch(() => {});
    return;
  }

  const candidates = b.openBounties(sheet.getBounties(), t, s).filter(x => x.postedAt <= message.createdTimestamp);
  if (!candidates.length) {
    await reply(message, `${QUESTION} This was posted before the current bounty went up, so it can't count.`);
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
    await reply(message, `${QUESTION} ${problem || `"${parsed.itemName}" isn't part of the **${current.boss}** bounty. Check the spelling (see /bhbounty), edit the message, then remove and re-add ${s.approveEmoji}.`}`);
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
  await awards?.send({ embeds: [e.claimEmbed({ player, points, isFirst, multiplied, bounty, settings: s, claimNumber, balance, rank })] })
    .catch(err => console.error(`⚠️ Could not post in awards: ${err.message}`));
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

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    const s = S();
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
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

function nextMondayText() {
  const nextMonday = b.dayMs(b.mondayOf(now())) + 7 * b.DAY;
  return `Monday ${e.weekLabel(b.isoDate(nextMonday))}`;
}

const handlers = {
  async bhbounty(i) {
    if (!(await needSheet(i))) return;
    const bounty = b.currentBounty(sheet.getBounties());
    if (!bounty) return i.reply(ephemeral({ content: `No bounty has been posted yet. The next one goes up on ${nextMondayText()} (random hour, UTC).` }));
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
      .map(p => `${String(p.type).toLowerCase() === b.TYPE_SHOP ? '🛒 ' : ''}${p.detail || p.type} · ${Number(p.change) > 0 ? '+' : ''}${p.change}`);
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
    return i.reply(ephemeral({ embeds: [e.shopEmbed(sheet.getShop().filter(x => x.active), wallet)] }));
  },

  async bhbuy(i) {
    if (!(await needSheet(i))) return;
    const items = sheet.getShop().filter(x => x.active).slice(0, 25);
    if (!items.length) return i.reply(ephemeral({ content: 'The shop is empty right now.' }));
    const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
    const menu = new StringSelectMenuBuilder().setCustomId('bh:buy').setPlaceholder('Pick an item')
      .addOptions(items.map(it => ({
        label: `${it.item} — ${it.cost} pts`.slice(0, 100),
        value: it.item.slice(0, 100),
        description: (b.inStock(it) ? it.description || ' ' : 'Sold out').slice(0, 100)
      })));
    return i.reply(ephemeral({ content: `Your wallet: **${wallet} pts**. What would you like?`, components: [new ActionRowBuilder().addComponents(menu)] }));
  },

  async bhpast(i) {
    if (!(await needSheet(i))) return;
    const posted = b.postedBounties(sheet.getBounties()).reverse().slice(0, 12);
    const rows = posted.map(x => {
      const claims = b.activeClaims(sheet.getPoints(), x.weekOf);
      const first = claims.find(c => String(c.type).toLowerCase() === b.TYPE_FIRST);
      return `**${e.weekLabel(x.weekOf)}** · ${x.boss} — ${first ? `🥇 ${first.player} · ${claims.length} claims` : 'no claims'}`;
    });
    return i.reply(ephemeral({ embeds: [e.pastEmbed(rows)] }));
  },

  async bhvoid(i) {
    if (!(await needAdmin(i)) || !(await needSheet(i))) return;
    const id = b.messageIdFrom(i.options.getString('message'));
    if (!id) return i.reply(ephemeral({ content: 'Give me the message link (right-click the message → Copy Message Link) or its ID.' }));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await queue(() => voidSubmission(id, i));
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
    return i.editReply({ content: `${amount > 0 ? '➕' : '➖'} ${amount > 0 ? '+' : ''}${amount} pts for **${player}** (${reason}). Wallet ${bal.wallet} · earned ${bal.earned}.` });
  },

  async bhpost(i) {
    if (!(await needAdmin(i)) || !(await needSheet(i))) return;
    const next = b.nextUnposted(sheet.getBounties(), now());
    if (!next) return i.reply(ephemeral({ content: 'There is no active, unposted bounty for this week or later in the Bounties tab.' }));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await queue(() => postBounty(next));
    return i.editReply({ content: res.ok ? `✅ Posted the **${next.boss}** bounty (week of ${e.weekLabel(next.weekOf)}): ${res.url}` : `❌ Not posted: ${res.error}` });
  },

  async bhreload(i) {
    if (!(await needAdmin(i))) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const ok = await sheet.loadAll();
    lastRendered.clear();
    if (ok) await refreshBoards();
    const warns = sheet.warnings();
    return i.editReply({ content: ok
      ? `✅ Sheet re-read. ${sheet.getBounties().length} bounties, ${sheet.getShop().length} shop items.${warns.length ? `\n⚠️ ${warns.slice(0, 5).join('\n⚠️ ')}` : ''}`
      : '❌ Could not read the sheet. Check the SHEET_URL deployment.' });
  }
};

async function voidSubmission(messageId, i) {
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
      detail: `Voided claim: ${bounty?.boss || row.weekOf}`, by, weekOf: row.weekOf, ref: claim.ref });
    playersDirty = true;
    extra = ` Their claim (${claim.change} pts) was taken back.`;
    if (String(claim.type).toLowerCase() === b.TYPE_FIRST) extra += ' It was the FIRST claim: the bonus does not move to anyone else automatically (use /bhgive if needed).';
  }

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

async function handleComponent(i) {
  if (i.customId === 'bh:buy') {
    const name = i.values[0];
    const item = sheet.getShop().find(x => x.item.slice(0, 100) === name && x.active);
    const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
    if (!item) return i.update({ content: 'That item is no longer for sale.', components: [], embeds: [] });
    if (!b.inStock(item)) return i.update({ content: `**${item.item}** is sold out.`, components: [], embeds: [] });
    if (wallet < item.cost) return i.update({ content: `You have **${wallet} pts**; **${item.item}** costs **${item.cost} pts**.`, components: [], embeds: [] });
    pendingBuys.set(i.user.id, item.item);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bh:buyok').setStyle(ButtonStyle.Success).setLabel(`Buy for ${item.cost} pts`),
      new ButtonBuilder().setCustomId('bh:buyno').setStyle(ButtonStyle.Secondary).setLabel('Cancel'));
    return i.update({ content: '', embeds: [e.confirmBuyEmbed(item, wallet)], components: [row] });
  }

  if (i.customId === 'bh:buyno') {
    pendingBuys.delete(i.user.id);
    return i.update({ content: 'Cancelled. Nothing was spent.', embeds: [], components: [] });
  }

  if (i.customId === 'bh:buyok') {
    const itemName = pendingBuys.get(i.user.id);
    if (!itemName) return i.update({ content: 'That purchase expired. Run /bhbuy again.', embeds: [], components: [] });
    pendingBuys.delete(i.user.id);
    await i.update({ content: '⏳ Buying…', embeds: [], components: [] });
    const player = await displayName(i.guild, i.user);
    const res = await queue(() => sheet.buy({ item: itemName, player, playerId: i.user.id }));
    if (!res.ok) return i.editReply({ content: `❌ Not bought: ${res.error}. Nothing was spent.` });
    playersDirty = true;

    const admin = await fetchChannel(S().shopAdminChannelId);
    const ping = await admin?.send({ embeds: [e.adminPurchaseEmbed(res.purchase)], allowedMentions: NO_PINGS }).catch(() => null);
    if (ping) {
      await ping.react(DELIVERED).catch(() => {});
      await sheet.setPurchaseMessage(res.purchase.id, ping.id);
    } else {
      console.error(`⚠️ Purchase ${res.purchase.id} saved, but the admin ping could not be posted (check Shop_Admin_Channel_ID).`);
    }
    const wallet = b.balances(sheet.getPoints(), i.user.id, now()).wallet;
    return i.editReply({ content: `✅ You bought **${res.purchase.item}** for ${res.purchase.cost} pts. An admin will deliver it. Wallet now: **${wallet} pts**.` });
  }
}

client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isChatInputCommand()) {
      const handler = i.commandName.startsWith('bh') ? handlers[i.commandName] : null;
      if (handler) await handler(i);
      return; // not ours — the event bot answers it
    }
    if ((i.isStringSelectMenu() || i.isButton()) && i.customId.startsWith('bh:')) await handleComponent(i);
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
const warnedMissingWeek = new Set();

async function checkMultiplier(t) {
  const s = S();
  const bounty = b.currentBounty(sheet.getBounties());
  if (!bounty || multiplierAnnounced.has(bounty.weekOf)) return;
  const claims = b.activeClaims(sheet.getPoints(), bounty.weekOf);
  if (!b.multiplierActive(bounty, s, claims.length, t)) return;
  multiplierAnnounced.add(bounty.weekOf);
  const view = viewFor(bounty, t);
  const awards = await fetchChannel(s.awardsChannelId);
  await awards?.send({ embeds: [e.multiplierEmbed(bounty, s, view.firstNow)] }).catch(() => {});
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
    const s = S();
    const due = b.dueBounty(sheet.getBounties(), t, s);
    if (due) await queue(() => postBounty(due));

    const week = b.mondayOf(t);
    if (t >= b.scheduledPostTime(week, s) && !sheet.getBounties().some(x => x.weekOf === week && x.active) && !warnedMissingWeek.has(week)) {
      warnedMissingWeek.add(week);
      console.warn(`⚠️ No active Bounties row for the week of ${week}. Last week's bounty stays open.`);
    }

    await checkMultiplier(t);
    await checkMonthly(t);

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
  const week = b.mondayOf(now());
  const thisWeek = sheet.getBounties().find(x => x.weekOf === week && x.active);
  if (thisWeek && !thisWeek.postedAt) console.log(`🗓️ This week's bounty (${thisWeek.boss}) is due ${new Date(b.scheduledPostTime(week, s)).toISOString()}.`);

  await refreshBoards();
  setInterval(tick, 60 * 1000);
  tick();
  setInterval(() => ensureCommands({ quiet: true }), 5 * 60 * 1000);
  setInterval(async () => { if (await sheet.refreshConfig()) await refreshBoards(); }, 5 * 60 * 1000);
});

client.on(Events.Error, err => console.error(`❌ Discord client error: ${err.message}`));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));

client.login(TOKEN);
