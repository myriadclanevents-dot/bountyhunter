/**
 * Bounty Hunter — Google Sheet back end + setup.
 *
 * ONE-TIME INSTALL (replaces the old setup script):
 *   1. Extensions → Apps Script. Delete everything in the editor, paste this file, Save.
 *   2. Run "setupBountyHunter" once (adds the new Drops tab; existing tabs are not touched).
 *   3. Deploy → New deployment → type "Web app"
 *        Execute as: Me      Who has access: Anyone
 *      Copy the URL ending in /exec — that is the bot's SHEET_URL.
 *
 * After pasting a NEWER version of this file later: Deploy → Manage deployments →
 * ✏️ edit → Version: "New version" → Deploy. (Same URL, the bot keeps working.)
 *
 * The bot reads and writes columns BY HEADER NAME, so admins may reorder
 * columns or add their own. Bot-written columns that are missing are added
 * automatically on the first write.
 */

var ADMIN_COLOR = '#FFF2CC'; // yellow = admins fill in
var BOT_COLOR = '#E7E9EE';   // grey   = the bot writes
var HEAD_FONT = '#1C2230';

// field, header, kind (date = timestamp, day = date only, id = Discord id kept as text)
var TABS = {
  submissions: { name: 'Submissions', cols: [
    ['submittedAt', 'Submitted (UTC)', 'date', 'When the screenshot was posted'],
    ['approvedAt', 'Approved (UTC)', 'date', 'When the admin reacted'],
    ['weekOf', 'Week Of', 'day', 'Which bounty (its Monday)'],
    ['part', 'Part', '', 'Which part of the bounty (1, 2, 3)'],
    ['item', 'Item', '', 'The item it was approved as'],
    ['player', 'Player', '', 'Discord display name'],
    ['playerId', 'Player ID', 'id', 'Discord user id'],
    ['approver', 'Approver', '', 'Admin who reacted'],
    ['approverId', 'Approver ID', 'id', 'Discord user id of the admin'],
    ['messageLink', 'Message Link', '', 'Link to the Discord message'],
    ['messageId', 'Message ID', 'id', 'Discord message id'],
    ['status', 'Status', '', 'approved / void. The LAST row for a message wins.']
  ]},
  points: { name: 'Points', cols: [
    ['time', 'Time (UTC)', 'date', 'When the points changed'],
    ['player', 'Player', '', 'Discord display name'],
    ['playerId', 'Player ID', 'id', 'Discord user id'],
    ['change', 'Change', '', 'Points added (+) or spent/removed (−)'],
    ['type', 'Type', '', 'first claim / claim / shop / admin / void'],
    ['detail', 'Detail', '', 'Which bounty, shop item or reason'],
    ['by', 'By', '', 'Admin who approved or gave the points'],
    ['weekOf', 'Week Of', 'day', 'Bounty week, for claims'],
    ['ref', 'Ref', '', 'Links a claim to its void, or a shop line to its purchase'],
    ['opId', 'Op ID', '', 'Unique id of this write (stops a retried write counting twice)']
  ]},
  purchases: { name: 'Purchases', cols: [
    ['time', 'Time (UTC)', 'date', 'When it was bought'],
    ['player', 'Player', '', 'Discord display name'],
    ['playerId', 'Player ID', 'id', 'Discord user id'],
    ['item', 'Item', '', 'Shop item'],
    ['cost', 'Cost', '', 'Points spent'],
    ['deliveredBy', 'Delivered By', '', 'Admin who reacted ✅ in the admin channel'],
    ['deliveredAt', 'Delivered (UTC)', 'date', 'When it was delivered'],
    ['id', 'Purchase ID', '', 'Unique purchase id'],
    ['adminMessageId', 'Admin Message ID', 'id', 'The ping in the admin channel']
  ]},
  players: { name: 'Players', cols: [
    ['player', 'Player', '', 'Discord display name'],
    ['playerId', 'Player ID', 'id', 'Discord user id'],
    ['wallet', 'Wallet', '', 'Spendable points (goes down when buying)'],
    ['earned', 'Earned', '', 'All points ever earned (never goes down)'],
    ['month', 'This Month', '', 'Points earned this calendar month (UTC)'],
    ['claims', 'Claims', '', 'Bounties completed'],
    ['firsts', 'First Claims', '', 'Bounties claimed first']
  ]},
  bounties: { name: 'Bounties', cols: [
    ['weekOf', 'Week Of', 'day', ''],
    ['boss', 'Boss', '', ''],
    ['firstPoints', 'First Points', '', ''],
    ['laterPoints', 'Later Points', '', ''],
    ['active', 'Active', '', ''],
    ['notes', 'Notes', '', ''],
    ['codeWord', 'Code Word', '', 'Word players must show in every screenshot (e.g. typed in game chat).\nLeave EMPTY and the bot picks a secret one when it posts the bounty.\nType your own to choose it — keep it secret until Monday!'],
    ['postedAt', 'Posted At (UTC)', 'date', 'BOT FILLS THIS — leave empty'],
    ['messageId', 'Message ID', 'id', 'BOT FILLS THIS — leave empty']
  ]},
  shop: { name: 'Shop', cols: [
    ['item', 'Item', '', ''], ['cost', 'Cost', '', ''], ['stock', 'Stock', '', ''],
    ['active', 'Active', '', ''], ['description', 'Description', '', ''], ['deliveredHow', 'Delivered How', '', '']
  ]},
  wheel: { name: 'Wheel', cols: [
    ['prize', 'Prize', '', 'What the player wins, as shown on the wheel (e.g. "+20 pts", "5m GP")'],
    ['weight', 'Weight', '', 'Relative chance. Weights 40 / 10 / 1 = 40:10:1. If they add up to 100 they are percentages. 0 = off'],
    ['kind', 'Kind', '', 'points = added to the wallet automatically\nitem = an admin delivers it (ping in the shop admin channel)\nnothing = no prize\nEmpty: points if Points > 0, else item'],
    ['points', 'Points', '', 'Only for Kind "points": how many points go into the wallet'],
    ['active', 'Active', '', 'TRUE/FALSE. Empty = on'],
    ['description', 'Description', '', 'Optional short text shown next to the prize in /bhspin']
  ]},
  drops: { name: 'Drops', cols: [['boss', 'Boss', '', ''], ['item', 'Item', '', '']] },
  approvers: { name: 'Approvers', cols: [['id', 'Discord User ID', 'id', ''], ['name', 'Name', '', '']] },
  settings: { name: 'Settings', cols: [['key', 'Setting', '', ''], ['value', 'Value', '', ''], ['meaning', 'Meaning', '', '']] }
};

