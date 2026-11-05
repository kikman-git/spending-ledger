# spending-ledger

Analytics and manual-entry web UI for one person's spending ledger. A Telegram bot
(`@leggeri_phat_bot` → OpenClaw `ledger` agent → `~/.openclaw/data/ledger.sqlite`) captures receipts and text
spends; this Next.js app reads the same SQLite file and adds manual income/expense entries and recurring rules.
It is a private, single-owner tool for one VPS: no accounts and no auth of its own. On the box the checkout is
still `/home/ubuntu/ledger-web` (npm package `ledger-web`, systemd unit `ledger-web.service`).

## How it works

```text
Telegram bot @leggeri_phat_bot ─ OpenClaw agent `ledger` (🧾 Pacioli)
   │  skill `ledger-add` → add_expense.py     the only bot write path; it also owns the schema
   ▼
~/.openclaw/data/ledger.sqlite     tables: expenses, line_items, recurring (the last is created by this app)
~/.openclaw/data/receipts/         archived receipt images
   ▲  node:sqlite (reads are read-only; writes come only from the web form and recurring rules)
this app ─ Next.js 15 on 127.0.0.1:18790 ─ `tailscale serve` :8443 ─ tailnet devices only
```

Implements the **"Expense Tracker"** Claude Design project (`Expense Tracker.dc.html`) faithfully: Income /
Expenses / Net-saved cards, category donut, add/edit/delete transaction form (Expense ⇄ Income), and date-grouped
transactions — plus data-model extras the prototype didn't have: **Top items** (from `line_items`, net of
per-item discounts), by-merchant totals, and expandable receipt rows showing line items, discounts, the items-net
vs paid-total tax gap, and the archived receipt image.

**Views:** Dashboard (cards, donut, top items, recent) · Categories · Transactions (form, full list, recurring
rules). All three are scoped to the month in the header pager.

**Categories** is the drill-down: one expandable card per category for the month, with two modes:

- *Entries* — every entry in the category (newest first), each with its receipt line items nested underneath and
  a link to the receipt image. Read-only; editing stays in Transactions.
