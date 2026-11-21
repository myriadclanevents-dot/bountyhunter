/**
 * Copies Tier + Suggested First/Later from the Difficulty tab into the
 * Bounties tab (First Points, Later Points and a "Tier" column, added on the
 * right if missing). Rows are matched by boss name (spaces, hyphens and
 * capitals ignored). Run it again whenever you change the Difficulty tab.
 * Writes plain numbers, so the bot reads them exactly as if typed by hand.
 */
function applyDifficultyToBounties() {
  var ss = SpreadsheetApp.getActive();
  var ui = SpreadsheetApp.getUi();
  var d = ss.getSheetByName('Difficulty'), b = ss.getSheetByName('Bounties');
  if (!d || !b) { ui.alert('Needs both a "Difficulty" and a "Bounties" tab.'); return; }
  var key = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };

  // Difficulty: boss -> {tier, first, later}
  var dv = d.getRange(2, 1, Math.max(d.getLastRow() - 1, 1), 11).getValues();
  var byBoss = {}, dupes = [];
  dv.forEach(function (r) {
    var k = key(r[0]);
    if (!k) return;
    if (byBoss[k]) { dupes.push(r[0]); return; }
    byBoss[k] = { tier: r[8], first: r[9], later: r[10] };
  });

  // Bounties: find columns by header name; add "Tier" if missing.
  var lastCol = b.getLastColumn();
  var heads = b.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var cBoss = heads.indexOf('boss') + 1, cFirst = heads.indexOf('first points') + 1, cLater = heads.indexOf('later points') + 1;
  var cTier = heads.indexOf('tier') + 1;
  if (!cBoss || !cFirst || !cLater) { ui.alert('Bounties tab needs Boss, First Points and Later Points columns.'); return; }
  if (!cTier) {
    cTier = lastCol + 1;
    b.getRange(1, cTier).setValue('Tier').setFontWeight('bold')
      .setNote('Copied from the Difficulty tab by applyDifficultyToBounties(). The bot ignores it.');
  }

  var n = b.getLastRow() - 1;
  if (n < 1) { ui.alert('No bounties found.'); return; }
  var bosses = b.getRange(2, cBoss, n, 1).getValues();
  var first = b.getRange(2, cFirst, n, 1).getValues();
  var later = b.getRange(2, cLater, n, 1).getValues();
  var tiers = b.getRange(2, cTier, n, 1).getValues();
  var changed = [], missing = [];
  for (var i = 0; i < n; i++) {
    var name = bosses[i][0];
    if (!key(name)) continue;
    var m = byBoss[key(name)];
    if (!m || m.tier === '' || m.first === '') { missing.push(String(name).trim()); continue; }
    if (String(first[i][0]) !== String(m.first) || String(later[i][0]) !== String(m.later)) {
      changed.push(String(name).trim() + ': ' + first[i][0] + '/' + later[i][0] + ' -> ' + m.first + '/' + m.later + ' (' + m.tier + ')');
    }
    first[i][0] = m.first; later[i][0] = m.later; tiers[i][0] = m.tier;
  }
  b.getRange(2, cFirst, n, 1).setValues(first);
  b.getRange(2, cLater, n, 1).setValues(later);
  b.getRange(2, cTier, n, 1).setValues(tiers);

  var msg = changed.length ? 'Points changed:\n' + changed.join('\n') : 'No point changes needed.';
  if (missing.length) msg += '\n\nNot in the Difficulty tab (left as they were):\n' + missing.join('\n');
  if (dupes.length) msg += '\n\nBoss listed twice in Difficulty (first row used):\n' + dupes.join('\n');
  ui.alert(msg);
}

/**
 * One-off helper: creates the "Difficulty" tab (the bot never reads it).
 * Run setupDifficultyTab() once from the Apps Script editor.
 * It refuses to run if a "Difficulty" tab already exists, so it can never
 * overwrite your edits. To start over, delete the tab first.
 */
