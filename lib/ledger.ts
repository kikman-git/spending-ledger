import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LineItem, MonthData, Recurring, RecurringFields, Tx, TxFields } from "./types";

const DB_PATH =
  process.env.LEDGER_DB ?? path.join(os.homedir(), ".openclaw/data/ledger.sqlite");
const RECEIPTS_DIR = path.join(os.homedir(), ".openclaw/data/receipts");
const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Category ids accepted for writes (mirror app/ui/format.ts).
const EXPENSE_CATS = new Set([
  "groceries", "dining", "education", "online", "transport", "household",
  "health", "entertainment", "bills", "other",
]);
const INCOME_CATS = new Set(["salary", "freelance", "investments"]);

function open(readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(DB_PATH, { readOnly });
  if (!readOnly) {
    db.exec("PRAGMA foreign_keys = ON"); // line_items cascade on delete
    const cols = db.prepare("PRAGMA table_info(expenses)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "kind")) {
      db.exec("ALTER TABLE expenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense'");
    }
    db.exec(`CREATE TABLE IF NOT EXISTS recurring (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,             -- shown as the generated entry's merchant
      kind        TEXT NOT NULL DEFAULT 'expense',
      amount      INTEGER NOT NULL,          -- integer yen
      category    TEXT NOT NULL,
      day         INTEGER NOT NULL,          -- 1-31, clamped to month length
      start_month TEXT NOT NULL,             -- YYYY-MM
      end_month   TEXT,                      -- YYYY-MM inclusive, NULL = open-ended
      active      INTEGER NOT NULL DEFAULT 1,
      last_run    TEXT,                      -- watermark: last month written
      created_at  TEXT NOT NULL
    )`);
  }
  return db;
}

