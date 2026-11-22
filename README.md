# Bounty Hunter bot (first draft)

Always-on clan activity for Myriad: a new boss bounty every Monday, players post
drops, admins approve with a reaction, points go to a wallet (spendable in a shop)
and to "earned" (leaderboards). Runs as **Myriad Events Bot** next to whichever
event bot (bingo / drop race) is live.

## How it works

| Where | What happens |
|---|---|
| **Bounties** tab | The **list** of bounties (one row each, same boss may appear twice with different tasks). Each `Part` cell = one requirement. `Week Of` is optional: empty = random order; a Monday date forces that bounty that week. |
| Monday, random hour (UTC) | Bot picks the week's bounty: a player's pick, else a forced `Week Of` row, else a **random** active row whose boss was not used in the last `Repeat_Cooldown_Weeks` weeks (default 8; if all are cooling down, the one used longest ago). It posts it in `Board_Channel_ID`, pins it, and writes the week into the **History** tab. The previous one closes (or stays open `Late_Claim_Hours` longer). |
| **History** tab (bot) | One row per week: a full copy of the bounty that went up, its code word, post time, and `Chosen By` for picks. A row with no `Posted At` = a pick waiting for Monday. |
| Pick next week's bounty | A Shop item with **Delivered How = `pick`**. The buyer chooses from `Pick_Options` (default 20) random eligible bounties, sees parts + points, confirms, then pays. 1 per week (the bot keeps that stock, the Stock cell is ignored). Public note pings the buyer but keeps the boss secret until Monday; the shop admin channel gets an info post (nothing to deliver). Undo = delete the History row + `/bhgive` the points back. |
| `Submissions_Channel_ID` | Player posts a screenshot **with the item name in the message**. An approver reacts with `Approve_Emoji` (✅). Bot reacts 🎯 and replies with progress. |
| All parts done | Claim: first player gets `First Points`, later players `Later Points` (one claim per player). |
| 72 h with no claim | First claim × `Multiplier` (judged by when the finishing screenshot was **posted**). |
| `Awards_Channel_ID` | Claim announcements, multiplier alerts, monthly top 3 on the 1st. |
| `/bhbuy` | Player buys; the sheet checks wallet + stock; admins get a ping in `Shop_Admin_Channel_ID` and react ✅ when delivered. |
| Prize wheel | A Shop item with **Delivered How = `wheel`**. Buying it picks a prize (weights in the **Wheel** tab) and spins it in `Wheel_Channel_ID` (empty = the submissions channel): one message edited ~10 times over ~14 s. Points prizes go straight to the wallet; item prizes ping the admin channel like a purchase. |
| Donate to clan | A Shop item with **Delivered How = `donate`**. **Cost = the minimum** (points). The player types an amount and a message; the points are removed, the message goes to `Shop_Admin_Channel_ID` and is saved in the Purchases tab. |
| Gift to a clannie | A Shop item with **Delivered How = `gift`**. **Cost = the minimum** (points). The player chooses a member, an amount and an optional public note. Limit per sender: `Gift_Weekly_Limit` points per week, Monday 00:00 UTC (optional Settings row, default 25, 0 = off). Posted in the submissions channel (no ping) and the admin log; the receiver gets a DM (if DMs are closed, the post pings them instead). Gifts can be spent but never count as earned. |
| Shop extras | Added by `setupBountyHunter` as Shop rows with **Active = FALSE**; set Active to switch each one on. Points from these never count as earned. |
| Clan goal | **Delivered How = `goal`**. Item = goal name, **Cost = donated points needed**. Not for sale: it shows a progress bar in `/bhshop`, and donations fill it from the moment it is switched on (`Clan_Goal_Base` in Settings is bot-managed). When reached it is announced and restarts. |
| Sponsor this bounty | **Delivered How = `sponsor`**. **Cost = minimum**, `Sponsor_Max` = maximum (default 50). Points go in the current bounty's pot until its first claim. First claimer wins it; refunded if the bounty closes unclaimed. |
| Bounty duel | **Delivered How = `duel`**. **Cost = minimum stake**, `Duel_Max_Stake` = maximum (default 25). The opponent has 24 hours to accept. First of the two to claim takes both stakes; otherwise both are refunded. One open duel per player. |
| Code word | **Delivered How = `codeword`**, fixed Cost. The buyer's word + 2 digits added at posting is used for the next Monday bounty. Stored in `Next_Code_Word`; admins can change or clear it. |
| Winner's emoji | **Delivered How = `emoji`**, fixed Cost. The bot adds it to the buyer's approved submissions for 30 days. |

### Part cells
- `Kerapac` → any drop of that boss (boss names come from the **Drops** tab)
- `Spider leg top, Araxxi's eye` → any one of these
- `2 of: Kerapac, Nex` → any 2 **different** items, mixed from both bosses

### Commands (all start with `bh`)
Players: `/bhbounty` `/bhme` `/bhtop` `/bhshop` `/bhbuy` `/bhpast` `/bhhelp`
Admins (Approvers tab or Manage Server): `/bhvoid` `/bhgive` `/bhpost` `/bhreload`