// ===========================================================================
// Web app entry points
// ===========================================================================

function doGet(e) {
  try {
    var type = (e && e.parameter && e.parameter.type) || 'all';
    var config = {
      ok: true,
      bounties: readBounties_(),
      drops: readTab_(TABS.drops),
      shop: readTab_(TABS.shop),
      wheel: readTab_(TABS.wheel),
      approvers: readTab_(TABS.approvers).map(function (r) { return r.id; }).filter(String),
      settings: readSettings_()
    };
    if (type === 'config') return json_(config);
    if (type === 'all') {
      config.submissions = readTab_(TABS.submissions);
      config.points = readTab_(TABS.points);
      config.purchases = readTab_(TABS.purchases);
      return json_(config);
    }
    return json_({ ok: false, error: 'unknown type ' + type });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    var p = JSON.parse(e.postData.contents);
    switch (p.action) {
      case 'submission': appendObj_(TABS.submissions, p.row); return json_({ ok: true });
      case 'points': return json_(appendPoints_(p.row));
      case 'buy': return json_(buy_(p));
      case 'bountyPosted': return json_(bountyPosted_(p));
      case 'purchaseMessage': return json_(updatePurchase_(p.id, { adminMessageId: p.adminMessageId }));
      case 'purchaseDelivered': return json_(updatePurchase_(p.id, { deliveredBy: p.deliveredBy, deliveredAt: p.deliveredAt }));
      case 'setting': return json_(setSetting_(p.key, p.value));
      case 'players': return json_(writePlayers_(p.rows || []));
      default: return json_({ ok: false, error: 'unknown action ' + p.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

// ===========================================================================
// Reading
// ===========================================================================

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function norm_(h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function sheet_(spec) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(spec.name);
  if (!sh) {
    sh = ss.insertSheet(spec.name);
    header_(sh, spec.cols.map(function (c) { return [c[1], c[3]]; }), BOT_COLOR);
  }
  return sh;
}

/** field -> column number. With ensure, missing headers are added on the right. */
function columns_(sh, spec, ensure) {
  var width = Math.max(sh.getLastColumn(), 1);
  var heads = sh.getRange(1, 1, 1, width).getValues()[0].map(norm_);
  var map = {};
  spec.cols.forEach(function (c) {
    var i = heads.indexOf(norm_(c[1]));
    if (i === -1 && ensure) {
      width = heads[0] === '' && width === 1 ? 1 : width + 1;
      heads[width - 1] = norm_(c[1]);
      sh.getRange(1, width).setValue(c[1]).setFontWeight('bold').setBackground(BOT_COLOR).setNote(c[3] || '');
      i = width - 1;
    }
    if (i !== -1) map[c[0]] = i + 1;
  });
  return map;
}

function isoDay_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Etc/UTC', 'yyyy-MM-dd');
  var s = String(v || '').trim();
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // dd/mm/yyyy typed as text
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return s;
}

function readTab_(spec) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(spec.name);
  if (!sh || sh.getLastRow() < 2) return [];
  var map = columns_(sh, spec, false);
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var kinds = {};
  spec.cols.forEach(function (c) { kinds[c[0]] = c[2]; });
  var out = [];
  values.forEach(function (row) {
    if (row.join('') === '') return;
    var obj = {};
    Object.keys(map).forEach(function (f) {
      var v = row[map[f] - 1];
      if (kinds[f] === 'date') v = v instanceof Date ? v.getTime() : (v === '' ? null : Number(v) || null);
      else if (kinds[f] === 'day') v = isoDay_(v);
      else if (kinds[f] === 'id') v = String(v).replace(/^'/, '').trim();
      obj[f] = v;
    });
    out.push(obj);
  });
  return out;
}

function readBounties_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.bounties.name);
  if (!sh || sh.getLastRow() < 2) return [];
  var heads = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var partCols = [];
  heads.forEach(function (h, i) {
    var m = /^part\s*(\d+)$/i.exec(String(h).trim());
    if (m) partCols.push({ n: Number(m[1]), col: i });
  });
  partCols.sort(function (a, b) { return a.n - b.n; });
  var rows = readTab_(TABS.bounties);
  var raw = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().filter(function (r) { return r.join('') !== ''; });
  return rows.map(function (r, i) {
    r.parts = partCols.map(function (p) { return String(raw[i][p.col] || ''); });
    return r;
  });
}

function readSettings_() {
  var out = {};
  readTab_(TABS.settings).forEach(function (r) {
    var k = String(r.key || '').trim();
    if (k) out[k] = r.value instanceof Date ? r.value.toISOString() : r.value;
  });
  return out;
}

// ===========================================================================
// Writing
// ===========================================================================

function cellValue_(kind, v) {
  if (v === null || v === undefined) return '';
  if (kind === 'date') return v === '' ? '' : new Date(Number(v));
  if (kind === 'day') return v ? new Date(String(v) + 'T12:00:00Z') : '';
  if (kind === 'id') return String(v);
  return v;
}

function appendObj_(spec, obj) {
  var sh = sheet_(spec);
  var map = columns_(sh, spec, true);
  var row = sh.getLastRow() + 1;
  var width = sh.getLastColumn();
  var arr = [];
  for (var i = 0; i < width; i++) arr.push('');
  spec.cols.forEach(function (c) {
    var col = map[c[0]];
    if (!col) return;
    var cell = sh.getRange(row, col);
    if (c[2] === 'id') cell.setNumberFormat('@');
    if (c[2] === 'date') cell.setNumberFormat('dd/mm/yyyy hh:mm');
    if (c[2] === 'day') cell.setNumberFormat('dd/mm/yyyy');
    arr[col - 1] = cellValue_(c[2], obj[c[0]]);
  });
  sh.getRange(row, 1, 1, width).setValues([arr]);
  return row;
}

function appendPoints_(row) {
  if (row.opId) {
    var seen = readTab_(TABS.points).some(function (r) { return String(r.opId) === String(row.opId); });
    if (seen) return { ok: true, duplicate: true };
  }
  appendObj_(TABS.points, row);
  return { ok: true };
}

function walletOf_(playerId) {
  var seen = {};
  return readTab_(TABS.points).reduce(function (sum, r) {
    if (String(r.playerId) !== String(playerId)) return sum;
    if (r.opId) { if (seen[r.opId]) return sum; seen[r.opId] = true; }
    return sum + (Number(String(r.change).replace(',', '.')) || 0);
  }, 0);
}

function buy_(p) {
  var sh = sheet_(TABS.shop);
  var map = columns_(sh, TABS.shop, false);
  if (!map.item || !map.cost) return { ok: false, error: 'the Shop tab needs Item and Cost columns' };
  var last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'the shop is empty' };
  var values = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  var want = norm_(p.item);
  for (var i = 0; i < values.length; i++) {
    if (norm_(values[i][map.item - 1]) !== want) continue;
    var active = map.active ? values[i][map.active - 1] : true;
    if (!(active === true || /^(true|yes|1|x)$/i.test(String(active)))) return { ok: false, error: 'that item is not for sale right now' };
    var cost = Number(String(values[i][map.cost - 1]).replace(',', '.'));
    var stockCell = map.stock ? values[i][map.stock - 1] : '';
    var stock = stockCell === '' ? null : Number(stockCell);
    if (stock !== null && stock <= 0) return { ok: false, error: 'sold out' };
    var wallet = walletOf_(p.playerId);
    if (wallet < cost) return { ok: false, error: 'not enough points (wallet ' + wallet + ', cost ' + cost + ')' };
    if (stock !== null) sh.getRange(i + 2, map.stock).setValue(stock - 1);

    var time = Number(p.time) || Date.now();
    var purchase = { id: 'P' + time, time: time, player: p.player, playerId: p.playerId, item: String(values[i][map.item - 1]), cost: cost };
    appendObj_(TABS.purchases, purchase);
    var points = { time: time, player: p.player, playerId: p.playerId, change: -cost, type: 'shop', detail: purchase.item, by: '', ref: purchase.id, opId: p.opId || purchase.id };
    appendObj_(TABS.points, points);
    var win = wheelWin_(p, purchase);
    return { ok: true, purchase: purchase, points: points, stockLeft: stock === null ? null : stock - 1,
      wheelPoints: win.wheelPoints || null, wheelPurchase: win.wheelPurchase || null };
  }
  return { ok: false, error: 'no shop item called ' + p.item };
}

/** A bought wheel spin: the prize the bot picked is saved with the purchase. */
function wheelWin_(p, purchase) {
  var w = p.wheel;
  var out = {};
  if (!w) return out;
  var won = Number(w.points) || 0;
  if (w.kind === 'points' && won > 0) {
    out.wheelPoints = { time: purchase.time, player: p.player, playerId: p.playerId, change: won, type: 'wheel', detail: 'Wheel: ' + w.prize, by: '', ref: purchase.id, opId: (p.opId || purchase.id) + '-win' };
    appendObj_(TABS.points, out.wheelPoints);
  } else if (w.kind === 'item') {
    out.wheelPurchase = { id: 'W' + purchase.time, time: purchase.time, player: p.player, playerId: p.playerId, item: String(w.prize), cost: 0 };
    appendObj_(TABS.purchases, out.wheelPurchase);
  }
  return out;
}

function findRow_(spec, field, value) {
  var sh = sheet_(spec);
  var map = columns_(sh, spec, true);
  if (!map[field] || sh.getLastRow() < 2) return null;
  var kind = spec.cols.filter(function (c) { return c[0] === field; })[0][2];
  var vals = sh.getRange(2, map[field], sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    var v = kind === 'day' ? isoDay_(vals[i][0]) : String(vals[i][0]).replace(/^'/, '').trim();
    if (v === String(value)) return { sh: sh, map: map, row: i + 2 };
  }
  return null;
}

function setFields_(found, spec, fields) {
  spec.cols.forEach(function (c) {
    if (!(c[0] in fields) || !found.map[c[0]]) return;
    var cell = found.sh.getRange(found.row, found.map[c[0]]);
    if (c[2] === 'id') cell.setNumberFormat('@');
    if (c[2] === 'date') cell.setNumberFormat('dd/mm/yyyy hh:mm');
    cell.setValue(cellValue_(c[2], fields[c[0]]));
  });
}

function bountyPosted_(p) {
  var found = findRow_(TABS.bounties, 'weekOf', p.weekOf);
  if (!found) return { ok: false, error: 'no Bounties row for week ' + p.weekOf };
  var fields = { postedAt: p.postedAt, messageId: p.messageId };
  // Never overwrite a code word an admin typed in.
  if (p.codeWord && found.map.codeWord &&
      String(found.sh.getRange(found.row, found.map.codeWord).getValue()).trim() === '') {
    fields.codeWord = p.codeWord;
  }
  setFields_(found, TABS.bounties, fields);
  return { ok: true };
}

function updatePurchase_(id, fields) {
  var found = findRow_(TABS.purchases, 'id', id);
  if (!found) return { ok: false, error: 'no purchase ' + id };
  setFields_(found, TABS.purchases, fields);
  return { ok: true };
}

function setSetting_(key, value) {
  var found = findRow_(TABS.settings, 'key', key);
  if (found) {
    found.sh.getRange(found.row, found.map.value).setNumberFormat('@').setValue(String(value));
  } else {
    appendObj_(TABS.settings, { key: key, value: String(value), meaning: 'Managed by the bot' });
  }
  return { ok: true };
}

function writePlayers_(rows) {
  var spec = TABS.players;
  var sh = sheet_(spec);
  var map = columns_(sh, spec, true);
  var width = sh.getLastColumn();
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, width).clearContent();
  if (!rows.length) return { ok: true };
  if (map.playerId) sh.getRange(2, map.playerId, rows.length, 1).setNumberFormat('@');
  var out = rows.map(function (r) {
    var arr = [];
    for (var i = 0; i < width; i++) arr.push('');
    spec.cols.forEach(function (c) { if (map[c[0]]) arr[map[c[0]] - 1] = cellValue_(c[2], r[c[0]]); });
    return arr;
  });
  sh.getRange(2, 1, out.length, width).setValues(out);
  return { ok: true };
}

// ===========================================================================
// Setup (run once by hand; safe to run again)
// ===========================================================================

function setupBountyHunter() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Etc/UTC');

  makeDrops_(ss);
  makeWheel_(ss);
  addWheelSettings_();
  // Bot tabs: create if missing (with their full column set).
  ['submissions', 'points', 'purchases', 'players'].forEach(function (k) {
    var spec = TABS[k];
    var existed = !!ss.getSheetByName(spec.name);
    var sh = sheet_(spec);
    columns_(sh, spec, true); // adds any new bot columns (Item, Message ID, Ref, Op ID…)
    if (!existed) {
      sh.protect().setDescription('Written by the bot — do not edit by hand').setWarningOnly(true);
      sh.setTabColor('#9AA2B3');
    }
  });

  var b = ss.getSheetByName('Bounties');
  if (b) {
    // Adds the Code Word column (and any other new one) if it is missing.
    var bmap = columns_(b, TABS.bounties, true);
    if (bmap.codeWord) {
      b.getRange(1, bmap.codeWord).setBackground(ADMIN_COLOR)
        .setNote(TABS.bounties.cols.filter(function (c) { return c[0] === 'codeWord'; })[0][3]);
    }
    var heads = b.getRange(1, 1, 1, b.getLastColumn()).getValues()[0];
    heads.forEach(function (h, i) {
      if (/^part\s*\d+$/i.test(String(h).trim())) {
        b.getRange(1, i + 1).setNote(
          'What counts for this part. Separate with commas.\n' +
          '• A boss name from the Drops tab = any drop from that boss (e.g. Kerapac)\n' +
          '• An item name = that item\n' +
          '• Start with "2 of:" to need 2 DIFFERENT items, e.g. "2 of: Kerapac, Nex" (any mix)\n' +
          'No number = 1. Leave empty if not needed.');
      }
    });
  }

  var readMe = ss.getSheetByName('Read Me');
  if (readMe && readMe.getRange(13, 1).getValue() === '') {
    readMe.getRange(13, 1).setValue('Drops tab = every unique per boss. In Bounties, a boss name in a Part cell means "any drop from that boss". "2 of: Kerapac, Nex" = any 2 different items from either boss.');
  }

  SpreadsheetApp.getUi().alert('Bounty Hunter sheet updated. Next: Deploy → New deployment → Web app.');
}