function withDb<T>(readOnly: boolean, fn: (db: DatabaseSync) => T): T {
  const db = open(readOnly);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Ledger dates are Japan-local (JST has no DST, so a fixed offset is exact).
function todayJst(): { iso: string; day: number; month: string } {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const iso = d.toISOString().slice(0, 10);
  return { iso, day: d.getUTCDate(), month: iso.slice(0, 7) };
}

export function addMonth(m: string, delta: number): string {
  let y = Number(m.slice(0, 4));
  let mo = Number(m.slice(5, 7)) + delta;
  while (mo < 1) { mo += 12; y--; }
  while (mo > 12) { mo -= 12; y++; }
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}`;
}

// Net paid for a line item: (price | unit_price*qty) - discount.
function itemNet(it: { qty: number | null; unit_price: number | null; price: number | null; discount: number | null }): number {
  let base = it.price;
  if (base == null) base = it.unit_price != null ? it.unit_price * (it.qty ?? 1) : 0;
  return Math.round(base) - (it.discount ?? 0);
}

export function monthPayload(monthParam: string | null): MonthData {
  const now = todayJst();
  return withDb(true, (db) => {
    const range = db
      .prepare("SELECT min(substr(purchased_on,1,7)) mn, max(substr(purchased_on,1,7)) mx FROM expenses")
      .get() as { mn: string | null; mx: string | null };
    const minMonth = range.mn ?? now.month;
    const maxMonth = (range.mx ?? now.month) > now.month ? (range.mx as string) : now.month;
    let month = monthParam && MONTH_RE.test(monthParam) ? monthParam : now.month;
    if (month < minMonth) month = minMonth;
    if (month > maxMonth) month = maxMonth;

    const rows = db
      .prepare(
        `SELECT id, kind, purchased_on, merchant, amount, currency, category, payment, source, note, image_path
         FROM expenses WHERE substr(purchased_on,1,7)=? ORDER BY purchased_on DESC, id DESC`
      )
      .all(month) as Record<string, unknown>[];

    const ids = rows.map((r) => r.id as number);
    const itemsByExp = new Map<number, LineItem[]>();
    if (ids.length) {
      const marks = ids.map(() => "?").join(",");
      const itRows = db
        .prepare(
          `SELECT expense_id, name, qty, unit_price, price, discount
           FROM line_items WHERE expense_id IN (${marks}) ORDER BY id`
        )
        .all(...ids) as Record<string, unknown>[];
      for (const r of itRows) {
        const raw = {
          qty: (r.qty as number) ?? null,
          unit_price: (r.unit_price as number) ?? null,
          price: (r.price as number) ?? null,
          discount: (r.discount as number) ?? null,
        };
        const item: LineItem = { name: String(r.name), ...raw, net: itemNet(raw) };
        const eid = r.expense_id as number;
        if (!itemsByExp.has(eid)) itemsByExp.set(eid, []);
        itemsByExp.get(eid)!.push(item);
      }
    }

    const prevSpent = db
      .prepare(
        "SELECT coalesce(sum(amount),0) s FROM expenses WHERE substr(purchased_on,1,7)=? AND currency='JPY' AND kind='expense'"
      )
      .get(addMonth(month, -1)) as { s: number };

    // ---- aggregates (JPY only; other currencies listed but never summed) ----
    // Entries dated after today are "upcoming" (scheduled but not yet paid):
    // they get their own sums and stay out of spent/income and the
    // category/merchant/item breakdowns until their day arrives.
    let income = 0, spent = 0, upcomingSpent = 0, upcomingIncome = 0;
    const byCat = new Map<string | null, number>();
    const top = new Map<string, { total: number; count: number; cats: Map<string | null, number> }>();
    const merchants = new Map<string, { total: number; count: number; cats: Map<string | null, number> }>();
    const bump = (m: Map<string | null, number>, k: string | null, v: number) => m.set(k, (m.get(k) ?? 0) + v);

    const transactions: Tx[] = rows.map((r) => {
      const items = itemsByExp.get(r.id as number) ?? [];
      const t: Tx = {
        id: r.id as number,
        kind: r.kind === "income" ? "income" : "expense",
        date: String(r.purchased_on),
        merchant: (r.merchant as string) ?? null,
        amount: r.amount as number,
        currency: String(r.currency),
        category: (r.category as string) ?? null,
        payment: (r.payment as string) ?? null,
        source: String(r.source),
        note: (r.note as string) ?? null,
        hasImage: !!r.image_path,
        items,
        itemsNet: items.reduce((s, i) => s + i.net, 0),
      };
      if (t.currency !== "JPY") return t;
      const upcoming = t.date > now.iso;
      if (t.kind === "income") {
        if (upcoming) upcomingIncome += t.amount; else income += t.amount;
        return t;
      }
      if (upcoming) {
        upcomingSpent += t.amount;
        return t;
      }
      spent += t.amount;
      bump(byCat, t.category, t.amount);
      const mk = t.merchant ?? "(unknown)";
      const m = merchants.get(mk) ?? { total: 0, count: 0, cats: new Map() };
      m.total += t.amount; m.count++; bump(m.cats, t.category, 1);
      merchants.set(mk, m);
      for (const it of items) {
        const e = top.get(it.name) ?? { total: 0, count: 0, cats: new Map() };
        e.total += it.net; e.count++; bump(e.cats, t.category, 1);
        top.set(it.name, e);
      }
      return t;
    });

    const net = income - spent;
    const momPct = prevSpent.s > 0 ? Math.round(((spent - prevSpent.s) / prevSpent.s) * 100) : null;
    const topCat = (cats: Map<string | null, number>): string | null =>
      [...cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const topItems = [...top.entries()]
      .map(([name, v]) => ({ name, total: v.total, count: v.count, category: topCat(v.cats) }))
      .sort((a, b) => b.total - a.total);
    const byMerchant = [...merchants.entries()]
      .map(([merchant, v]) => ({ merchant, total: v.total, count: v.count, category: topCat(v.cats) }))
      .sort((a, b) => b.total - a.total);

    return {
      month, minMonth, maxMonth, today: now.iso,
      totals: {
        income, spent, net,
        savingsRate: income > 0 ? Math.round((net / income) * 100) : 0,
        momPct, prevSpent: prevSpent.s,
        count: transactions.length,
        upcomingSpent, upcomingIncome,
      },
      byCategory: [...byCat.entries()]
        .filter(([, a]) => a > 0)
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount),
      topItems: topItems.slice(0, 12),
      distinctItems: topItems.length,
      byMerchant: byMerchant.slice(0, 8),
      transactions,
    };
  });
}

/* ---------- manual writes (web form; the Telegram bot has its own writer) ---------- */

export function validateTx(body: unknown): { fields?: TxFields; errors?: string[] } {
  const errors: string[] = [];
  const o = (body ?? {}) as Record<string, unknown>;

  const kind = o.kind === "income" ? "income" : o.kind === "expense" ? "expense" : null;
  if (!kind) errors.push("kind must be 'expense' or 'income'");

  const amount = typeof o.amount === "number" && Number.isInteger(o.amount) ? o.amount : NaN;
  if (!(amount > 0 && amount <= 99_999_999)) errors.push("amount must be a positive whole number of yen");

  const category = typeof o.category === "string" ? o.category : "";
  if (kind && !(kind === "income" ? INCOME_CATS : EXPENSE_CATS).has(category)) errors.push("unknown category");

  const date = typeof o.date === "string" ? o.date : "";
  const roundtrip = DATE_RE.test(date) ? new Date(date + "T00:00:00Z").toISOString().slice(0, 10) : "";
  if (roundtrip !== date) errors.push("date must be a real YYYY-MM-DD date");
  // Future dates are allowed (they show as upcoming) — bounded to catch typos.
  else if (date.slice(0, 7) > addMonth(todayJst().month, 24)) errors.push("date is more than 2 years ahead");
  else if (date < "2020-01-01") errors.push("date is before 2020");

  const note = typeof o.note === "string" ? o.note.trim().slice(0, 300) : "";

  if (errors.length) return { errors };
  return { fields: { kind: kind!, amount, category, date, note: note || null } };
}

export function createTx(f: TxFields): number {
  return withDb(false, (db) => {
    const r = db
      .prepare(
        `INSERT INTO expenses (recorded_at, purchased_on, merchant, amount, currency, category, payment, source, note, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(new Date().toISOString(), f.date, null, f.amount, "JPY", f.category, null, "manual", f.note, f.kind);
    return Number(r.lastInsertRowid);
  });
}