### Points
Everything is logged in the **Points** tab, one line per change. Wallet = sum of
all lines. Earned = all lines except shop purchases, wheel lines (type `wheel`), donations, gifts, sponsor pots and duels. Leaderboards use Earned.
Fix mistakes with `/bhvoid` (undo an approval) and `/bhgive` (± points) — never
by editing the grey tabs.

### Big GP prizes (prizes.js)
Both are paid **in game by an admin**: the bot announces the winner in the awards
channel, posts a "trade it, then react ✅" note in the shop admin channel, and
records the win as a **0-point Points row of type `gp prize`** (so it is never
paid twice). All Settings rows are optional; amounts are in **millions of GP**.

| Setting | Default | Meaning |
|---|---|---|
| `Grand_Bounty_Prize` | 150 | GP for the first finisher of a Grand Bounty. `0` = off. |
| `Grand_Bounty_Min_First_Points` | 100 | Used only when the Bounties tab has NO `Grand Bounty` column: a bounty is a Grand Bounty when its First Points are at least this. |
| `Grand_Bounty_Rollover` | 50 | Added to the next Grand Bounty when one closes with nobody finishing it. |
| `Grand_Bounty_Max` | 300 | The prize never grows past this. |
| `Monthly_Draw_Prize` | 100 | GP drawn on the 1st of the month. Every claim in the month = 1 ticket, any tier. `0` = off. |
| `Grand_Bounty_Since`, `Monthly_Draw_Since` | bot | Written on first start (ms). Older bounties/claims don't count. |

The pot is worked out from History + Points, nothing else is stored: it resets
to the base after a win (or any claim), and grows only once a Grand Bounty has
**closed** unclaimed. The draw runs together with the monthly top-3 post.

**Choosing Grand Bounties yourself:** add a `Grand Bounty` column to the Bounties
tab (or rerun `setupBountyHunter`, which adds it with tick boxes) and tick the
bounties you want. Once the column exists, ONLY ticked bounties are Grand Bounties,
whatever their points. The tick is copied into History when a bounty goes up, so
unticking later does not change a week that already ran. Delete the whole column to
go back to the First Points rule.
Voiding the winning claim does **not** undo the prize: delete its `gp prize`
row by hand if the GP should not be paid (the next first claim then wins it).

## Setup

1. **Sheet back end**: open the sheet → Extensions → Apps Script → replace the code
   with `gas/Code.gs` → Save → run `setupBountyHunter` (adds the Drops tab) →
   Deploy → New deployment → Web app, *Execute as: Me*, *Who has access: Anyone*
   → copy the `/exec` URL.
2. Put that URL in `.env` as `SHEET_URL` (local) or `fly secrets set SHEET_URL=…` (Fly).
3. The bot needs, in the bounty channels: View, Send Messages, Read History,
   Add Reactions, Manage Messages (to pin), Embed Links.
4. Local test: `npm install` then `npm start`. Tests: `npm test`.

### Sharing the Discord application with the event bots
This bot never bulk-overwrites commands; it only adds/updates `bh*` ones and
re-adds them every 5 minutes, because the bingo/drop-race bots wipe all
commands when they start. So `/bh` commands can vanish for up to 5 minutes
after an event bot restarts. Unlike the two event bots, this one is MEANT to run
at the same time as them.

### Updating the Apps Script later
Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy (same URL).

## Tidy channels

| Setting | Default | Meaning |
|---|---|---|
| `Cleanup_After_Days` | 7 | The bot deletes its own small messages (claim announcements, ×multiplier alerts, gift notes, duels, wheel spins, replies) after this many days. Pinned messages, bounty posts, Grand Bounty wins, monthly draws, monthly top 3 and clan goals stay. `0` = off. |
| `Bounty_Compact_After_Days` | 14 | Days after a bounty closes until its post shows the claimers on one line. `0` = never. |
| `Bounty_Delete_After_Days` | 30 | Days after a bounty closes until its post is deleted (`/bhpast` still shows it). `0` = never. |

A closed bounty post is always short: who claimed first, any Grand Bounty / sponsor
result, and "Claimed by (n)". The cleanup runs 2 minutes after start and then every
hour, looking at the newest 500 messages of the board, awards, submissions and wheel
channels. Players' own messages are never touched.

## Role pings

| Setting | Default | Meaning |
|---|---|---|
| `Bounty_Ping_Role_ID` | empty | Role pinged when a new bounty goes up (Grand Bounties say so in the ping). Empty = no pings at all. Right-click the role → Copy Role ID. |
| `Ping_On_Multiplier` | FALSE | TRUE = also ping the role when the ×multiplier switches on. |
| `Ping_On_First_Claim` | FALSE | TRUE = also ping the role when someone claims the bounty first. |

The ping is a line above the post. When a bounty closes, the bot removes that line
from its post (editing never pings again). The role must be mentionable, or the bot
needs "Mention @everyone, @here and All Roles" in the board/awards channel.
