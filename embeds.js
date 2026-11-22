// Every Discord message the bot shows, as plain embed objects (pure, testable).
//
// Times use Discord timestamps (<t:unix:f>), so every member sees them in their
// OWN timezone automatically.

const b = require('./bounty');
const x = require('./extras');

const GOLD = 0xF0B232;
const RED = 0xF23F43;
const GREEN = 0x23A55A;
const BLURPLE = 0x5865F2;
const GREY = 0x80848E;

const ts = (ms, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const chan = (id, fallback) => (id ? `<#${id}>` : fallback);
const HELP_HINT = '❓ New to bounties? Type /bhhelp';
/** Clickable "how it works" guide link + clickable /bhhelp (plain text if not known yet). */
const helpLine = (links = {}) =>
  `📖 ${links.guideUrl ? `[How it works](${links.guideUrl})` : 'How it works: see the pinned guide'} · ❓ Help: ${links.helpCmd || '**/bhhelp**'}`;
const clip = (text, max = 1024) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function weekLabel(weekOf) {
  const d = new Date(`${weekOf}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** The week a bounty ran (the Monday of its post time). Week Of itself is only its id. */
const shownWeek = bounty => (bounty.postedAt ? b.mondayOf(bounty.postedAt) : bounty.weekOf);

function partFields(bounty) {
  return bounty.parts.map((p, i) => ({
    name: bounty.parts.length > 1 ? `Part ${i + 1}` : 'What counts',
    value: clip(b.describePart(p)),
    inline: bounty.parts.length > 1 && bounty.parts.length <= 3
  }));
}

/**
 * State of a bounty for the pinned post and /bhbounty.
 * `claims` are active claim rows for this week (oldest first).
 */
function bountyView(bounty, { claims, inProgress, settings, now, closed, pot = 0, grand = 0 }) {
  const first = claims.find(c => String(c.type).toLowerCase() === b.TYPE_FIRST) || null;
  const multStart = b.multiplierStartsAt(bounty, settings);
  const multOn = b.multiplierActive(bounty, settings, claims.length, now);
  const firstBase = bounty.firstPoints ?? settings.defaultFirst;
  const later = bounty.laterPoints ?? settings.defaultLater;
  const firstNow = multOn ? Math.round(firstBase * settings.multiplier) : firstBase;
  return { first, multStart, multOn, firstBase, firstNow, later, claims, inProgress, closed, pot, grand };
}

/** The pinned weekly bounty post. */
function codeWordField(bounty) {
  return {
    name: '🔑 Code word',
    value: `**${bounty.codeWord}**\nType it in your in-game chat so it shows in every screenshot. No code word, no approval.`
  };
}

/**
 * A CLOSED bounty post, short: who claimed first, any big prize, and who claimed it.
 * `oneLine` (older posts): the names on one line, without points.
 */
function closedBoardEmbed(bounty, view, { oneLine = false } = {}) {
  const fields = [];
  if (view.grand > 0) {
    fields.push({ name: '🏆 Grand Bounty', value: view.first ? `**${view.grand}M GP** won by ${view.first.player}` : 'Not won', inline: true });
  }
  if (view.pot > 0) {
    fields.push({ name: '💰 Sponsor pot', value: view.first ? `**${view.pot} pts** went to ${view.first.player}` : `**${view.pot} pts** refunded`, inline: true });
  }
  if (view.claims.length) {
    const value = oneLine
      ? clip(view.claims.map(c => c.player).join(', '), 1024)
      : [...view.claims.slice(0, 25).map((c, i) => `${i === 0 && view.first ? '🥇' : `${i + 1}.`} ${c.player} · +${c.change}`),
        ...(view.claims.length > 25 ? [`…and ${view.claims.length - 25} more`] : [])].join('\n');
    fields.push({ name: `Claimed by (${view.claims.length})`, value });
  }
  return {
    color: GREY,
    author: { name: `🎯 BOUNTY · WEEK OF ${weekLabel(shownWeek(bounty)).toUpperCase()}` },
    title: `${bounty.boss} · CLOSED`,
    description: view.first
      ? `🥇 **${view.first.player}** claimed it first for **${view.first.change} points**. This bounty is closed.`
      : 'Nobody claimed this bounty. It is closed.',
    fields,
    footer: { text: 'Earlier bounties: /bhpast' }
  };
}

function boardEmbed(bounty, view, settings, links = {}) {
  if (view.closed) return closedBoardEmbed(bounty, view, { oneLine: view.oneLine });
  const fields = [...(bounty.codeWord && !view.closed ? [codeWordField(bounty)] : []), ...partFields(bounty)];
  let color = GOLD;
  let status = '';
  let description;
  const subs = chan(settings.submissionsChannelId, 'the submissions channel');
  const howTo = '**How to claim:**\n' +
    `1. Get the drop${bounty.parts.length > 1 ? `s for **all ${bounty.parts.length} parts** below` : ' below'}.\n` +
    `2. Screenshot it${bounty.codeWord ? ' with the **code word** visible in your chat' : ''}.\n` +
    `3. Post the screenshot in ${subs} and **type the item name** in the same message.\n` +
    `4. Wait for an approver to react ${settings.approveEmoji}. Done!\n\n` +
    helpLine(links);

  if (view.closed) {
    color = GREY;
    status = ' · CLOSED';
    description = view.first
      ? `🥇 **${view.first.player}** claimed it first for **${view.first.change} points**. This bounty is closed.`
      : 'Nobody claimed this bounty. It is closed.';
  } else if (view.first) {
    color = GREEN;
    status = ' · FIRST CLAIM TAKEN';
    description = `🥇 **${view.first.player}** claimed it first on ${ts(view.first.time)} for **${view.first.change} points**` +
      `${String(view.first.detail || '').includes('×') ? ' (multiplier)' : ''}.\n` +
      `You can still claim it for **${view.later} points** until the next bounty goes up.\n\n${howTo}`;
  } else if (view.multOn) {
    color = RED;
    status = ` · 🔥 ×${settings.multiplier} ACTIVE`;
    description = `Nobody has claimed this yet. **The first claim is now worth ${view.firstNow} points.**\n\n${howTo}`;
  } else {
    description = howTo;
  }

  if (bounty.chosenById) fields.push({ name: '🎯 Chosen by', value: `<@${bounty.chosenById}>`, inline: false });
  fields.push({ name: 'First claim', value: view.first ? `Taken by ${view.first.player}` : `**${view.firstNow} pts**${view.multOn ? ` ~~${view.firstBase}~~` : ''}`, inline: true });
  fields.push({ name: 'Later claims', value: `${view.later} pts each`, inline: true });
  if (view.pot > 0) {
    fields.push({ name: '💰 Sponsor pot', value: view.first ? `**${view.pot} pts** went to ${view.first.player}` : view.closed ? `**${view.pot} pts** refunded` : `**${view.pot} pts** extra for the first claim`, inline: true });
  }
  if (view.grand > 0) {
    fields.push({
      name: '🏆 Grand Bounty',
      value: view.first ? `**${view.grand}M GP** won by ${view.first.player}`
        : view.closed ? 'Not won. The next Grand Bounty pays more!'
          : `**${view.grand}M GP** for the first player to finish`,
      inline: true
    });
  }
  if (!view.first && !view.closed && view.multStart && !view.multOn) {
    fields.push({ name: `×${settings.multiplier} multiplier`, value: `${ts(view.multStart)} if still unclaimed`, inline: true });
  }

  const shown = view.claims.slice(0, 25).map((c, i) =>
    `${i === 0 && view.first ? '🥇' : `${i + 1}.`} ${c.player} · +${c.change}`);
  if (view.claims.length > 25) shown.push(`…and ${view.claims.length - 25} more`);
  fields.push({ name: `Claimed by (${view.claims.length})`, value: shown.join('\n') || 'Nobody yet. Be first!' });
  if (view.inProgress > 0 && !view.closed) {
    fields.push({ name: 'In progress', value: `${plural(view.inProgress, 'hunter')} part-way there` });
  }

  return {
    color,
    author: { name: `🎯 BOUNTY · WEEK OF ${weekLabel(shownWeek(bounty)).toUpperCase()}` },
    title: `${bounty.boss}${status}`,
    description,
    fields,
    footer: { text: `Ends when the next bounty is posted · /bhbounty = your progress · ${HELP_HINT}` }
  };
}

/** /bhbounty — the bounty plus the asking player's own progress. */
function progressEmbed(bounty, view, progress, claim, settings) {
  const doneParts = progress.filter(p => p.done).length;
  const lines = progress.map(p => {
    const got = p.items.length ? ` — ${p.items.join(', ')}` : '';
    const count = p.part.need > 1 ? ` (${Math.min(p.items.length, p.part.need)}/${p.part.need})` : '';
    return `${p.done ? '✅' : '⬜'} ${progress.length > 1 ? `Part ${p.index} · ` : ''}${b.describePart(p.part)}${count}${got}`;
  });

  let status;
  if (claim) status = `🎉 **You claimed this bounty** for ${claim.change} points.`;
  else if (view.closed) status = 'This bounty is closed.';
  else if (view.first) status = `First claim is taken by ${view.first.player}. Finish for **${view.later} pts**.`;
  else status = `Nobody has claimed it yet. First claim is worth **${view.firstNow} pts**${view.multOn ? ` (×${settings.multiplier} active!)` : ''}.`;

  return {
    color: claim ? GREEN : view.multOn ? RED : GOLD,
    title: `${bounty.boss} · your progress`,
    description: clip(`${status}\n\n` +
      (bounty.codeWord && !view.closed ? `🔑 Code word: **${bounty.codeWord}** (must be visible in each screenshot)\n\n` : '') +
      lines.join('\n'), 4000),
    fields: [
      { name: 'Parts done', value: `${doneParts} of ${progress.length}`, inline: true },
      { name: 'Claims so far', value: String(view.claims.length), inline: true },
      ...(!view.first && !view.closed && view.multStart && !view.multOn
        ? [{ name: `×${settings.multiplier} from`, value: ts(view.multStart), inline: true }] : [])
    ],
    footer: { text: 'New bounties go up on Mondays at a random hour (UTC)' }
  };
}

/** Awards channel: someone completed the bounty. */
function claimEmbed({ player, points, isFirst, multiplied, bounty, settings, claimNumber, balance, rank }) {
  if (isFirst) {
    return {
      color: GOLD,
      title: `🥇 First claim! ${player} takes the ${bounty.boss} bounty`,
      description: `**+${points} points**${multiplied ? ` (${points / settings.multiplier} × ${settings.multiplier} multiplier)` : ''}. ` +
        `The bounty stays open for ${bounty.laterPoints ?? settings.defaultLater} points per player until the next one goes up.`,
      footer: { text: `${player} · wallet ${balance.wallet} · earned ${balance.earned}${rank ? ` · #${rank} this month` : ''}` }
    };
  }
  return {
    color: GREEN,
    description: `✅ **${player}** completed the ${bounty.boss} bounty · **+${points} points** (claim ${claimNumber})`
  };
}

function multiplierEmbed(bounty, settings, firstNow, links = {}) {
  return {
    color: RED,
    title: `🔥 ×${settings.multiplier} is now active on the ${bounty.boss} bounty`,
    description: `Nobody has claimed it in ${settings.multiplierAfterHours} hours. The **first claim is now worth ${firstNow} points**.\n` +
      `Details: ${chan(settings.boardChannelId, 'the bounty board')} · Post screenshots in ${chan(settings.submissionsChannelId, 'the submissions channel')}\n${helpLine(links)}`
  };
}

function newBountyEmbed(bounty, boardUrl, settings = {}, links = {}, grand = 0) {
  return {
    color: GOLD,
    title: grand > 0 ? `🏆 GRAND BOUNTY: ${bounty.boss} · ${grand}M GP` : `🎯 New bounty: ${bounty.boss}`,
    description: `This week's bounty is up${boardUrl ? `: ${boardUrl}` : ` in ${chan(settings.boardChannelId, 'the bounty board')}`}.` +
      (grand > 0 ? `\n🏆 The **first player to finish** wins **${grand}M GP** on top of the points!` : '') +
      (bounty.chosenById ? `\n🎯 Chosen by <@${bounty.chosenById}>, who bought "Pick next week's bounty" in the shop.` : '') +
      (bounty.codeWord ? `\n🔑 Code word: **${bounty.codeWord}**. Have it visible in your screenshots.` : '') +
      `\n📸 Post your screenshots in ${chan(settings.submissionsChannelId, 'the submissions channel')} with the item name in the message.` +
      `\n${helpLine(links)}` +
      '\nGood luck, hunters!'
  };
}

/** Text table inside a code block; names padded so columns line up. */
function table(rows, nameWidth = 14) {
  const medal = i => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1).padEnd(2));
  const head = ` #  ${'Hunter'.padEnd(nameWidth)}  Pts  Claims  1st`;
  const body = rows.map((r, i) =>
    ` ${medal(i)} ${r.player.slice(0, nameWidth).padEnd(nameWidth)} ${String(r.points).padStart(4)}  ${String(r.claims).padStart(6)}  ${String(r.firsts).padStart(3)}`);
  return '```\n' + [head, ...body].join('\n') + '\n```';
}