// Updates the form-editable fields only; merchant/payment/source/currency/
// line items/receipt image of bot-captured rows are preserved.
export function updateTx(id: number, f: TxFields): boolean {
  return withDb(false, (db) => {
    const r = db
      .prepare("UPDATE expenses SET purchased_on=?, amount=?, category=?, note=?, kind=? WHERE id=?")
      .run(f.date, f.amount, f.category, f.note, f.kind, id);
    return r.changes > 0;
  });
}

export function deleteTx(id: number): boolean {
  return withDb(false, (db) => db.prepare("DELETE FROM expenses WHERE id=?").run(id).changes > 0);
}

/* ---------- recurring rules (fixed monthly expenses / income) ----------
   Rules live in the `recurring` table; each month's entries are written into
   `expenses` (source='recurring', merchant=name) up front — future-dated —
   the first time month data is served in that month, so the month's schedule
   is visible as "upcoming" before the money moves (variable amounts, e.g. a
   mobile bill, get edited on the entry once known). Missed months catch up
   on the next visit. `last_run` is a forward-only watermark: deleting a
   generated entry never resurrects it, and months skipped while paused are
   not backfilled on resume. */

// Read-only connections may predate the table (it is created by the first
// writable open), so probe before querying.
function hasRecurringTable(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recurring'").get();
}

function daysInMonth(m: string): number {
  return new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
}