- *Items* — every line item in the category rolled up by name, uncapped (unlike the dashboard's top-12), with an
  items-net footer that also states how much of the category came from entries with no itemised receipt.

It is derived client-side from the `/api/month` payload — no extra request — and uses the same counting rule as
the aggregates (JPY, dated on/before today), so a category's headline number is the donut's number. Entries that
are *not* counted (upcoming, or a non-JPY amount) are still listed, with their exclusion named in the category's
meta line. Income categories get their own section, since `byCategory` is expenses-only.

**Write paths**

- Receipts/text spends: Telegram bot (unchanged; writes `source='receipt'|'text'`).
- Manual entries: this app's form → `POST/PATCH/DELETE /api/tx` (`source='manual'`, `kind='expense'|'income'`).
  Validation fails closed (kind/category whitelists, integer yen, real dates). Editing a bot-captured row updates
  only kind/amount/category/date/note — merchant, payment, line items, and the receipt image are preserved.
  Deleting cascades to `line_items`.
- Recurring rules (rent, bills, subscriptions, salary): the Recurring card in the Transactions view → `recurring`
  table (created by the first writable open). Each month's entries are written into `expenses`
  (`source='recurring'`, `merchant`=rule name) up front — future-dated — by `GET /api/month` the first time the
  app loads in that month; months missed while the app was closed catch up on the next visit. `last_run`
  (YYYY-MM) is a forward-only watermark: deleting a generated entry never resurrects it, rule edits apply to
  future months only, and months skipped while paused are not backfilled — resume restarts at the current month.
  Day 29–31 clamps to the last day of shorter months. Deleting a rule keeps the entries it wrote; generated rows
  are ordinary transactions (editable/deletable, merchant preserved on edit).
- Upcoming entries: anything dated after today (JST) — written ahead by a rule, or entered manually with a future
  date (allowed up to 24 months out) — is counted in `totals.upcomingSpent`/`upcomingIncome` instead of
  spent/income, and excluded from the category/merchant/item breakdowns until its day arrives (no flag column;
  purely date-based). The dashboard grows an "Upcoming" card when something is scheduled, and rows show an
  "upcoming" chip. Variable bills (e.g. mobile) are written at the rule's usual amount and the entry is edited
  once the actual amount is known.
- `expenses.kind` (default `'expense'`) was added 2026-07-17; the bot's writer migrates/creates it too and is otherwise unaffected.

## Setup

Requirements: Node 24 (built-in `node:sqlite`, so no native modules; the box runs v24.18, there is no `engines`
field and other majors were not tried), npm, and a ledger SQLite file. This repo does not create the
`expenses`/`line_items` tables (the `ledger-add` skill does; columns under Data), so seed a scratch file with its writer.

```bash
npm ci                 # lockfile is in sync with package.json; everything resolves from registry.npmjs.org
npm run build          # required before `npm start`
# development: separate clone + scratch DB (see Gotchas), seeded with ledger-add's `add_expense.py --db <file> ...`
LEDGER_DB=/tmp/ledger-scratch.sqlite npx next dev -H 127.0.0.1 -p 3100
```

Stack: Next.js 15 (App Router, TypeScript), React 19, Tailwind CSS v4 (design tokens in `app/globals.css`; base
styles live in `@layer base` so utilities can override). SQLite via Node's built-in `node:sqlite` — no native
deps. Reads are opened read-only; a writable connection (with `PRAGMA foreign_keys=ON`) is used only by the
mutations (`/api/tx`, `/api/recurring`) and by the recurring-due check that `GET /api/month` runs first.

## Run / deploy

| | |
|---|---|
| systemd user unit | `ledger-web.service` in `~/.config/systemd/user/` (not in this repo; enabled, linger is on): `NODE_ENV=production`, `ExecStart=/usr/bin/npm start`, `Restart=always`, `RestartSec=3` |
| Listens / exposed | `127.0.0.1:18790` (loopback only), published by `tailscale serve --bg --https=8443 http://127.0.0.1:18790` |
| Tailnet URL | **https://openclaw-vps.tail0d53dc.ts.net:8443/** (tailnet only; the OpenClaw dashboard stays on :443) |

```bash
npm run deploy   # next build → restart service → health-check /api/month → prints the URL (use after code changes)
# individual steps: `npm run build`, `systemctl --user restart ledger-web.service` (the service serves .next)
```

- `next start` needs `next build` first: with no `.next` build the service fails and systemd restarts it every 3 s.
- Gateway restarts wipe Tailscale serve mappings (`tailscale.resetOnExit: true`); the `tailscale-serve-apps.timer`
  user unit re-asserts them within 3 minutes (`systemctl --user start tailscale-serve-apps.service` to force it).
- Use the full tailnet name: MagicDNS resolves `openclaw-vps`, but the TLS certificate only covers the full name.

## Configuration

| Name | Where | Purpose |
|---|---|---|
| `LEDGER_DB` | env var, optional (template: `.env.example`) | SQLite path; default `~/.openclaw/data/ledger.sqlite` |
| port / bind | `package.json` scripts | `dev` and `start` pass `-p 18790`; only `start` passes `-H 127.0.0.1` |
| receipts dir | `RECEIPTS_DIR` in `lib/ledger.ts` | fixed at `~/.openclaw/data/receipts`; not configurable |

The app reads no secrets: no API keys, tokens or passwords. The Telegram bot token belongs to OpenClaw (a token
file under `~/.openclaw/secrets/`, referenced from `~/.openclaw/openclaw.json`) and never touches this repo.

## Data

| What | Where | In git? |
|---|---|---|
| Ledger database | `~/.openclaw/data/ledger.sqlite` | No: personal financial records (`*.sqlite*` is git-ignored) |
| Receipt images | `~/.openclaw/data/receipts/` | No: photos of receipts, served only through `/api/receipt/<id>` |
| Nightly backup | `~/backups/openclaw-data/<date>/` | No: cron `~/bin/openclaw-data-backup.sh`, 03:30 JST, newest 14 kept; also covers `people.sqlite` |

- Schema owner is the `ledger-add` skill: `add_expense.py` creates `expenses` and `line_items` and runs migrations.
  This app only adds `expenses.kind` if missing and creates `recurring`, both on its first writable open.
- Columns used here: `expenses(id, recorded_at, purchased_on, merchant, amount, currency, category, payment,
  source, kind, note, image_path)` and `line_items(expense_id → expenses ON DELETE CASCADE, name, qty, unit_price,
  price, discount)`. The skill also stores `items_json` and `raw_json` for audit; this app ignores them.
- `expenses.amount` is an integer in the smallest currency unit (whole yen for JPY); `purchased_on` is `YYYY-MM-DD`.

## API

| Route | Methods | Notes |
|---|---|---|
| `/api/month?m=YYYY-MM` | GET | totals (income/spent/net/savings rate/MoM/upcomingSpent/upcomingIncome), byCategory, topItems, byMerchant, transactions w/ items. JPY-only sums; months clamped to [first data, max(current JST month, latest entry)]. Writes any due recurring entries first |
| `/api/tx` | POST | manual entry `{kind, amount, category, date, note?}` → 201 `{ok, id}` |
| `/api/tx/<id>` | PATCH, DELETE | edit (same body) / delete a transaction, see Write paths |
| `/api/recurring` | GET, POST | list rules / create one `{name, kind, amount, category, day, startMonth, endMonth?}` |
| `/api/recurring/<id>` | PATCH, DELETE | rewrite, or pause/resume with `{active}` alone / delete. POST/PATCH return `generated`, the number of entries written as a result |
| `/api/receipt/<expense id>` | GET | archived image; only files inside `~/.openclaw/data/receipts/` are ever served |

No authentication on any route: access control is the loopback bind plus Tailscale. Validation: amount is a
positive whole number of yen (max 99,999,999); expense categories are `groceries`, `dining`, `education`, `online`,
`transport`, `household`, `health`, `entertainment`, `bills`, `other`; income categories are `salary`, `freelance`,
`investments`; dates are real `YYYY-MM-DD` values from 2020-01-01 to 24 months ahead.

## Related

Outside this repo:

- OpenClaw skill `ledger-add` (`~/.openclaw/skills/ledger-add/`: `SKILL.md`, `add_expense.py`): the bot's only write
  path and the owner of the schema.
- OpenClaw agent `ledger` (🧾 Pacioli, workspace `~/.openclaw/workspace-ledger`), reached through Telegram account
  `default`; bot `@leggeri_phat_bot` (linked from `app/ui/format.ts`).
- `people-graph` (on the box: `/home/ubuntu/human-graph`, tailnet :8444) follows the same pattern and copies this
  app's design tokens from `app/globals.css`.
- Hub page https://openclaw-vps.tail0d53dc.ts.net/apps lists every app on the box with a live up/down dot.

## Gotchas

- Aggregates sum JPY only; a non-JPY expense is listed with its currency code, never mixed into ¥ totals.
- `expenses.amount` (what was paid) is authoritative; per-item prices are as-printed (tax basis varies by store:
  内税 vs 外税), so expanded rows show "items net" plus a "+¥n tax / rounding" gap line instead of pretending they tie.
- A GET can write: `GET /api/month` first writes due recurring entries (the deploy health check calls it too). The
  comment inside `ledger-web.service` ("Reads … READ-ONLY; the Telegram bot remains the only write path") predates
  the manual-entry form and is stale.
- Deleting an entry never deletes its archived receipt file from `receipts/`.
- Do not run `npm run dev` in the live checkout: it uses the service's port (18790), passes no `-H` (Next binds
  0.0.0.0 by default) and writes into the same `.next/` the service serves.
- `LEDGER_DB` moves only the database: receipts are still served from `~/.openclaw/data/receipts/` alone.
- "Today" is computed at a fixed UTC+9 (JST has no DST); ledger dates are Japan-local.
- Fonts (Hanken Grotesk, Newsreader) load from Google Fonts in the browser (`app/layout.tsx`).
- `package.json` defines only `dev`, `build`, `start` and `deploy`: no tests and no linter.

## License

MIT. See [LICENSE](LICENSE).
