// Every Discord message the bot shows, as plain embed objects (pure, testable).
//
// Times use Discord timestamps (<t:unix:f>), so every member sees them in their
// OWN timezone automatically.

const b = require('./bounty');

const GOLD = 0xF0B232;
const RED = 0xF23F43;
const GREEN = 0x23A55A;
const BLURPLE = 0x5865F2;
const GREY = 0x80848E;

const ts = (ms, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (text, max = 1024) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function weekLabel(weekOf) {
  const d = new Date(`${weekOf}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

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
function bountyView(bounty, { claims, inProgress, settings, now, closed }) {
  const first = claims.find(c => String(c.type).toLowerCase() === b.TYPE_FIRST) || null;
  const multStart = b.multiplierStartsAt(bounty, settings);
  const multOn = b.multiplierActive(bounty, settings, claims.length, now);
  const firstBase = bounty.firstPoints ?? settings.defaultFirst;
  const later = bounty.laterPoints ?? settings.defaultLater;
  const firstNow = multOn ? Math.round(firstBase * settings.multiplier) : firstBase;
  return { first, multStart, multOn, firstBase, firstNow, later, claims, inProgress, closed };
}

/** The pinned weekly bounty post. */
function codeWordField(bounty) {
  return {
    name: '🔑 Code word',
    value: `**${bounty.codeWord}**\nType it in your in-game chat so it shows in every screenshot. No code word, no approval.`
  };
}

function boardEmbed(bounty, view, settings) {
  const fields = [...(bounty.codeWord && !view.closed ? [codeWordField(bounty)] : []), ...partFields(bounty)];
  let color = GOLD;
  let status = '';
  let description;
  const subs = settings.submissionsChannelId ? `<#${settings.submissionsChannelId}>` : 'the submissions channel';
  const howTo = `Post a screenshot of each drop in ${subs} with the item name in the message. ` +
    'The **code word** must be visible in the screenshot.' +
    (bounty.parts.length > 1 ? ` All ${bounty.parts.length} parts are needed to claim.` : '');

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

  fields.push({ name: 'First claim', value: view.first ? `Taken by ${view.first.player}` : `**${view.firstNow} pts**${view.multOn ? ` ~~${view.firstBase}~~` : ''}`, inline: true });
  fields.push({ name: 'Later claims', value: `${view.later} pts each`, inline: true });
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
    author: { name: `🎯 BOUNTY · WEEK OF ${weekLabel(bounty.weekOf).toUpperCase()}` },
    title: `${bounty.boss}${status}`,
    description,
    fields,
    footer: { text: 'Ends when the next bounty is posted · /bhbounty shows your progress' }
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

function multiplierEmbed(bounty, settings, firstNow) {
  return {
    color: RED,
    title: `🔥 ×${settings.multiplier} is now active on the ${bounty.boss} bounty`,
    description: `Nobody has claimed it in ${settings.multiplierAfterHours} hours. The **first claim is now worth ${firstNow} points**.`
  };
}

function newBountyEmbed(bounty, boardUrl) {
  return {
    color: GOLD,
    title: `🎯 New bounty: ${bounty.boss}`,
    description: `This week's bounty is up${boardUrl ? `: ${boardUrl}` : ''}.` +
      (bounty.codeWord ? `\n🔑 Code word: **${bounty.codeWord}**. Have it visible in your screenshots.` : '') +
      ' Good luck, hunters!'
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

function shopEmbed(items, wallet) {
  const lines = items.map((it, i) => {
    const stock = it.stock === null ? '' : it.stock > 0 ? ` · ${it.stock} left` : ' · sold out';
    return `**${i + 1}. ${it.item}** — ${it.cost} pts${stock}${it.description ? `\n${it.description}` : ''}`;
  });
  return {
    color: GOLD,
    title: '🛒 Bounty Shop',
    description: clip(`Your wallet: **${wallet} pts**\n\n${lines.join('\n\n') || 'The shop is empty right now.'}`, 4000),
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

function pastEmbed(rows) {
  return {
    color: GREY,
    title: '📜 Past bounties',
    description: rows.length ? rows.join('\n') : 'No bounties posted yet.'
  };
}

module.exports = {
  ts, weekLabel, bountyView, boardEmbed, progressEmbed, claimEmbed, multiplierEmbed, newBountyEmbed,
  table, leaderboardEmbed, monthlyWinnersEmbed, meEmbed, shopEmbed, confirmBuyEmbed, adminPurchaseEmbed, pastEmbed,
  wheelOddsText, spinFrameEmbed, adminLogEmbed
};