// Due date within month m: the rule's day, clamped to the month's length
// (day 31 → Apr 30, Feb 28/29).
function dueDate(m: string, day: number): string {
  return `${m}-${String(Math.min(day, daysInMonth(m))).padStart(2, "0")}`;
}

function isMonth(m: string): boolean {
  if (!MONTH_RE.test(m)) return false;
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return y >= 2020 && y <= 2099 && mo >= 1 && mo <= 12;
}

type RecRow = Record<string, unknown>;

function toRecurring(r: RecRow): Recurring {
  return {
    id: r.id as number,
    name: String(r.name),
    kind: r.kind === "income" ? "income" : "expense",
    amount: r.amount as number,
    category: String(r.category),
    day: r.day as number,
    startMonth: String(r.start_month),
    endMonth: (r.end_month as string) ?? null,
    active: !!r.active,
    lastRun: (r.last_run as string) ?? null,
  };
}

// Months this rule still owes entries for, oldest first. The current month
// is written in full as soon as it starts (entries may be future-dated).
function dueMonths(r: Recurring, nowMonth: string): string[] {
  if (!r.active) return [];
  let m = r.lastRun ? addMonth(r.lastRun, 1) : r.startMonth;
  if (m < r.startMonth) m = r.startMonth;
  const months: string[] = [];
  while (m <= nowMonth && months.length < 120) {
    if (r.endMonth && m > r.endMonth) break;
    months.push(m);
    m = addMonth(m, 1);
  }
  return months;
}

export function listRecurring(): Recurring[] {
  return withDb(true, (db) => {
    if (!hasRecurringTable(db)) return [];
    const rows = db
      .prepare("SELECT * FROM recurring ORDER BY active DESC, day, id")
      .all() as RecRow[];
    return rows.map(toRecurring);
  });
}

export function validateRecurring(body: unknown): { fields?: RecurringFields; errors?: string[] } {
  const errors: string[] = [];
  const o = (body ?? {}) as Record<string, unknown>;

  const name = typeof o.name === "string" ? o.name.trim().slice(0, 80) : "";
  if (!name) errors.push("name is required");

  const kind = o.kind === "income" ? "income" : o.kind === "expense" ? "expense" : null;
  if (!kind) errors.push("kind must be 'expense' or 'income'");

  const amount = typeof o.amount === "number" && Number.isInteger(o.amount) ? o.amount : NaN;
  if (!(amount > 0 && amount <= 99_999_999)) errors.push("amount must be a positive whole number of yen");

  const category = typeof o.category === "string" ? o.category : "";
  if (kind && !(kind === "income" ? INCOME_CATS : EXPENSE_CATS).has(category)) errors.push("unknown category");

  const day = typeof o.day === "number" && Number.isInteger(o.day) ? o.day : NaN;
  if (!(day >= 1 && day <= 31)) errors.push("day must be between 1 and 31");

  const startMonth = typeof o.startMonth === "string" && isMonth(o.startMonth) ? o.startMonth : "";
  if (!startMonth) errors.push("startMonth must be a YYYY-MM month");

  let endMonth: string | null = null;
  if (o.endMonth != null && o.endMonth !== "") {
    endMonth = typeof o.endMonth === "string" && isMonth(o.endMonth) ? o.endMonth : "";
    if (!endMonth) errors.push("endMonth must be a YYYY-MM month");
    else if (startMonth && endMonth < startMonth) errors.push("endMonth is before startMonth");
  }

  if (errors.length) return { errors };
  return { fields: { name, kind: kind!, amount, category, day, startMonth, endMonth } };
}