function header_(sh, cols, color) {
  var r = sh.getRange(1, 1, 1, cols.length);
  r.setValues([cols.map(function (c) { return c[0]; })]).setBackground(color).setFontWeight('bold').setFontColor(HEAD_FONT);
  r.setNotes([cols.map(function (c) { return c[1] || ''; })]);
  sh.setFrozenRows(1);
  for (var i = 1; i <= cols.length; i++) sh.setColumnWidth(i, 150);
}

function makeWheel_(ss) {
  if (ss.getSheetByName('Wheel')) return;
  var sh = ss.insertSheet('Wheel');
  header_(sh, TABS.wheel.cols.map(function (c) { return [c[1], c[3]]; }), ADMIN_COLOR);
  // Placeholder prizes — weights add up to 100, so they read as percentages.
  var rows = [
    ['+5 pts', 40, 'points', 5, true, ''],
    ['Nothing', 25, 'nothing', '', true, ''],
    ['+20 pts', 15, 'points', 20, true, ''],
    ['5m GP', 15, 'item', '', true, 'Paid in game by an admin'],
    ['Custom Discord role (30 days)', 4, 'item', '', true, 'Your own colour and name'],
    ['JACKPOT: Bond', 1, 'item', '', true, '']
  ];
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  sh.setColumnWidth(1, 260);
  sh.setColumnWidth(6, 260);
  sh.getRange(1, 8).setValue('DRAFT — example prizes, change freely').setFontColor('#B4531A').setFontWeight('bold');
  sh.setTabColor('#F1C232');
}

