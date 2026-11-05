export const TG_URL = "https://t.me/leggeri_phat_bot";
export const TG_NAME = "@leggeri_phat_bot";

export const yen = (n: number) => "¥" + Math.round(n).toLocaleString("en-US");

// Amounts in other currencies are shown with their code, never summed into ¥.
export const money = (n: number, currency: string) =>
  currency === "JPY" ? yen(n) : `${n.toLocaleString("en-US")} ${currency}`;

const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

export function monthLabel(m: string): string {
  return `${MONTHS_FULL[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
}

export function addMonth(m: string, delta: number): string {
  let y = Number(m.slice(0, 4));
  let mo = Number(m.slice(5, 7)) + delta;
  while (mo < 1) { mo += 12; y--; }
  while (mo > 12) { mo -= 12; y++; }
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}`;
}

export function fmtDate(d: string): string {
  return `${MONTHS_SHORT[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
}

export function fmtDateFull(d: string): string {
  const dt = new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return `${WEEKDAYS[dt.getDay()]}, ${fmtDate(d)}`;
}

// Fixed palette for the bot's category set (colors from the design system).
export const CATS: Record<string, { label: string; color: string }> = {
  groceries:     { label: "Groceries",     color: "#6E8B54" },
  dining:        { label: "Dining",        color: "#D9963D" },
  education:     { label: "Education",     color: "#4A7C7E" },
  online:        { label: "Online",        color: "#A76A8C" },
  transport:     { label: "Transport",     color: "#5B7B9A" },
  household:     { label: "Household",     color: "#C96442" },
  health:        { label: "Health",        color: "#B56576" },
  entertainment: { label: "Entertainment", color: "#7E6BB3" },
  bills:         { label: "Bills",         color: "#B8973C" },
  other:         { label: "Other",         color: "#9E9888" },
};

// Income categories (colors from the design prototype's INCOME set).
export const INCOME_CATS: Record<string, { label: string; color: string }> = {
  salary:      { label: "Salary",      color: "#5B8A66" },
  freelance:   { label: "Freelance",   color: "#4E8C86" },
  investments: { label: "Investments", color: "#6E8B54" },
};

export function catOf(c: string | null, kind: "expense" | "income" = "expense"): { label: string; color: string } {
  if (kind === "income") {
    if (!c) return { label: "Income", color: "#5B8A66" };
    return INCOME_CATS[c] ?? { label: c.charAt(0).toUpperCase() + c.slice(1), color: "#5B8A66" };
  }
  if (!c) return { label: "Uncategorized", color: "#B4AE9E" };
  return CATS[c] ?? { label: c.charAt(0).toUpperCase() + c.slice(1), color: "#9E9888" };
}