// Write every due entry for the given rules (all active rules when ids is
// omitted) and advance their watermarks. A single IMMEDIATE transaction —
// with the rules re-read under the lock — keeps concurrent requests from
// double-writing a month.
function materialize(db: DatabaseSync, ids?: number[]): number {
  const now = todayJst();
  let generated = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = (ids?.length
      ? db.prepare(`SELECT * FROM recurring WHERE active=1 AND id IN (${ids.map(() => "?").join(",")})`).all(...ids)
      : db.prepare("SELECT * FROM recurring WHERE active=1").all()) as RecRow[];
    const ins = db.prepare(
      `INSERT INTO expenses (recorded_at, purchased_on, merchant, amount, currency, category, payment, source, note, kind)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    const mark = db.prepare("UPDATE recurring SET last_run=? WHERE id=?");
    for (const row of rows) {
      const r = toRecurring(row);
      const months = dueMonths(r, now.month);
      for (const m of months) {
        ins.run(new Date().toISOString(), dueDate(m, r.day), r.name, r.amount, "JPY", r.category, null, "recurring", null, r.kind);
        generated++;
      }
      if (months.length) mark.run(months[months.length - 1], r.id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return generated;
}

// Called before serving month data. The read-only probe keeps the common
// nothing-due case from ever opening a writer.
export function runRecurringDue(): number {
  const now = todayJst();
  const anyDue = withDb(true, (db) => {
    if (!hasRecurringTable(db)) return false;
    const rows = db
      .prepare("SELECT * FROM recurring WHERE active=1 AND start_month<=? AND (last_run IS NULL OR last_run<?)")
      .all(now.month, now.month) as RecRow[];
    return rows.some((r) => dueMonths(toRecurring(r), now.month).length > 0);
  });
  if (!anyDue) return 0;
  return withDb(false, (db) => materialize(db));
}

export function createRecurring(f: RecurringFields): { id: number; generated: number } {
  return withDb(false, (db) => {
    const r = db
      .prepare(
        `INSERT INTO recurring (name, kind, amount, category, day, start_month, end_month, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(f.name, f.kind, f.amount, f.category, f.day, f.startMonth, f.endMonth, new Date().toISOString());
    const id = Number(r.lastInsertRowid);
    return { id, generated: materialize(db, [id]) };
  });
}

// `fields` rewrites the rule (future months only — the watermark never moves
// back, so months already written are untouched). Resuming a paused rule
// restarts from the current month; the paused gap stays skipped.
export function updateRecurring(
  id: number,
  fields: RecurringFields | null,
  active: boolean | null
): { found: boolean; generated: number } {
  return withDb(false, (db) => {
    const row = db.prepare("SELECT * FROM recurring WHERE id=?").get(id) as RecRow | undefined;
    if (!row) return { found: false, generated: 0 };
    const cur = toRecurring(row);
    if (fields) {
      db.prepare(
        "UPDATE recurring SET name=?, kind=?, amount=?, category=?, day=?, start_month=?, end_month=? WHERE id=?"
      ).run(fields.name, fields.kind, fields.amount, fields.category, fields.day, fields.startMonth, fields.endMonth, id);
    }
    if (active != null && active !== cur.active) {
      let lastRun = cur.lastRun;
      if (active) {
        const floor = addMonth(todayJst().month, -1);
        if (!lastRun || lastRun < floor) lastRun = floor;
      }
      db.prepare("UPDATE recurring SET active=?, last_run=? WHERE id=?").run(active ? 1 : 0, lastRun, id);
    }
    return { found: true, generated: materialize(db, [id]) };
  });
}

// Deletes the rule only; entries it already wrote stay in the ledger.
export function deleteRecurring(id: number): boolean {
  return withDb(false, (db) => db.prepare("DELETE FROM recurring WHERE id=?").run(id).changes > 0);
}

// Resolve an expense's archived receipt image; fails closed on anything
// outside the receipts directory.
export function receiptPath(id: number): string | null {
  const row = withDb(true, (db) =>
    db.prepare("SELECT image_path FROM expenses WHERE id=?").get(id)
  ) as { image_path: string | null } | undefined;
  if (!row?.image_path) return null;
  let p: string;
  try {
    p = fs.realpathSync(row.image_path);
  } catch {
    return null;
  }
  if (!p.startsWith(RECEIPTS_DIR + path.sep) || !fs.statSync(p).isFile()) return null;
  return p;
}
