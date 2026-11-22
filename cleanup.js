// Keeping the Bounty Hunter channels tidy (pure, testable).
//
// CLOSED BOUNTY POSTS go through stages, counted from the moment they close:
//   'list'   short post: who claimed first + "Claimed by" one name per line
//   'line'   after Bounty_Compact_After_Days (14): the names on one line
//   'delete' after Bounty_Delete_After_Days (30): the post is deleted (/bhpast still has it)
// 0 switches a stage off.
//
// SMALL BOT MESSAGES (claim announcements, ×multiplier alerts, gift notes, duels,
// wheel spins, bot replies…) are deleted after Cleanup_After_Days (7). Never
// deleted: pinned messages, bounty posts, and the big moments in KEEP_TITLES.

const DAY = 24 * 3600 * 1000;

/** Stage of a closed bounty post `closedAt` (ms), or 'open' if it hasn't closed. */
function closedStage(closedAt, now, s) {
  if (!Number.isFinite(closedAt) || now < closedAt) return 'open';
  const age = now - closedAt;
  if (s.bountyDeleteDays > 0 && age >= s.bountyDeleteDays * DAY) return 'delete';
  if (s.bountyCompactDays > 0 && age >= s.bountyCompactDays * DAY) return 'line';
  return 'list';
}

const KEEP_TITLES = ['🏆 GRAND BOUNTY WON', '🎟️ Monthly draw', '🏆 Bounty Hunters of', '🎉 Clan goal reached', '🎯 Bounty Hunter — how it works'];

/**
 * Should this message be cleaned up? `msg` = { authorId, createdAt, pinned, id, titles: [embed titles] }.
 * `keepIds` = bounty post message ids (they have their own stages).
 */
function shouldDelete(msg, { botId, now, days, keepIds = new Set() }) {
  if (!(days > 0)) return false;
  if (msg.authorId !== botId || msg.pinned || keepIds.has(msg.id)) return false;
  if (now - msg.createdAt < days * DAY) return false;
  return !(msg.titles || []).some(t => KEEP_TITLES.some(k => String(t || '').startsWith(k)));
}

module.exports = { closedStage, shouldDelete, KEEP_TITLES };