function addWheelSettings_() {
  if (!findRow_(TABS.settings, 'key', 'Wheel_Channel_ID')) {
    appendObj_(TABS.settings, { key: 'Wheel_Channel_ID', value: '',
      meaning: 'Prize wheel: channel or thread id where bought spins are shown. Empty = the submissions channel' });
  }
  // The shop item that spins the wheel: Delivered How = "wheel". Added switched OFF.
  var shop = readTab_(TABS.shop);
  var has = shop.some(function (r) { return /^wheel$/i.test(String(r.deliveredHow || '').trim()); });
  if (!has) {
    appendObj_(TABS.shop, { item: 'Prize wheel spin', cost: 10, stock: '', active: false,
      description: 'Spin the wheel for a random prize', deliveredHow: 'wheel' });
  }
}

function makeDrops_(ss) {
  if (ss.getSheetByName('Drops')) return;
  var sh = ss.insertSheet('Drops');
  header_(sh, [
    ['Boss', 'Boss name. Use this name in a Bounties Part cell to mean "any drop from this boss".'],
    ['Item', 'Exact in-game item name (players type this when they post). One item per row.']
  ], ADMIN_COLOR);
  var list = {
    'Araxxor': ['Spider leg top', 'Spider leg middle', 'Spider leg bottom', "Araxxi's fang", "Araxxi's eye", "Araxxi's web"],
    'Vorago': ['Seismic wand', 'Seismic singularity', 'Tectonic energy'],
    'Raksha': ['Shadow spike', 'Greater Ricochet ability codex', 'Greater Chain ability codex', 'Divert ability codex'],
    'Telos': ['Dormant Zaros godsword', 'Dormant Seren godbow', 'Dormant staff of Sliske'],
    'Kerapac': ["Kerapac's wrist wraps", 'Greater Concentrated Blast ability codex', 'Fractured Armadyl symbol', 'Fractured stabilisation gem', "Staff of Armadyl's fractured shaft"],
    'Nex': ['Torva full helm', 'Torva platebody', 'Torva platelegs', 'Pernix cowl', 'Pernix body', 'Pernix chaps', 'Virtus mask', 'Virtus robe top', 'Virtus robe legs', 'Zaryte bow']
  };
  var rows = [];
  Object.keys(list).forEach(function (boss) { list[boss].forEach(function (it) { rows.push([boss, it]); }); });
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
  sh.setColumnWidth(2, 320);
  sh.getRange(1, 3).setValue('DRAFT — please check every item name against the game').setFontColor('#B4531A').setFontWeight('bold');
  sh.setTabColor('#F1C232');
}
