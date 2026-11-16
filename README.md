# Bounty Hunter bot (first draft)

Always-on clan activity for Myriad: a new boss bounty every Monday, players post
drops, admins approve with a reaction, points go to a wallet (spendable in a shop)
and to "earned" (leaderboards). Runs as **Myriad Events Bot** next to whichever
event bot (bingo / drop race) is live.

## How it works

| Where | What happens |
|---|---|
| **Bounties** tab | One row per Monday. Each `Part` cell = one requirement. |
| Monday, random hour (UTC) | Bot posts the bounty in `Board_Channel_ID` and pins it. The previous one closes (or stays open `Late_Claim_Hours` longer). |
| `Submissions_Channel_ID` | Player posts a screenshot **with the item name in the message**. An approver reacts with `Approve_Emoji` (✅). Bot reacts 🎯 and replies with progress. |
| All parts done | Claim: first player gets `First Points`, later players `Later Points` (one claim per player). |
| 72 h with no claim | First claim × `Multiplier` (judged by when the finishing screenshot was **posted**). |
| `Awards_Channel_ID` | Claim announcements, multiplier alerts, monthly top 3 on the 1st. |
| `/bhbuy` | Player buys; the sheet checks wallet + stock; admins get a ping in `Shop_Admin_Channel_ID` and react ✅ when delivered. |
| Prize wheel | A Shop item with **Delivered How = `wheel`**. Buying it picks a prize (weights in the **Wheel** tab) and spins it in `Wheel_Channel_ID` (empty = the submissions channel): one message edited ~10 times over ~14 s. Points prizes go straight to the wallet; item prizes ping the admin channel like a purchase. |

### Part cells
- `Kerapac` → any drop of that boss (boss names come from the **Drops** tab)
- `Spider leg top, Araxxi's eye` → any one of these
- `2 of: Kerapac, Nex` → any 2 **different** items, mixed from both bosses

### Commands (all start with `bh`)
Players: `/bhbounty` `/bhme` `/bhtop` `/bhshop` `/bhbuy` `/bhpast`
Admins (Approvers tab or Manage Server): `/bhvoid` `/bhgive` `/bhpost` `/bhreload`

### Points
Everything is logged in the **Points** tab, one line per change. Wallet = sum of
all lines. Earned = all lines except shop purchases and wheel winnings (type `wheel`). Leaderboards use Earned.
Fix mistakes with `/bhvoid` (undo an approval) and `/bhgive` (± points) — never
by editing the grey tabs.

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