function setupDifficultyTab() {
  var ss = SpreadsheetApp.getActive();
  if (ss.getSheetByName('Difficulty')) {
    SpreadsheetApp.getUi().alert('A "Difficulty" tab already exists. Nothing was changed.');
    return;
  }
  var sh = ss.insertSheet('Difficulty');

  var header = ['Boss', 'Needs', 'Mode / enrage / team', 'Chance per kill',
    'Avg kills needed', 'Kills per hour', 'Hours to finish', 'Boss difficulty',
    'Tier', 'Suggested First', 'Suggested Later', 'Notes / source', 'Checked by / date'];

  // Boss, Needs, Mode, Chance (text), Avg kills, Kills/hr, Difficulty, Notes
  var W = 'runescape.wiki/w/';
  var rows = [
    ['Araxxor', '1 leg piece AND 1 Araxxi piece', 'Solo', 'Leg 1/40 + Araxxi piece 1/120', 130, 14, 'Mid', 'Both parts needed. Leg read as 1/40 for any leg (piece depends on path). ' + W + 'Araxxi'],
    ['Vorago', 'Seismic wand or Seismic singularity', 'Normal, trio', '1/120 per player', 120, 7, 'High', '1/40 per kill for the whole team, 1 seismic max per kill. Solo 1/40 at 4/hr. Hard mode 1/20. ' + W + 'Vorago'],
    ['Raksha', 'Any of 4 uniques', 'Solo', '1/81', 81, 20, 'High', 'Each unique 1/325 per kill. ' + W + 'Raksha,_the_Shadow_Colossus'],
    ['Telos', 'Any dormant weapon', '100% enrage', '1/1,100', 1100, 10, 'Very high', 'Kills/hr is OUR GUESS. 1000% enrage is about 1/147. Name an enrage in the bounty. ' + W + 'Telos,_the_Warden'],
    ['Kerapac', 'Wrist wraps or Greater Conc. Blast codex', 'Normal, solo', '1/127', 127, 25, 'Mid', '3 drop piles x 1/760 per item. Hard mode about 1/90 at 10/hr. ' + W + 'Kerapac,_the_bound'],
    ['Nakatra', "Roar, Ode or Nakatra's mosaic", 'Normal, full Sanctum run', '1/30', 30, 6, 'High', 'Roar 1/150, Ode 1/150, mosaic 1/50. Without mosaic 1/75. Kills/hr = whole runs. ' + W + 'Nakatra,_Devourer_Eternal'],
    ['Queen Black Dragon', 'Complete royal crossbow (4 pieces)', 'Solo', 'Each piece 1/51', 26, 28, 'Low', 'All 4 pieces about 26 kills, then Thurgo + forging (70 Smithing). ' + W + 'Queen_Black_Dragon'],
    ['Ghrazi Bloodknights', 'Invoke Arisen Flesh codex', '1000% enrage', '1/175', 175, 6, 'Very high', 'Kills/hr is OUR GUESS. Normal mode 1/3,000, 100% 1/750, 2000% 1/125. ' + W + 'The_Ghrazi_Blood_Knights'],
    ['Zamorak', 'Chaos Roar codex', '100% enrage', '1/284', 284, 12, 'Very high', 'Under 20% enrage about 1/606, 1000% about 1/113, 2000% about 1/78. ' + W + 'Zamorak,_Lord_of_Chaos'],
    ['Ambassador', 'Any eldritch crossbow piece', 'Solo', '1/55', 55, 4, 'High', 'Kills/hr is OUR GUESS. Duo 1/111, trio 1/166. ' + W + 'The_Ambassador'],
    ['Ivar', 'Magic skull mask AND Bonecrusher maul', 'Any', '1/64 each', 96, 20, 'Low', 'Kills/hr is OUR GUESS. Both items needed (Drop Log estimate). ' + W + 'Ivar,_King_of_Bones'],
    ['Vorkath', 'Invoke Lord of Bones codex', 'Normal', 'not published', '', 28, 'Mid', 'Wiki lists the codex as "Varies". Fill in Avg kills if you know it. ' + W + 'Zemouregal_%26_Vorkath'],
    ['Arch Glacor', 'Frozen core, Scripture of Wen or Leng artefact', 'Normal, 5 mechanics', '1/83', 83, 15, 'Mid', 'Kills/hr is OUR GUESS. Leng artefact + Scripture 3 x 1/500 each. Frozen core is hard mode only. ' + W + 'Arch-Glacor'],
    ['Gate of Elidinis', 'Memory dowser or Runic attuner', 'Any', '1/240', 240, 20, 'Low', 'Each 1/480 (Drop Log estimate). ' + W + 'Gate_of_Elidinis'],
    ['Profane Scarabite', 'Spectral lens', 'On Slayer task', '1/512', 512, 60, 'Mid', 'Kills/hr is OUR GUESS. Off task 1/4,096. Slayer monster (87 Slayer). ' + W + 'Profane_Scabarite'],
    ['Legiones', 'Ascension grips', 'On Slayer task', '1/2,056', 2056, 20, 'High', 'Kills/hr is OUR GUESS. Only drops on a Slayer task; consider "any Ascension signet". ' + W + 'Ascension_grips'],
    ['Zuk', 'Scripture of Ful or Magma Tempest codex', 'Normal', '1/50', 50, 5, 'High', 'Each 1/100 normal, 1/50 hard mode (3/hr). ' + W + 'TzKal-Zuk'],
    ['Nex', '1 Torva + 1 Pernix + 1 Virtus piece', 'Solo', 'Any piece 1/21', 129, 25, 'High', 'Each piece 1/384. One of each set about 129 kills. ' + W + 'Nex'],
    ['Croesus', 'Any of 9 uniques', '4-man, 420+ contribution', '1/50', 50, 9, 'Low', 'Public mass (180-229 contribution): 1/200 at about 16/hr. ' + W + 'Croesus'],
    ['ED2', 'Any of 3 greater codices', 'Solo', '1/28 per run', 28, 4, 'High', 'Each codex 1/83 solo from its own boss. Duo 1/166, trio 1/250. ' + W + 'Dragonkin_Laboratory'],
  ];

  sh.getRange(1, 1, 1, header.length).setValues([header]);
  var n = rows.length;
  sh.getRange(2, 1, n, 6).setValues(rows.map(function (r) { return r.slice(0, 6); }));
  sh.getRange(2, 8, n, 1).setValues(rows.map(function (r) { return [r[6]]; }));
  sh.getRange(2, 12, n, 1).setValues(rows.map(function (r) { return [r[7]]; }));

  // Points per tier (change these and every suggestion updates).
  sh.getRange('O1:Q5').setValues([
    ['Tier', 'First', 'Later'],
    ['Easy', 8, 3],
    ['Medium', 20, 8],
    ['Hard', 45, 18],
    ['Elite', 100, 40],
  ]);
  sh.getRange('O7:O11').setValues([
    ['How the tier is worked out:'],
    ['Hours to finish = Avg kills needed / Kills per hour'],
    ['Easy: 2 h or less. Medium: 2-6 h. Hard: 6-15 h. Elite: over 15 h.'],
    ['A High or Very high boss moves it one tier up.'],
    ['Use kills per hour for OUR players, not the wiki experts.'],
  ]);

  // Formulas (Apps Script always takes commas, whatever the sheet's language).
  var f = [];
  for (var i = 2; i <= n + 1; i++) {
    var tier = 'IF(G' + i + '="","",CHOOSE(MIN(4,IF(G' + i + '<=2,1,IF(G' + i + '<=6,2,IF(G' + i + '<=15,3,4)))' +
      '+IF(OR(H' + i + '="High",H' + i + '="Very high"),1,0)),"Easy","Medium","Hard","Elite"))';
    f.push([
      '=IF(AND(N(E' + i + ')>0,N(F' + i + ')>0),ROUND(E' + i + '/F' + i + ',1),"")',
      null, // H: dropdown value, not a formula
      '=' + tier,
      '=IF(I' + i + '="","",VLOOKUP(I' + i + ',$O$2:$Q$5,2,FALSE))',
      '=IF(I' + i + '="","",VLOOKUP(I' + i + ',$O$2:$Q$5,3,FALSE))',
    ]);
  }
  sh.getRange(2, 7, n, 1).setFormulas(f.map(function (r) { return [r[0]]; }));
  sh.getRange(2, 9, n, 3).setFormulas(f.map(function (r) { return [r[2], r[3], r[4]]; }));

  // Dropdown for boss difficulty, for these rows and room for 30 more.
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Low', 'Mid', 'High', 'Very high'], true)
    .setAllowInvalid(false).build();
  sh.getRange(2, 8, n + 30, 1).setDataValidation(rule);
  // Copy the formulas down 30 spare rows so new bounties work too.
  sh.getRange(2, 7, 1, 1).copyTo(sh.getRange(n + 2, 7, 30, 1));
  sh.getRange(2, 9, 1, 3).copyTo(sh.getRange(n + 2, 9, 30, 3));

  // Looks: bold header, frozen, columns sized, tier coloured.
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#1d2c4a').setFontColor('#ffffff');
  sh.getRange('O1:Q1').setFontWeight('bold').setBackground('#1d2c4a').setFontColor('#ffffff');
  sh.getRange('O7').setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.getRange(2, 7, n + 30, 1).setBackground('#f3f4f6');
  sh.getRange(2, 9, n + 30, 3).setBackground('#f3f4f6');
  var widths = [150, 260, 170, 170, 110, 100, 110, 120, 80, 110, 110, 420, 140];
  widths.forEach(function (w, k) { sh.setColumnWidth(k + 1, w); });
  var tierRange = sh.getRange(2, 9, n + 30, 1);
  var colours = [['Easy', '#e3f3e7', '#1f7a3a'], ['Medium', '#e4eefb', '#1c5cab'], ['Hard', '#fbefd9', '#9a5b00'], ['Elite', '#fbe4e1', '#b3261e']];
  sh.setConditionalFormatRules(colours.map(function (c) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(c[0])
      .setBackground(c[1]).setFontColor(c[2]).setBold(true).setRanges([tierRange]).build();
  }));

  SpreadsheetApp.getUi().alert('Difficulty tab created with ' + n + ' bounties. Grey columns are formulas; edit the white ones.');
}
