export type LineItem = {
  name: string;
  qty: number | null;
  unit_price: number | null;
  price: number | null;      // list price as printed on the receipt
  discount: number | null;   // positive magnitude; net = price - discount
  net: number;
};

export type Tx = {
  id: number;
  kind: "expense" | "income";
  date: string;              // purchased_on, YYYY-MM-DD
  merchant: string | null;   // null for manual entries (display falls back to category)
  amount: number;            // grand total actually paid — authoritative
  currency: string;
  category: string | null;
  payment: string | null;
  source: string;            // 'receipt' | 'text' (bot) | 'manual' (web form)
  note: string | null;
  hasImage: boolean;
  itemsNet: number;          // sum of item nets (tax basis varies by store)
  items: LineItem[];
};

export type Totals = {
  income: number;            // JPY income this month, dated on/before today
  spent: number;             // JPY expenses this month, dated on/before today
  net: number;               // income - spent (actuals only)
  savingsRate: number;       // % of income saved (0 when no income)
  momPct: number | null;     // expenses vs previous month, %
  prevSpent: number;
  count: number;             // all entries (both kinds, any currency)
  upcomingSpent: number;     // JPY expenses dated after today (scheduled, not yet paid)
  upcomingIncome: number;    // JPY income dated after today
};

export type CatAmount = { category: string | null; amount: number };
export type TopItem = { name: string; total: number; count: number; category: string | null };
export type MerchantAgg = { merchant: string; total: number; count: number; category: string | null };

export type MonthData = {
  month: string;             // YYYY-MM (clamped to [minMonth, maxMonth])
  minMonth: string;
  maxMonth: string;
  today: string;
  totals: Totals;
  byCategory: CatAmount[];   // expenses only
  topItems: TopItem[];       // expense line items, net of discounts
  distinctItems: number;
  byMerchant: MerchantAgg[]; // expenses only
  transactions: Tx[];        // newest first, both kinds
};

export type TxFields = {
  kind: "expense" | "income";
  amount: number;
  category: string;
  date: string;
  note: string | null;
};

// A monthly recurring rule (rent, subscriptions, salary, …). Due entries are
// materialized into `expenses` (source='recurring', merchant=name) when the
// app loads month data; `lastRun` is the watermark of the last month written.
export type Recurring = {
  id: number;
  name: string;              // becomes the generated entry's merchant
  kind: "expense" | "income";
  amount: number;            // integer yen
  category: string;
  day: number;               // 1-31, clamped to the month's length
  startMonth: string;        // YYYY-MM, first month generated
  endMonth: string | null;   // YYYY-MM inclusive; null = open-ended
  active: boolean;
  lastRun: string | null;    // YYYY-MM of the last generated month
};

export type RecurringFields = Omit<Recurring, "id" | "active" | "lastRun">;
