// Turning what a member typed into an item from the sheet.
//
// This mirrors the bingo bot's approach (`parseItem` + a fuse.js index) so the
// two events behave the same way for the people using them: you post the item
// name in plain text and the bot works out what you meant.
//
// It is a separate module, and pure, because fuzzy matching is the part of this
// flow that goes wrong silently. A bad threshold doesn't crash — it logs
// "Dragon Pickaxe" as "Dragon Platelegs" and nobody notices until the board is
// wrong. So every rule here is testable without Discord or a sheet.

const Fuse = require('fuse.js');

// Same default as the bingo bot's Fuse_Threshold. 0 = only exact matches,
// 1 = match anything. Overridable from the sheet.
const DEFAULT_FUSE_THRESHOLD = 0.4;

// Above this fraction of the threshold a match is a guess rather than a
// correction, and is worth flagging to the approver.
const WEAK_MATCH_FRACTION = 0.6;

// A message longer than this is a conversation, not a submission. Stops the bot
// fuzzy-matching an entire paragraph of chat into an item name.
const MAX_SUBMISSION_LENGTH = 120;

// More than this in one message is a typo ("Zenyte Shard x30" for x3), not a
// haul — refused so the approver's ✅ can't sign off a wildly wrong amount.
const MAX_QUANTITY = 1000;

/**
 * Pulls the item name, and how many, out of a posted message.
 *
 * The amount can go either side of the name, the way members actually type it:
 *   "Zenyte Shard"        -> 1
 *   "3 Zenyte Shard"      -> 3      "3x Zenyte Shard" / "3 x Zenyte Shard"
 *   "Zenyte Shard x3"     -> 3      "Zenyte Shard x 3" / "Zenyte Shard 3x"
 * A bare number at the END is NOT an amount — "Barrows Key 2" is a name.
 */
function parseSubmission(input) {
  const trimmed = String(input ?? '')
    // Strip Discord markdown so "**Dragon Pickaxe**" matches cleanly.
    .replace(/[*_~`|]/g, '')
    // Drop custom emoji and mentions — they are decoration, not item names.
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    // A URL in the text is the screenshot link, not part of the name.
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!trimmed) return { error: 'no item name in the message' };
  if (trimmed.length > MAX_SUBMISSION_LENGTH) {
    return { error: 'that message is too long to be an item name' };
  }

  let itemName = trimmed;
  let quantity = 1;

  const leading = /^(\d+)\s*[x×]?\s+(.+)$/i.exec(trimmed);
  const trailing = /^(.+?)\s+(?:[x×]\s*(\d+)|(\d+)\s*[x×])$/i.exec(trimmed);

  if (leading) {
    quantity = Number(leading[1]);
    itemName = leading[2].trim();
  } else if (trailing) {
    quantity = Number(trailing[2] ?? trailing[3]);
    itemName = trailing[1].trim();
  }

  if (!itemName) return { error: 'no item name in the message' };
  // A bare number is a count with nothing to count.
  if (/^\d+$/.test(itemName)) return { error: 'no item name in the message' };
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { error: 'the amount has to be at least 1' };
  }
  if (quantity > MAX_QUANTITY) {
    return { error: `${quantity} is more than ${MAX_QUANTITY} in one message, which is almost certainly a typo` };
  }

  return { itemName, quantity };
}

/**
 * Loose comparison, so "verac's  flail" and "Veracs Flail" count as the same
 * name and only genuine corrections get reported back to the approver.
 */
function sameItemName(a, b) {
  const clean = s => String(s ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')          // "veracs" == "verac's"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return clean(a) === clean(b);
}

/**
 * Builds the search index over the items in the race.
 *
 * Aliases are indexed as entries in their own right, each pointing back at the
 * canonical item. That's what makes "tbow" resolve to "Twisted Bow" — fuzzy
 * matching alone would never get there from three letters.
 */
function buildMatcher(items, threshold = DEFAULT_FUSE_THRESHOLD) {
  const entries = [];

  for (const item of items) {
    entries.push({ name: item.name, item });
    for (const alias of item.aliases ?? []) {
      if (alias) entries.push({ name: alias, item });
    }
  }

  const safeThreshold = Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
    ? threshold
    : DEFAULT_FUSE_THRESHOLD;

  const fuse = new Fuse(entries, { keys: ['name'], threshold: safeThreshold, includeScore: true });

  return { fuse, entries, threshold: safeThreshold };
}

/**
 * Finds the item a typed name refers to.
 *
 * Returns `{ item, matchedOn, score, exact, weak }`, or null when nothing is
 * close enough. An EXACT match (on the canonical name or an alias) short-circuits
 * the fuzzy search: with a long item list, fuse can otherwise score a different
 * item above a perfectly good exact hit.
 */
function findItem(matcher, typed) {
  const text = String(typed ?? '').trim();
  if (!text || !matcher) return null;

  for (const entry of matcher.entries) {
    if (sameItemName(entry.name, text)) {
      return { item: entry.item, matchedOn: entry.name, score: 0, exact: true, weak: false };
    }
  }

  const results = matcher.fuse.search(text);
  if (!results.length) return null;

  const best = results[0];
  const score = typeof best.score === 'number' ? best.score : 0;

  return {
    item: best.item.item,
    matchedOn: best.item.name,
    score,
    exact: false,
    // Near the threshold the match is a guess. The caller says so out loud
    // rather than quietly logging whatever fuse liked best.
    weak: score >= matcher.threshold * WEAK_MATCH_FRACTION
  };
}

module.exports = {
  MAX_QUANTITY,
  DEFAULT_FUSE_THRESHOLD,
  WEAK_MATCH_FRACTION,
  MAX_SUBMISSION_LENGTH,
  parseSubmission,
  sameItemName,
  buildMatcher,
  findItem
};