function leaderboardEmbed(rows, { title, footer }) {
  return {
    color: GOLD,
    title: `🏆 ${title}`,
    description: rows.length ? table(rows.slice(0, 15)) : 'No points scored yet.',
    footer: { text: footer }
  };
}

function monthlyWinnersEmbed(rows, monthName) {
  const medals = ['🥇', '🥈', '🥉'];
  return {
    color: GOLD,
    title: `🏆 Bounty Hunters of ${monthName}`,
    description: rows.slice(0, 3).map((r, i) => `${medals[i]} **${r.player}** · ${r.points} pts · ${plural(r.claims, 'claim')}`).join('\n') +
      '\n\nThe monthly leaderboard has reset. Good hunting!'
  };
}

function meEmbed({ player, balance, monthRank, allRank, stats, recent }) {
  return {
    color: BLURPLE,
    title: `${player} · Bounty Hunter`,
    fields: [
      { name: '💰 Wallet', value: `${balance.wallet} pts`, inline: true },
      { name: '⭐ Earned', value: `${balance.earned} pts`, inline: true },
      { name: 'This month', value: `${monthRank ? `#${monthRank} · ` : ''}${balance.month} pts`, inline: true },
      { name: 'All time', value: allRank ? `#${allRank}` : 'unranked', inline: true },
      { name: 'Bounties', value: `${stats.claims} claimed · ${stats.firsts} first`, inline: true },
      { name: 'Recent', value: recent.length ? recent.join('\n') : 'Nothing yet' }
    ],
    footer: { text: 'Wallet = spendable · Earned = all points ever earned (leaderboards use this)' }
  };
}

/** A shop price: donations and gifts show their minimum. */
const priceText = it => (it.isDonate || it.isGift || it.isSponsor || it.isDuel ? `from ${b.minTransfer(it)} pts` : `${it.cost} pts`);

const goalText = g => `🎯 **${g.name}**: ${x.progressBar(g.progress, g.target)} **${g.progress}/${g.target} pts** donated`;

function shopEmbed(items, wallet, goal = null) {
  const lines = items.map((it, i) => {
    const stock = it.stock === null ? '' : it.stock > 0 ? ` · ${it.stock} left` : ' · sold out';
    return `**${i + 1}. ${it.item}** — ${priceText(it)}${stock}${it.description ? `\n${it.description}` : ''}`;
  });
  return {
    color: GOLD,
    title: '🛒 Bounty Shop',
    description: clip(`Your wallet: **${wallet} pts**${goal ? `\n${goalText(goal)}` : ''}\n\n${lines.join('\n\n') || 'The shop is empty right now.'}`, 4000),
    footer: { text: 'Buy with /bhbuy' }
  };
}

function confirmBuyEmbed(item, wallet, prizes = null) {
  const wheel = item.isWheel && prizes?.length
    ? `\n\n🎡 **Buying this spins the prize wheel.** The prizes:\n${wheelOddsText(prizes)}\n🎁 = an admin delivers it · points go straight to your wallet.`
    : '';
  return {
    color: BLURPLE,
    title: 'Confirm purchase',
    description: clip(`**${item.item}**${item.description ? `\n${item.description}` : ''}${wheel}\n\n` +
      `Cost **${item.cost} pts** · wallet after: **${wallet - item.cost} pts**\nYour earned points and rank stay the same.`, 4000)
  };
}

const pct = n => (n >= 10 || n === 0 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0+$/, '');

const prizeLabel = p => (p.kind === 'item' ? `${p.prize} 🎁` : p.prize);

/** The wheel's prizes with their odds (shown before buying a spin). */
function wheelOddsText(prizes) {
  const odds = b.wheelOdds(prizes);
  return prizes.map((p, i) => `\`${pct(odds[i]).padStart(5)}%\` ${prizeLabel(p)}${p.description ? ` — ${p.description}` : ''}`).join('\n');
}

/** One frame of the spin animation (the whole prize list with a pointer). */
function spinFrameEmbed(prizes, index, { player, done = false }) {
  const lines = prizes.slice(0, 30).map((p, i) => (i === index
    ? `▶️ **${prizeLabel(p)}** ${done ? '◀️' : ''}`
    : `▫️ ${prizeLabel(p)}`));
  const won = prizes[index];
  let result = '';
  if (done) {
    result = won.kind === 'nothing'
      ? `\n\n😬 **${player}** spun… **${won.prize}**. Better luck next time!`
      : won.kind === 'points'
        ? `\n\n🎉 **${player}** won **${won.prize}**! The points are in their wallet.`
        : `\n\n🎉 **${player}** won **${won.prize}**! An admin will deliver it.`;
  }
  return {
    color: done ? (won.kind === 'nothing' ? GREY : GREEN) : GOLD,
    title: done ? '🎡 Prize Wheel' : `🎡 ${player} is spinning…`,
    description: clip(lines.join('\n') + result, 4000)
  };
}

function adminPurchaseEmbed(purchase, deliveredBy = null) {
  const what = String(purchase.id).startsWith('W')
    ? `won **${purchase.item}** on the prize wheel.`
    : `bought **${purchase.item}** for ${purchase.cost} pts.`;
  return {
    color: deliveredBy ? GREEN : RED,
    description: `${String(purchase.id).startsWith('W') ? '🎡' : '🛒'} **${purchase.player}** (<@${purchase.playerId}>) ${what}\n` +
      (deliveredBy ? `✅ Delivered by ${deliveredBy}.` : 'React ✅ when delivered.'),
    footer: { text: `Purchase ${purchase.id}` }
  };
}

const pointsText = (bounty, settings) =>
  `1st **${bounty.firstPoints ?? settings.defaultFirst} pts** · later **${bounty.laterPoints ?? settings.defaultLater} pts**`;

/** "Pick next week's bounty": confirm the chosen bounty before paying. */
function confirmPickEmbed(bounty, weekOf, item, wallet, settings) {
  const parts = bounty.parts.map((p, i) => `${bounty.parts.length > 1 ? `**Part ${i + 1}:** ` : ''}${b.describePart(p)}`);
  return {
    color: BLURPLE,
    title: `Pick: ${bounty.boss}`,
    description: clip(`This will be the bounty for the week of **${weekLabel(weekOf)}**.\n\n${parts.join('\n')}\n\n` +
      `Points: ${pointsText(bounty, settings)}\nYou can claim it yourself too.\n\n` +
      'It stays **secret** until it goes up on Monday. Everyone will see that you bought the pick, but not which boss.\n\n' +
      `Cost **${item.cost} pts** · wallet after: **${wallet - item.cost} pts**`, 4000)
  };
}

/** Shop admin channel: info only (the bot delivers a pick by itself, no ✅ needed). */
function pickAdminEmbed({ player, playerId, bounty, weekOf, cost, settings }) {
  return {
    color: GREEN,
    description: clip(`🎯 **${player}** (<@${playerId}>) bought **Pick next week's bounty** for ${cost} pts and chose ` +
      `**${bounty.boss}** for the week of **${weekLabel(weekOf)}** (${pointsText(bounty, settings)}).\n` +
      'Nothing to deliver: the bot posts it on Monday. Keep it secret!\n' +
      'To undo: delete that row in the History tab and give the points back with `/bhgive`.', 4000)
  };
}

/** Admin log: every manual action, visible to the admin team in Discord. */
function adminLogEmbed({ admin, adminId, action, text, reason = '' }) {
  return {
    color: GREY,
    description: clip(`🛠️ **${admin}** (<@${adminId}>) used \`/${action}\`
${text}${reason ? `
📝 Reason: ${reason}` : ''}`, 4000),
    timestamp: new Date().toISOString()
  };
}

const quoted = text => text.split('\n').map(line => `> ${line}`).join('\n');

function confirmDonateEmbed({ amount, wallet, message }) {
  return {
    color: BLURPLE,
    title: 'Confirm donation',
    description: clip(`Donate **${amount} pts** to the clan. Your message goes to the admin team:\n${quoted(message)}\n\n` +
      `Wallet after: **${wallet - amount} pts**\nYour earned points and rank stay the same. Donations can't be undone by you.`, 4000)
  };
}

function confirmGiftEmbed({ toId, amount, wallet, note, giftLeft }) {
  return {
    color: BLURPLE,
    title: 'Confirm gift',
    description: clip(`Gift **${amount} pts** to <@${toId}>.${note ? `\nYour note, shown publicly:\n${quoted(note)}` : ''}\n\n` +
      `Wallet after: **${wallet - amount} pts** · gift limit left this week: **${giftLeft - amount} pts**\n` +
      'Everyone will see this gift. It can be spent, but it does not count as earned points or on leaderboards.', 4000)
  };
}

/** Shop admin channel: nothing to deliver, just the message. */
function donationAdminEmbed({ player, playerId, amount, message, id }) {
  return {
    color: GREEN,
    description: clip(`💝 **${player}** (<@${playerId}>) donated **${amount} pts** to the clan:\n${quoted(message)}`, 4000),
    footer: { text: `Donation ${id}` },
    timestamp: new Date().toISOString()
  };
}

/** The public gift post. `note` must already be cleaned and escaped. */
const giftAnnouncement = ({ fromId, toId, amount, note }) =>
  `🎁 <@${fromId}> gifted **${amount} pts** to <@${toId}>!${note ? `\n> ${note}` : ''}`;

/** The private message to the person who received a gift. */
const giftDm = ({ from, amount, note, wallet }) =>
  `🎁 **${from}** gifted you **${amount} Bounty Hunter points**!${note ? `\n> ${note}` : ''}\nYour wallet: **${wallet} pts**. Spend them with /bhbuy.`;

const confirmEmbed = (title, text) => ({ color: BLURPLE, title, description: clip(text, 4000) });

const goalProgressLine = (player, amount, goal) =>
  `💝 **${player}** donated **${amount} pts** to the clan.\n${goalText(goal)}`;

function goalReachedEmbed(goal, times = 1) {
  return {
    color: GOLD,
    title: `🎉 Clan goal reached: ${goal.name}`,
    description: clip(`Together you donated **${goal.target} pts**${times > 1 ? ` (${times} times over!)` : ''}. The admins will organise it. Thank you!`, 4000)
  };
}

const duelChallenge = ({ a, b: opponent, stake, boss, hours }) =>
  `⚔️ <@${a}> challenges <@${opponent}> to a **${boss}** bounty duel for **${stake} pts each**!\n` +
  `The first of you to claim this bounty takes **${stake * 2} pts**. If neither claims it, both are refunded.\n` +
  `<@${opponent}>, you have ${hours} hours to answer.`;

function giftLogEmbed({ player, playerId, toPlayer, toId, amount, note, id }) {
  return {
    color: GREY,
    description: clip(`🎁 **${player}** (<@${playerId}>) gifted **${amount} pts** to **${toPlayer}** (<@${toId}>).` +
      `${note ? `\n📝 ${note}` : ''}\nTo undo: use \`/bhgive\` to take the points back and return them.`, 4000),
    footer: { text: `Gift ${id}` },
    timestamp: new Date().toISOString()
  };
}

function pastEmbed(rows) {
  return {
    color: GREY,
    title: '📜 Past bounties',
    description: rows.length ? rows.join('\n') : 'No bounties posted yet.'
  };
}

/** /bhhelp — how Bounty Hunter works, step by step. Admin section only for admins. */
const GUIDE_TITLE = '🎯 Bounty Hunter — how it works';

function helpEmbed(settings, { admin = false, pinned = false } = {}) {
  const board = chan(settings.boardChannelId, 'the bounty board');
  const subs = chan(settings.submissionsChannelId, 'the submissions channel');
  const awards = chan(settings.awardsChannelId, 'the awards channel');
  const steps = [
    `**1.** Every **Monday** (random hour, UTC) a new boss bounty is posted and pinned in ${board}. Or type **/bhbounty**. ` +
      `The boss is random, and a boss doesn't come back within ${settings.repeatCooldownWeeks} weeks.`,
    '**2.** Get the drop(s) it asks for. Some bounties have several parts: you need **all** of them.',
    '**3.** Take a screenshot of the drop. If the bounty has a 🔑 **code word**, type it in your in-game chat first so it shows in the screenshot.',
    `**4.** Post the screenshot in ${subs} and **type the item name in the same message** (example: \`Spider leg top\`).`,
    `**5.** Wait for an approver to react ${settings.approveEmoji}. The bot reacts 🎯 and replies with your progress.`,
    `**6.** All parts done = bounty claimed! Claims are announced in ${awards}.`
  ];
  const points = [
    '🥇 The **first** player to finish gets the most points, everyone after gets fewer. Harder bounties pay more: the pinned post shows this week\'s points.',
    ...(settings.multiplier > 1
      ? [`🔥 Nobody finished after **${settings.multiplierAfterHours} hours**? The first claim becomes **×${settings.multiplier}**.`] : []),
    ...(settings.grandPrize > 0
      ? [`🏆 **Grand Bounty**: bounties marked 🏆 also pay the first finisher **${settings.grandPrize}M GP**. Not won? The next one pays ${settings.grandRollover}M more (up to ${Math.max(settings.grandMax, settings.grandPrize)}M).`] : []),
    ...(settings.drawPrize > 0
      ? [`🎟️ **Monthly draw**: every claim is 1 ticket, whatever the bounty. On the 1st of the month one ticket wins **${settings.drawPrize}M GP**.`] : []),
    'You can claim each bounty **once**. You have until the next bounty is posted.',
    '💰 **Wallet** = points you can spend in the shop. **Earned** = all points you ever got (the leaderboard uses this, so spending never hurts your rank).'
  ];
  const mistakes = [
    '❌ No item name in the message → **edit your message** and add it, then an approver re-checks it. No need to post again.',
    '❌ Code word not visible → post a new screenshot with it showing.',
    '❌ Screenshot from before the bounty went up → it can\'t count.',
    `❌ Posted somewhere else → it only counts in ${subs}.`,
    '⏳ No reaction yet? Approvers are people, give them some time. Don\'t delete your post.'
  ];
  const player = [
    '`/bhbounty` — this week\'s bounty + **your progress**',
    '`/bhme` — your wallet, points and rank (add a player to look someone up)',
    '`/bhtop` — leaderboard (this month or all time)',
    '`/bhshop` — what you can buy with points',
    '`/bhbuy` — buy something from the shop',
    '`/bhpast` — earlier bounties and who claimed them first',
    '`/bhhelp` — this guide'
  ];
  const adminCmds = [
    `To approve: react ${settings.approveEmoji} on the player's post. If the bot replies ❓, read why, fix it, then remove and re-add ${settings.approveEmoji}.`,
    '`/bhvoid` — undo an approved submission (paste its message link + a reason)',
    '`/bhgive` — add or remove points by hand (negative = remove; reason required)',
    '`/bhpost` — post a bounty now. Before this Monday\'s post = that bounty (incl. a pick); after = an extra random one. Next Monday still comes as normal',
    'Bounties tab = the list the bot picks from at random. Leave **Week Of** empty; type a Monday date only to force a bounty that week. The History tab shows every week.',
    '`/bhreload` — re-read the Google Sheet now (it also refreshes on its own every 5 min)',
    'Every admin action is logged in the admin log channel.'
  ];
  return {
    color: GOLD,
    title: GUIDE_TITLE,
    description: 'A new boss bounty every week. Get the drops, post a screenshot, earn points, spend them in the shop.',
    fields: [
      { name: '📋 How to take part', value: clip(steps.join('\n')) },
      { name: '🏆 Points', value: clip(points.join('\n')) },
      { name: '⚠️ Common mistakes', value: clip(mistakes.join('\n')) },
      { name: '⌨️ Commands', value: player.join('\n') },
      ...(admin ? [{ name: '🛠️ Admin only', value: clip(adminCmds.join('\n')) }] : [])
    ],
    footer: { text: pinned ? 'Type /bhhelp any time to see this guide again' : 'Only you can see this message' }
  };
}

/** Awards channel: someone won the Grand Bounty. */
function grandWinEmbed({ player, playerId, amount, bounty }) {
  return {
    color: GOLD,
    title: `🏆 GRAND BOUNTY WON! ${player} wins ${amount}M GP`,
    description: `<@${playerId}> was the first to finish the **${bounty.boss}** bounty and wins **${amount}M GP** on top of the points. ` +
      'An admin will trade it to you in game.'
  };
}

/** Awards channel: the monthly draw result. */
function drawEmbed({ monthName, winner, amount, entries }) {
  const total = entries.reduce((n, x2) => n + x2.tickets, 0);
  const list = entries.slice(0, 15).map(x2 => `${x2.player} · ${plural(x2.tickets, 'ticket')}`);
  if (entries.length > 15) list.push(`…and ${entries.length - 15} more`);
  return {
    color: GOLD,
    title: `🎟️ Monthly draw for ${monthName}: ${winner.player} wins ${amount}M GP!`,
    description: `Congratulations <@${winner.playerId}>! An admin will trade the **${amount}M GP** to you in game.\n\n` +
      `Every bounty claim was 1 ticket, whatever the tier. ${plural(total, 'ticket')} from ${plural(entries.length, 'player')}:\n` +
      clip(list.join('\n'), 3500) + '\n\nA new draw starts now: every claim this month is a ticket.'
  };
}

/** Shop admin channel: GP to pay in game for a Grand Bounty or draw win. */
function prizeAdminEmbed({ what, player, playerId, amount }) {
  return {
    color: RED,
    description: `🏆 **${player}** (<@${playerId}>) won **${amount}M GP** (${what}).\nTrade it in game, then react ✅.`,
    footer: { text: 'Recorded in the Points tab as type "gp prize"' }
  };
}

module.exports = {
  grandWinEmbed, drawEmbed, prizeAdminEmbed, closedBoardEmbed,
  ts, weekLabel, shownWeek, bountyView, boardEmbed, progressEmbed, claimEmbed, multiplierEmbed, newBountyEmbed,
  table, leaderboardEmbed, monthlyWinnersEmbed, meEmbed, shopEmbed, confirmBuyEmbed, confirmPickEmbed, pickAdminEmbed, adminPurchaseEmbed, pastEmbed,
  wheelOddsText, spinFrameEmbed, adminLogEmbed, helpEmbed, GUIDE_TITLE,
  priceText, confirmDonateEmbed, confirmGiftEmbed, donationAdminEmbed, giftAnnouncement, giftLogEmbed,
  giftDm, confirmEmbed, goalText, goalProgressLine, goalReachedEmbed, duelChallenge
};
