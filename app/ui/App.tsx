"use client";
// The "Ledger" app — a faithful implementation of the "Expense Tracker.dc.html"
// Claude Design prototype over the real ledger DB. Income/expense entries can
// be added, edited and deleted here (source='manual'); receipts still flow in
// via the Telegram bot, and their line items show in the expandable rows.
// Styling is Tailwind (tokens in globals.css); data-driven values
// (category colors, bar widths, donut gradient) are inline styles.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LineItem, MonthData, Recurring, RecurringFields, Tx } from "@/lib/types";
import { TG_URL, TG_NAME, yen, money, monthLabel, addMonth, fmtDate, fmtDateFull, catOf, CATS, INCOME_CATS } from "./format";
import {
  BagYen, CardTx, Chart, Check, ChevronLeft, ChevronRight, Clock, Dashboard, DashboardFill,
  Layers, LayersFill, Pencil, Plus, Receipt, Repeat, Wallet, WalletFill, XMark,
} from "./icons";

type View = "dashboard" | "categories" | "transactions";
type Form = { kind: "expense" | "income"; amount: string; category: string; date: string; note: string };
type Flash = { text: string; ok: boolean };

const CARD = "bg-white border border-line rounded-2xl shadow-[0_1px_2px_rgba(60,50,30,.04)]";
const H2 = "font-serif font-medium text-[17px] leading-[1.2] text-ink";
const CARD_LABEL = "font-semibold text-xs leading-none text-faint";

const TITLES: Record<View, { h1: string; sub: string }> = {
  dashboard:    { h1: "Dashboard",    sub: "Your money at a glance" },
  categories:   { h1: "Categories",   sub: "Every entry and item this month, grouped by category" },
  transactions: { h1: "Transactions", sub: "Add, edit and review your entries" },
};

const displayName = (t: Tx) => t.merchant ?? catOf(t.category, t.kind).label;
const amountLabel = (t: Tx) => `${t.kind === "income" ? "+" : "−"}${money(t.amount, t.currency)}`;
const amountCls = (t: Tx) => (t.kind === "income" ? "text-good-deep" : "text-ink");
const emptyForm = (kind: Form["kind"] = "expense"): Form =>
  ({ kind, amount: "", category: kind === "expense" ? "groceries" : "salary", date: "", note: "" });

export default function App() {
  const [data, setData] = useState<MonthData | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [navCollapsed, setNavCollapsed] = useState(true);
  const [mobile, setMobile] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [form, setForm] = useState<Form>(emptyForm());
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [rules, setRules] = useState<Recurring[] | null>(null);
  const monthRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (m: string | null) => {
    try {
      const res = await fetch("/api/month" + (m ? `?m=${m}` : ""), { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      setData(j);
      setFlash((f) => (f && !f.ok ? null : f));
    } catch (e) {
      setFlash({ text: (e as Error).message || "Could not load the ledger", ok: false });
    }
  }, []);

  const loadRules = useCallback(async () => {
    try {
      const res = await fetch("/api/recurring", { cache: "no-store" });
      const j = await res.json();
      if (res.ok) setRules(j.rules);
    } catch {
      /* header-only card until rules load; month errors already surface */
    }
  }, []);

  useEffect(() => { load(null); loadRules(); }, [load, loadRules]);
  useEffect(() => { monthRef.current = data?.month ?? null; }, [data]);
  useEffect(() => {
    // first load: default the form date (today, or mid-month for past months)
    if (data) setForm((f) => (f.date ? f : { ...f, date: defDate(data) }));
  }, [data]);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 859px)");
    const upd = () => setMobile(mq.matches);
    upd();
    mq.addEventListener("change", upd);
    const vis = () => { if (document.visibilityState === "visible") load(monthRef.current); };
    document.addEventListener("visibilitychange", vis);
    return () => {
      mq.removeEventListener("change", upd);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [load]);
  useEffect(() => { scrollRef.current?.scrollTo(0, 0); }, [view]);
  useEffect(() => {
    if (data && flash) {
      const t = setTimeout(() => setFlash(null), flash.ok ? 1800 : 3200);
      return () => clearTimeout(t);
    }
  }, [data, flash]);

  if (!data) {
    return <Splash err={flash && !flash.ok ? flash.text : null} retry={() => load(null)} />;
  }

  const canPrev = addMonth(data.month, -1) >= data.minMonth;
  const canNext = addMonth(data.month, 1) <= data.maxMonth;
  const goMonth = (delta: number) => {
    const nm = addMonth(data.month, delta);
    if (nm < data.minMonth || nm > data.maxMonth) return;
    load(nm);
  };
  const toggle = (id: number) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const resetForm = () => {
    setEditing(null);
    setForm({ ...emptyForm(), date: defDate(data) });
  };
  const goAdd = () => {
    setView("transactions");
    resetForm();
  };
  const editTx = (t: Tx) => {
    const known = t.category && (t.kind === "income" ? INCOME_CATS : CATS)[t.category];
    setView("transactions");
    setEditing(t.id);
    setForm({
      kind: t.kind,
      amount: String(t.amount),
      category: known ? (t.category as string) : t.kind === "income" ? "salary" : "other",
      date: t.date,
      note: t.note ?? "",
    });
  };

  const amt = Number(form.amount);
  const canSubmit = amt > 0 && !!form.date;

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      const res = await fetch(editing ? `/api/tx/${editing}` : "/api/tx", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: form.kind, amount: amt, category: form.category,
          date: form.date, note: form.note.trim() || null,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      const saved = editing != null;
      setEditing(null);
      setForm((f) => ({ ...f, amount: "", note: "" }));
      await load(form.date.slice(0, 7));
      setFlash({ text: saved ? "Changes saved" : "Transaction added", ok: true });
    } catch (e) {
      setFlash({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const del = async (t: Tx) => {
    if (!window.confirm(`Delete ${displayName(t)} · ${money(t.amount, t.currency)}?`)) return;
    try {
      const res = await fetch(`/api/tx/${t.id}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      if (editing === t.id) resetForm();
      await load(data.month);
      setFlash({ text: "Transaction deleted", ok: true });
    } catch (e) {
      setFlash({ text: (e as Error).message, ok: false });
    }
  };

  const wrote = (n: number) => (n ? ` — ${n} ${n === 1 ? "entry" : "entries"} written` : "");

  const saveRule = async (fields: RecurringFields, id: number | null): Promise<boolean> => {
    try {
      const res = await fetch(id != null ? `/api/recurring/${id}` : "/api/recurring", {
        method: id != null ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fields),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      await Promise.all([loadRules(), load(data.month)]);
      setFlash({ text: (id != null ? "Recurring updated" : "Recurring added") + wrote(j.generated), ok: true });
      return true;
    } catch (e) {
      setFlash({ text: (e as Error).message, ok: false });
      return false;
    }
  };

  const toggleRule = async (r: Recurring) => {
    try {
      const res = await fetch(`/api/recurring/${r.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !r.active }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      await Promise.all([loadRules(), load(data.month)]);
      setFlash({ text: `${r.name} ${r.active ? "paused" : "resumed"}` + wrote(j.generated), ok: true });
    } catch (e) {
      setFlash({ text: (e as Error).message, ok: false });
    }
  };

  const deleteRule = async (r: Recurring) => {
    if (!window.confirm(`Delete recurring "${r.name}"? Entries already in the ledger stay.`)) return;
    try {
      const res = await fetch(`/api/recurring/${r.id}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      await loadRules();
      setFlash({ text: "Recurring deleted — past entries kept", ok: true });
    } catch (e) {
      setFlash({ text: (e as Error).message, ok: false });
    }
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-cream text-ink">
      {!mobile && (
        <Sidebar view={view} setView={setView} collapsed={navCollapsed} onToggle={() => setNavCollapsed((v) => !v)} />
      )}

      <div className="flex h-dvh min-w-0 flex-1 flex-col">
        {!mobile ? (
          <header className="flex flex-none items-center gap-4 border-b border-line bg-surface px-8 py-5">
            <div className="min-w-0 flex-1">
              <h1 className="font-serif font-medium text-[25px] leading-[1.1] tracking-[-.01em] text-ink">
                {TITLES[view].h1}
              </h1>
              <p className="mt-[3px] text-[13.5px] leading-[1.4] text-muted">{TITLES[view].sub}</p>
            </div>
            <Pager label={monthLabel(data.month)} canPrev={canPrev} canNext={canNext} go={goMonth} />
            <button onClick={goAdd}
                    className="flex h-[42px] cursor-pointer items-center gap-[7px] rounded-[10px] border-none bg-accent px-[19px] font-semibold text-[14.5px] leading-none text-white hover:bg-accent-hover active:scale-[.98]">
              <Plus size={18} /> Add
            </button>
          </header>
        ) : (
          <header className="flex flex-none flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3.5">
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-accent text-white">
              <Wallet size={16} />
            </span>
            <span className="font-serif font-semibold text-lg leading-none text-ink">Ledger</span>
            <div className="flex-1" />
            <Pager compact label={monthLabel(data.month)} canPrev={canPrev} canNext={canNext} go={goMonth} />
          </header>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-[1160px] p-[clamp(16px,3vw,30px)]">
            {view === "dashboard" ? (
              <DashView d={data} goTx={() => setView("transactions")} goCats={() => setView("categories")} />
            ) : view === "categories" ? (
              <CatView d={data} />
            ) : (
              <TxView d={data} rules={rules} expanded={expanded} toggle={toggle}
                      form={form} setForm={setForm} editing={editing} busy={busy} canSubmit={canSubmit}
                      onSubmit={submit} onCancel={resetForm} onEdit={editTx} onDelete={del}
                      onRuleSave={saveRule} onRuleToggle={toggleRule} onRuleDelete={deleteRule} />
            )}
          </div>
        </div>

        {mobile && <BottomNav view={view} setView={setView} goAdd={goAdd} />}
      </div>

      {flash && <Toast text={flash.text} ok={flash.ok} />}
    </div>
  );
}

function defDate(d: MonthData): string {
  return d.month === d.today.slice(0, 7) ? d.today : `${d.month}-15`;
}

/* ---------- chrome ---------- */

function Sidebar({ view, setView, collapsed, onToggle }: {
  view: View; setView: (v: View) => void; collapsed: boolean; onToggle: () => void;
}) {
  const btn = (active: boolean) =>
    "flex cursor-pointer items-center overflow-hidden whitespace-nowrap rounded-[10px] border-none px-[13px] py-2.5 text-left font-semibold leading-none " +
    (active ? "bg-accent-soft text-accent-deep " : "bg-transparent text-muted ") +
    (collapsed ? "justify-center gap-0 text-[0px]" : "justify-start gap-3 text-[14.5px]");
  return (
    <aside className={`relative z-2 flex h-dvh flex-none flex-col border-r border-line bg-surface px-3.5 py-[22px] transition-[width] duration-[180ms] ${collapsed ? "w-[72px]" : "w-[238px]"}`}>
      <button onClick={onToggle} title={collapsed ? "Expand menu" : "Collapse menu"}
              className="absolute -right-[13px] top-[26px] z-3 flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-full border border-line bg-white text-muted shadow-[0_1px_3px_rgba(60,50,30,.12)] hover:border-[#d3cdbe] hover:text-ink">
        <ChevronLeft size={16} className={collapsed ? "rotate-180" : ""} />
      </button>
      <div className={`flex items-center gap-2.5 px-1.5 pt-1.5 pb-[26px] ${collapsed ? "justify-center" : "justify-start"}`}>
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[9px] bg-accent text-white">
          <Wallet size={17} />
        </span>
        {!collapsed && (
          <span className="font-serif font-semibold text-[19px] leading-none tracking-[.01em] text-ink">Ledger</span>
        )}
      </div>
      <nav className="flex flex-col gap-[5px]">
        <button onClick={() => setView("dashboard")} className={btn(view === "dashboard")}>
          <Dashboard size={19} className="flex-none" />Dashboard
        </button>
        <button onClick={() => setView("categories")} className={btn(view === "categories")}>
          <Layers size={19} className="flex-none" />Categories
        </button>
        <button onClick={() => setView("transactions")} className={btn(view === "transactions")}>
          <CardTx size={19} className="flex-none" />Transactions
        </button>
      </nav>
      {!collapsed && (
        <div className="mt-auto rounded-xl bg-cream px-3.5 py-[13px]">
          <div className="font-semibold text-xs leading-[1.3] text-muted">Capture</div>
          <div className="mt-[3px] text-[11.5px] leading-normal text-faint">
            Send receipts to {TG_NAME} on Telegram
          </div>
        </div>
      )}
    </aside>
  );
}

function Pager({ label, canPrev, canNext, go, compact }: {
  label: string; canPrev: boolean; canNext: boolean; go: (d: number) => void; compact?: boolean;
}) {
  const btn = (on: boolean) =>
    `flex cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-muted ${compact ? "h-[30px] w-[30px]" : "h-8 w-8"} ${on ? "opacity-100" : "opacity-30"}`;
  return (
    <div className={`flex items-center gap-[2px] rounded-[10px] bg-cream ${compact ? "p-[3px]" : "p-1"}`}>
      <button onClick={() => go(-1)} className={btn(canPrev)} aria-label="Previous month">
        <ChevronLeft size={compact ? 17 : 18} />
      </button>
      <span className={`text-center font-semibold leading-none text-ink ${compact ? "min-w-[100px] text-[13.5px]" : "min-w-[118px] text-sm"}`}>{label}</span>
      <button onClick={() => go(1)} className={btn(canNext)} aria-label="Next month">
        <ChevronRight size={compact ? 17 : 18} />
      </button>
    </div>
  );
}

// Two tabs left of the Add button and one double-width tab right of it, so the
// button stays centred in the bar now that there are three views.
function BottomNav({ view, setView, goAdd }: { view: View; setView: (v: View) => void; goAdd: () => void }) {
  const tab = (active: boolean, wide = false) =>
    `flex ${wide ? "flex-[2]" : "flex-1"} cursor-pointer flex-col items-center gap-1 border-none bg-transparent py-1.5 font-semibold text-[11px] leading-none ${active ? "text-accent-deep" : "text-muted"}`;
  return (
    <nav className="flex flex-none items-center border-t border-line bg-surface px-4 pt-2 pb-[calc(8px+env(safe-area-inset-bottom))]">
      <button onClick={() => setView("dashboard")} className={tab(view === "dashboard")}>
        <DashboardFill size={22} /> Dashboard
      </button>
      <button onClick={() => setView("categories")} className={tab(view === "categories")}>
        <LayersFill size={22} /> Categories
      </button>
      <button onClick={goAdd} aria-label="Add transaction"
              className="-mt-5 mx-2.5 flex h-[54px] w-[54px] flex-none cursor-pointer items-center justify-center rounded-full border-none bg-accent text-white shadow-[0_6px_16px_rgba(193,95,60,.36)] hover:bg-accent-hover active:scale-95">
        <Plus size={26} />
      </button>
      <button onClick={() => setView("transactions")} className={tab(view === "transactions", true)}>
        <WalletFill size={22} /> Transactions
      </button>
    </nav>
  );
}

function Splash({ err, retry }: { err: string | null; retry: () => void }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3.5 bg-cream">
      <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-accent text-white">
        <Wallet size={24} />
      </span>
      <span className="font-serif font-semibold text-[22px] leading-none text-ink">Ledger</span>
      {err ? (
        <>
          <span className="max-w-[360px] px-5 text-center text-[13.5px] leading-normal text-bad">{err}</span>
          <button onClick={retry}
                  className="h-10 cursor-pointer rounded-[10px] border-none bg-accent px-[22px] font-semibold text-sm leading-none text-white hover:bg-accent-hover">
            Retry
          </button>
        </>
      ) : (
        <span className="text-[13.5px] leading-none text-faint">Loading…</span>
      )}
    </div>
  );
}

function Toast({ text, ok }: { text: string; ok: boolean }) {
  return (
    <div className="fixed bottom-7 left-1/2 z-50 flex max-w-[min(90vw,480px)] -translate-x-1/2 items-center gap-2 rounded-full bg-ink px-5 py-3 font-semibold text-[13.5px] leading-none text-white shadow-[0_8px_26px_rgba(0,0,0,.22)] animate-[hbUp_.25s_ease-out]">
      {ok && <Check size={16} className="text-[#8fd0a0]" />}
      {text}
    </div>
  );
}

/* ---------- dashboard ---------- */

function DashView({ d, goTx, goCats }: { d: MonthData; goTx: () => void; goCats: () => void }) {
  const t = d.totals;
  const cats = d.byCategory.map((c) => ({ ...catOf(c.category), amount: c.amount }));
  const donutHas = t.spent > 0 && cats.length > 0;
  let gradient = "conic-gradient(#e6e1d5 0deg 360deg)";
  const legend: { name: string; color: string; amountLabel: string; pct: string }[] = [];
  if (donutHas) {
    const gap = cats.length > 1 ? 1.8 : 0;
    let acc = 0;
    const parts: string[] = [];
    for (const s of cats) {
      const frac = s.amount / t.spent;
      const start = acc * 360;
      acc += frac;
      const end = acc * 360;
      const gEnd = Math.max(start, end - gap);
      parts.push(`${s.color} ${start.toFixed(2)}deg ${gEnd.toFixed(2)}deg`);
      if (gap > 0) parts.push(`#ffffff ${gEnd.toFixed(2)}deg ${end.toFixed(2)}deg`);
      legend.push({ name: s.label, color: s.color, amountLabel: yen(s.amount), pct: Math.round(frac * 100) + "%" });
    }
    gradient = `conic-gradient(${parts.join(",")})`;
  }
  const maxItem = Math.max(1, d.topItems[0]?.total ?? 1);

  return (
    <div className="flex flex-col gap-[clamp(14px,2vw,20px)]">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-4">
        <StatCard icon={<BagYen size={17} />} iconCls="bg-good-soft text-good" label="Income"
                  value={yen(t.income)} valueCls="text-good-deep" />
        <StatCard icon={<CardTx size={17} />} iconCls="bg-accent-soft text-accent-deep" label="Expenses"
                  value={yen(t.spent)}
                  sub={t.momPct != null ? `${t.momPct >= 0 ? "+" : ""}${t.momPct}% vs last month` : undefined}
                  subCls={t.momPct != null && t.momPct > 0 ? "text-bad" : "text-good"} />
        <StatCard icon={<Chart size={17} />} iconCls="bg-indigo-soft text-indigo" label="Net saved"
                  value={`${t.net < 0 ? "−" : ""}${yen(Math.abs(t.net))}`}
                  valueCls={t.net >= 0 ? "text-good-deep" : "text-bad"}
                  sub={`${t.savingsRate}% of income`} subCls="text-faint" />
        {(t.upcomingSpent > 0 || t.upcomingIncome > 0) && (
          <StatCard icon={<Clock size={17} />} iconCls="bg-indigo-soft text-indigo" label="Upcoming"
                    value={t.upcomingSpent > 0 ? `−${yen(t.upcomingSpent)}` : `+${yen(t.upcomingIncome)}`}
                    valueCls={t.upcomingSpent > 0 ? "text-ink" : "text-good-deep"}
                    sub={t.upcomingSpent > 0 && t.upcomingIncome > 0
                      ? `+${yen(t.upcomingIncome)} income due`
                      : "scheduled, not yet paid"}
                    subCls={t.upcomingSpent > 0 && t.upcomingIncome > 0 ? "text-good" : "text-faint"} />
        )}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(324px,1fr))] items-start gap-5">
        <div className={`${CARD} px-[22px] py-5`}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className={H2}>Spending by category</h2>
            <button onClick={goCats} className="cursor-pointer border-none bg-transparent px-1 py-[2px] font-semibold text-[13px] leading-none text-accent-deep hover:text-accent-deeper">
              Browse items
            </button>
          </div>
          {donutHas ? (
            <div className="mt-4 flex flex-wrap items-center gap-x-7 gap-y-[22px]">
              <div className="relative h-[178px] w-[178px] flex-none">
                <div className="h-full w-full rounded-full" style={{ background: gradient }} />
                <div className="absolute inset-[23px] flex flex-col items-center justify-center rounded-full bg-white shadow-[inset_0_0_0_1px_#ece7db]">
                  <span className="font-medium text-[10.5px] leading-none uppercase tracking-[.06em] text-faint">Spent</span>
                  <span className="mt-1.5 font-serif font-medium text-[21px] leading-[1.1] text-ink">{yen(t.spent)}</span>
                </div>
              </div>
              <div className="flex min-w-[186px] flex-1 flex-col gap-2.5">
                {legend.map((row) => (
                  <div key={row.name} className="flex items-center gap-2.5">
                    <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: row.color }} />
                    <span className="min-w-0 flex-1 truncate font-medium text-[13.5px] leading-[1.3] text-ink-soft">{row.name}</span>
                    <span className="font-semibold text-[13px] leading-none text-ink">{row.amountLabel}</span>
                    <span className="w-[38px] text-right font-medium text-xs leading-none text-faint">{row.pct}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="py-10 text-center text-sm leading-normal text-faint">No spending recorded this month.</div>
          )}
        </div>

        <div className={`${CARD} px-[22px] py-5`}>
          <div className="mb-3.5 flex items-baseline justify-between gap-3">
            <h2 className={H2}>Top items</h2>
            <span className={CARD_LABEL}>{d.distinctItems} tracked</span>
          </div>
          {d.topItems.length ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(228px,1fr))] gap-x-6 gap-y-[15px]">
              {d.topItems.map((it) => {
                const c = catOf(it.category);
                const w = Math.max(3, Math.round((it.total / maxItem) * 100));
                return (
                  <div key={it.name}>
                    <div className="mb-2 flex items-center gap-2">
                      <span className="h-[9px] w-[9px] flex-none rounded-full" style={{ background: c.color }} />
                      <span className="min-w-0 flex-1 truncate font-medium text-[13px] leading-[1.2] text-ink-soft">{it.name}</span>
                      <span className="font-semibold text-[12.5px] leading-none text-ink">{yen(it.total)}</span>
                      <span className="font-medium text-xs leading-none text-fainter">×{it.count}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-track">
                      <div className="h-full rounded-full" style={{ width: `${w}%`, background: c.color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-[30px] text-center text-sm leading-normal text-faint">Line items from receipts will appear here.</div>
          )}
        </div>
      </div>

      <div className={`${CARD} px-2.5 pt-2 pb-3`}>
        <div className="flex items-baseline justify-between gap-3 px-3 pt-[13px] pb-2">
          <h2 className={H2}>Recent transactions</h2>
          <button onClick={goTx} className="cursor-pointer border-none bg-transparent px-1 py-[2px] font-semibold text-[13px] leading-none text-accent-deep hover:text-accent-deeper">
            View all
          </button>
        </div>
        {d.transactions.slice(0, 6).map((t2) => <RecentRow key={t2.id} t={t2} today={d.today} />)}
      </div>
    </div>
  );
}

function StatCard({ icon, iconCls, label, value, valueCls = "text-ink", sub, subCls = "text-faint" }: {
  icon: ReactNode; iconCls: string; label: string; value: string;
  valueCls?: string; sub?: string; subCls?: string;
}) {
  return (
    <div className={`${CARD} px-5 py-[18px]`}>
      <div className="flex items-center gap-[9px]">
        <span className={`flex h-[30px] w-[30px] items-center justify-center rounded-[9px] ${iconCls}`}>{icon}</span>
        <span className="font-semibold text-[13px] leading-none text-muted">{label}</span>
      </div>
      <div className={`mt-3.5 font-serif font-medium text-[clamp(24px,2.6vw,31px)] leading-[1.05] ${valueCls}`}>{value}</div>
      {sub && <div className={`mt-[7px] font-medium text-xs leading-none ${subCls}`}>{sub}</div>}
    </div>
  );
}

function metaOf(t: Tx, withDate: boolean): string {
  return [
    t.note,
    withDate ? fmtDate(t.date) : null,
    t.items.length ? `${t.items.length} item${t.items.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
}

function RecentRow({ t, today }: { t: Tx; today: string }) {
  const c = catOf(t.category, t.kind);
  const name = displayName(t);
  return (
    <div className="flex items-center gap-3 rounded-[11px] px-3 py-2.5 hover:bg-wash">
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] font-semibold text-sm leading-none text-white" style={{ background: c.color }}>
        {name.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[7px]">
          <span className="truncate font-semibold text-sm leading-[1.2] text-ink">{name}</span>
          {t.source === "receipt" && <ReceiptBadge />}
          {t.source === "recurring" && <RepeatBadge />}
          {t.date > today && <UpcomingChip />}
        </div>
        <div className="mt-[2px] text-[12.5px] leading-[1.3] text-faint">{metaOf(t, true)}</div>
      </div>
      <span className={`font-semibold text-sm leading-none ${amountCls(t)}`}>{amountLabel(t)}</span>
    </div>
  );
}

function ReceiptBadge() {
  return (
    <span title="Captured from a receipt" className="flex h-4 w-4 flex-none items-center justify-center rounded-[5px] bg-cream text-faint">
      <Receipt size={11} />
    </span>
  );
}

function RepeatBadge() {
  return (
    <span title="Written by a recurring rule" className="flex h-4 w-4 flex-none items-center justify-center rounded-[5px] bg-cream text-faint">
      <Repeat size={10} />
    </span>
  );
}

function UpcomingChip() {
  return (
    <span title="Scheduled — not yet paid; edit the entry if the actual amount differs"
          className="flex-none rounded-md bg-indigo-soft px-1.5 py-[3px] font-semibold text-[10.5px] leading-none text-indigo">
      upcoming
    </span>
  );
}

/* ---------- categories ---------- */

// One card per category for the selected month, expandable to everything inside
// it: either the entries (with their receipt line items nested) or those line
// items rolled up by name. Derived entirely from the month payload — no extra
// request — so the totals shown here are the same numbers as the donut's.
type CatGroup = {
  key: string;                 // `${kind}:${category}` — stable across months
  label: string;
  color: string;
  kind: "expense" | "income";
  total: number;               // JPY, dated on/before today: matches byCategory / the income card
  txs: Tx[];                   // every entry in the category, newest first (upcoming and non-JPY included)
  items: { name: string; net: number; count: number }[];  // rolled up from counted entries
  itemsNet: number;
  plain: { count: number; amount: number };    // counted entries with no line items
  pending: { count: number; amount: number };  // upcoming: listed, but outside `total`
  foreign: number;                             // non-JPY: listed, but outside `total`
};

function groupByCategory(d: MonthData): { expenses: CatGroup[]; income: CatGroup[] } {
  // Same rule /api/month aggregates by: JPY only, nothing dated after today.
  const counted = (t: Tx) => t.currency === "JPY" && t.date <= d.today;
  const groups = new Map<string, CatGroup>();
  const rollups = new Map<string, Map<string, { net: number; count: number }>>();

  for (const t of d.transactions) {
    const key = `${t.kind}:${t.category ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      const c = catOf(t.category, t.kind);
      g = {
        key, label: c.label, color: c.color, kind: t.kind, total: 0, txs: [], items: [], itemsNet: 0,
        plain: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 }, foreign: 0,
      };
      groups.set(key, g);
      rollups.set(key, new Map());
    }
    g.txs.push(t);
    if (!counted(t)) {
      if (t.currency !== "JPY") g.foreign++;
      else { g.pending.count++; g.pending.amount += t.amount; }
      continue;
    }
    g.total += t.amount;
    if (!t.items.length) {
      g.plain.count++;
      g.plain.amount += t.amount;
      continue;
    }
    g.itemsNet += t.itemsNet;
    const roll = rollups.get(key)!;
    for (const it of t.items) {
      const e = roll.get(it.name) ?? { net: 0, count: 0 };
      e.net += it.net;
      e.count++;
      roll.set(it.name, e);
    }
  }

  for (const [key, roll] of rollups) {
    groups.get(key)!.items = [...roll.entries()]
      .map(([name, v]) => ({ name, net: v.net, count: v.count }))
      .sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
  }

  const all = [...groups.values()].sort((a, b) => b.total - a.total || b.txs.length - a.txs.length);
  return { expenses: all.filter((g) => g.kind === "expense"), income: all.filter((g) => g.kind === "income") };
}

function CatView({ d }: { d: MonthData }) {
  const { expenses, income } = useMemo(() => groupByCategory(d), [d]);
  const [mode, setMode] = useState<"entries" | "items">("entries");
  // null = untouched: the biggest category starts open so the view isn't all shut.
  const [open, setOpen] = useState<ReadonlySet<string> | null>(null);
  const first = expenses[0]?.key ?? income[0]?.key;
  const isOpen = (k: string) => (open ? open.has(k) : k === first);
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev ?? (first ? [first] : []));
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const allKeys = [...expenses, ...income].map((g) => g.key);
  const allOpen = allKeys.length > 0 && allKeys.every(isOpen);

  const itemTotal = expenses.reduce((s, g) => s + g.items.length, 0);
  const modeBtn = (on: boolean) =>
    "cursor-pointer rounded-lg border-none px-3 py-[7px] font-semibold text-[12.5px] leading-none " +
    (on ? "bg-white text-ink shadow-[0_1px_2px_rgba(60,50,30,.08)]" : "bg-transparent text-muted");

  return (
    <div className="flex flex-col gap-[clamp(14px,2vw,20px)]">
      <div className={`${CARD} flex flex-wrap items-center gap-x-5 gap-y-3 px-[22px] py-[18px]`}>
        <div className="min-w-0 flex-1">
          <h2 className={H2}>{monthLabel(d.month)}</h2>
          <p className="mt-[3px] text-[13px] leading-[1.4] text-muted">
            {yen(d.totals.spent)} across {expenses.length} {expenses.length === 1 ? "category" : "categories"}
            {itemTotal > 0 && ` · ${itemTotal} distinct ${itemTotal === 1 ? "item" : "items"}`}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-[10px] bg-cream p-1">
          <button onClick={() => setMode("entries")} className={modeBtn(mode === "entries")}>Entries</button>
          <button onClick={() => setMode("items")} className={modeBtn(mode === "items")}>Items</button>
        </div>
        <button onClick={() => setOpen(allOpen ? new Set() : new Set(allKeys))}
                className="cursor-pointer border-none bg-transparent px-1 py-[2px] font-semibold text-[13px] leading-none text-accent-deep hover:text-accent-deeper">
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>

      {expenses.length ? (
        <div className="flex flex-col gap-3">
          {expenses.map((g) => (
            <CatBlock key={g.key} g={g} share={d.totals.spent} mode={mode} today={d.today}
                      open={isOpen(g.key)} onToggle={() => toggle(g.key)} />
          ))}
        </div>
      ) : (
        <div className={`${CARD} px-[22px] py-10 text-center text-sm leading-normal text-faint`}>
          No spending recorded this month.
        </div>
      )}

      {income.length > 0 && (
        <>
          <div className="px-1 pt-1 font-semibold text-xs leading-none uppercase tracking-[.06em] text-faint">Income</div>
          <div className="flex flex-col gap-3">
            {income.map((g) => (
              <CatBlock key={g.key} g={g} share={d.totals.income} mode={mode} today={d.today}
                        open={isOpen(g.key)} onToggle={() => toggle(g.key)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CatBlock({ g, share, mode, today, open, onToggle }: {
  g: CatGroup; share: number; mode: "entries" | "items"; today: string; open: boolean; onToggle: () => void;
}) {
  const frac = share > 0 ? g.total / share : 0;
  const meta = [
    `${g.txs.length} ${g.txs.length === 1 ? "entry" : "entries"}`,
    g.items.length ? `${g.items.length} ${g.items.length === 1 ? "item" : "items"}` : null,
    g.pending.amount > 0 ? `${yen(g.pending.amount)} upcoming, not counted` : null,
    g.foreign > 0 ? `${g.foreign} in another currency` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className={CARD}>
      <div onClick={onToggle} className="flex cursor-pointer items-center gap-3.5 px-[18px] py-[15px]">
        <span className="h-[11px] w-[11px] flex-none rounded-[4px]" style={{ background: g.color }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2.5">
            <span className="truncate font-serif font-medium text-[15.5px] leading-[1.2] text-ink">{g.label}</span>
            <span className="flex-none font-medium text-xs leading-none text-faint">{Math.round(frac * 100)}%</span>
          </div>
          <div className="mt-[3px] truncate text-xs leading-[1.3] text-faint">{meta}</div>
        </div>
        <span className={`flex-none font-semibold text-[15px] leading-none ${g.kind === "income" ? "text-good-deep" : "text-ink"}`}>
          {g.kind === "income" ? "+" : ""}{yen(g.total)}
        </span>
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-lg text-fainter">
          <ChevronLeft size={16} className={`transition-transform duration-150 ${open ? "rotate-[270deg]" : "rotate-180"}`} />
        </span>
      </div>

      <div className="mx-[18px] h-1.5 overflow-hidden rounded-full bg-track">
        <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.round(frac * 100))}%`, background: g.color }} />
      </div>

      {open && (
        <div className="px-[18px] pt-3.5 pb-4">
          {mode === "entries"
            ? g.txs.map((t) => <CatEntry key={t.id} t={t} today={today} />)
            : <CatItems g={g} />}
        </div>
      )}
      {!open && <div className="pb-4" />}
    </div>
  );
}

// An entry inside a category: read-only (editing stays in the Transactions
// view) with its receipt line items always shown — the point of the view.
function CatEntry({ t, today }: { t: Tx; today: string }) {
  return (
    <div className="border-t border-line-soft py-2.5 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-3">
        <span className="w-[46px] flex-none font-medium text-xs leading-none text-faint">{fmtDate(t.date)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[7px]">
            <span className="truncate font-semibold text-[13.5px] leading-[1.2] text-ink">{displayName(t)}</span>
            {t.source === "receipt" && <ReceiptBadge />}
            {t.source === "recurring" && <RepeatBadge />}
            {t.date > today && <UpcomingChip />}
          </div>
          {t.note && <div className="mt-px truncate text-xs leading-[1.3] text-faint">{t.note}</div>}
        </div>
        <span className={`flex-none font-semibold text-[13.5px] leading-none ${amountCls(t)}`}>{amountLabel(t)}</span>
      </div>
      {t.items.length > 0 && (
        <div className="mt-1.5 ml-[46px] rounded-[10px] bg-wash px-3 py-2">
          {t.items.map((it, i) => <ItemLine key={i} it={it} />)}
        </div>
      )}
      {t.hasImage && (
        <div className="mt-1.5 ml-[46px]">
          <a href={`/api/receipt/${t.id}`} target="_blank" rel="noreferrer" className="font-semibold text-[12px] leading-none">
            View receipt ↗
          </a>
        </div>
      )}
    </div>
  );
}

function ItemLine({ it }: { it: LineItem }) {
  return (
    <div className="flex items-center gap-2 py-[3px]">
      <span className="min-w-0 flex-1 truncate text-[12.5px] leading-[1.4] text-ink-soft">
        {it.name}
        {it.qty != null && it.qty !== 1 && <span className="text-faint"> ×{it.qty}</span>}
      </span>
      {it.discount ? (
        <span className="flex-none rounded-md bg-bad-soft px-1.5 py-[3px] font-semibold text-[10.5px] leading-none text-bad">−{yen(it.discount)}</span>
      ) : null}
      <span className="flex-none font-medium text-[12.5px] leading-none text-ink">{yen(it.net)}</span>
    </div>
  );
}

// Items mode: every line item in the category rolled up by name (not capped
// like the dashboard's Top items), plus what the rollup can't see.
function CatItems({ g }: { g: CatGroup }) {
  const max = Math.max(1, g.items[0]?.net ?? 1);
  return (
    <div>
      {g.items.length ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-6 gap-y-3">
          {g.items.map((it) => (
            <div key={it.name}>
              <div className="mb-[7px] flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium text-[13px] leading-[1.2] text-ink-soft">{it.name}</span>
                {it.count > 1 && <span className="flex-none font-medium text-xs leading-none text-fainter">×{it.count}</span>}
                <span className="flex-none font-semibold text-[12.5px] leading-none text-ink">{yen(it.net)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-track">
                <div className="h-full rounded-full" style={{ width: `${Math.max(3, Math.round((it.net / max) * 100))}%`, background: g.color }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[13px] leading-[1.45] text-faint">
          {g.kind === "income"
            ? "Income entries aren't itemised — switch to Entries to see them."
            : "Nothing itemised here — these entries were captured as a total, not from a receipt."}
        </div>
      )}
      {g.items.length > 0 && (
        <div className="mt-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-line-soft pt-[11px]">
          <span className="font-semibold text-xs leading-none text-muted">Items net</span>
          <span className="flex-1" />
          {g.plain.count > 0 && (
            <span className="font-medium text-xs leading-none text-faint">
              + {yen(g.plain.amount)} from {g.plain.count} entr{g.plain.count === 1 ? "y" : "ies"} without items
            </span>
          )}
          <span className="font-semibold text-[13px] leading-none text-ink">{yen(g.itemsNet)}</span>
        </div>
      )}
    </div>
  );
}

/* ---------- transactions ---------- */

function TxView({ d, rules, expanded, toggle, form, setForm, editing, busy, canSubmit, onSubmit, onCancel, onEdit, onDelete, onRuleSave, onRuleToggle, onRuleDelete }: {
  d: MonthData; rules: Recurring[] | null; expanded: ReadonlySet<number>; toggle: (id: number) => void;
  form: Form; setForm: (f: Form) => void; editing: number | null; busy: boolean; canSubmit: boolean;
  onSubmit: () => void; onCancel: () => void; onEdit: (t: Tx) => void; onDelete: (t: Tx) => void;
  onRuleSave: (f: RecurringFields, id: number | null) => Promise<boolean>;
  onRuleToggle: (r: Recurring) => void; onRuleDelete: (r: Recurring) => void;
}) {
  const groups: { date: string; items: Tx[]; in: number; out: number }[] = [];
  for (const t of d.transactions) {
    const g = groups[groups.length - 1];
    const inc = t.currency === "JPY" && t.kind === "income" ? t.amount : 0;
    const out = t.currency === "JPY" && t.kind === "expense" ? t.amount : 0;
    if (g && g.date === t.date) {
      g.items.push(t); g.in += inc; g.out += out;
    } else {
      groups.push({ date: t.date, items: [t], in: inc, out });
    }
  }
  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="flex min-w-[min(100%,300px)] flex-[1_1_340px] flex-col gap-4">
        <FormCard form={form} setForm={setForm} editing={editing} busy={busy} canSubmit={canSubmit}
                  onSubmit={onSubmit} onCancel={onCancel} />
        <RecurringCard rules={rules} today={d.today} onSave={onRuleSave} onToggle={onRuleToggle} onDelete={onRuleDelete} />
        <MerchantCard d={d} />
      </div>

      <div className="min-w-[min(100%,320px)] flex-[2_1_420px]">
        <div className={`${CARD} px-2.5 pt-2 pb-3.5`}>
          <div className="flex items-baseline justify-between gap-3 px-3 pt-[13px] pb-1.5">
            <h2 className={H2}>All transactions</h2>
            <span className={CARD_LABEL}>{d.totals.count} in {monthLabel(d.month)}</span>
          </div>
          {groups.length ? (
            groups.map((g) => {
              const net = g.in - g.out;
              return (
                <div key={g.date} className="px-1">
                  <div className="flex items-baseline justify-between px-2 pt-3 pb-[5px]">
                    <span className="font-semibold text-[11.5px] leading-none uppercase tracking-[.03em] text-muted">{fmtDateFull(g.date)}</span>
                    <span className="font-medium text-xs leading-none text-fainter">{net >= 0 ? `+${yen(net)}` : `−${yen(-net)}`}</span>
                  </div>
                  {g.items.map((t) => (
                    <TxRow key={t.id} t={t} today={d.today} open={expanded.has(t.id)} onToggle={() => toggle(t.id)}
                           onEdit={() => onEdit(t)} onDelete={() => onDelete(t)} />
                  ))}
                </div>
              );
            })
          ) : (
            <div className="py-11 text-center text-sm leading-normal text-faint">
              No transactions this month yet.<br />Add one on the left to get started.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FormCard({ form, setForm, editing, busy, canSubmit, onSubmit, onCancel }: {
  form: Form; setForm: (f: Form) => void; editing: number | null; busy: boolean; canSubmit: boolean;
  onSubmit: () => void; onCancel: () => void;
}) {
  const cats = form.kind === "expense" ? CATS : INCOME_CATS;
  const label = "font-semibold text-xs leading-none text-muted";
  const field = "w-full rounded-xl border-none bg-field px-3.5 font-medium text-sm text-ink outline-none";
  const setKind = (kind: Form["kind"]) =>
    setForm({ ...form, kind, category: kind === "expense" ? "groceries" : "salary" });
  const seg = (active: boolean) =>
    `flex-1 cursor-pointer rounded-lg border-none py-[9px] font-semibold text-[13.5px] leading-none ${active ? "bg-white text-ink shadow-[0_1px_3px_rgba(60,50,30,.12)]" : "bg-transparent text-muted"}`;
  const enabled = canSubmit && !busy;
  return (
    <div className={`${CARD} px-5 py-[18px]`}>
      <div className="flex items-baseline justify-between gap-2.5">
        <h2 className={H2}>{editing != null ? "Edit transaction" : "Add transaction"}</h2>
        {editing != null && (
          <button onClick={onCancel} className="cursor-pointer border-none bg-transparent px-1 py-[2px] font-semibold text-[13px] leading-none text-faint hover:text-ink">
            Cancel
          </button>
        )}
      </div>

      <div className="mt-3.5 flex gap-1 rounded-[11px] bg-track p-1">
        <button onClick={() => setKind("expense")} className={seg(form.kind === "expense")}>Expense</button>
        <button onClick={() => setKind("income")} className={seg(form.kind === "income")}>Income</button>
      </div>

      <div className={`${label} mt-4 mb-[7px]`}>Amount</div>
      <div className="flex h-14 items-center gap-2 rounded-xl bg-field px-[18px]">
        <span className="font-serif font-medium text-[22px] leading-none text-faint">¥</span>
        <input type="text" inputMode="numeric" placeholder="0" value={form.amount}
               onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/[^0-9]/g, "").slice(0, 9) })}
               className="min-w-0 flex-1 border-none bg-transparent font-serif font-medium text-2xl leading-none text-ink outline-none" />
      </div>

      <div className={`${label} mt-4 mb-[9px]`}>Category</div>
      <CatChips cats={cats} sel={form.category} onPick={(id) => setForm({ ...form, category: id })} />

      <div className="mt-4 flex flex-wrap gap-3">
        <div className="min-w-[130px] flex-[1_1_150px]">
          <div className={`${label} mb-[7px]`}>Date</div>
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}
                 className={`${field} h-[46px]`} />
        </div>
        <div className="min-w-[150px] flex-[2_1_180px]">
          <div className={`${label} mb-[7px]`}>Note</div>
          <input type="text" placeholder="Optional" value={form.note}
                 onChange={(e) => setForm({ ...form, note: e.target.value })}
                 className={`${field} h-[46px]`} />
        </div>
      </div>

      <button onClick={onSubmit} disabled={!enabled}
              className={`mt-[18px] h-[50px] w-full rounded-xl border-none font-semibold text-[15.5px] leading-none text-white ${enabled ? "cursor-pointer bg-accent hover:bg-accent-hover active:scale-[.99]" : "cursor-not-allowed bg-[#dad5c7]"}`}>
        {editing != null ? "Save changes" : "Add transaction"}
      </button>
      <p className="mt-3 text-xs leading-[1.5] text-faint">
        Receipts? Send a photo to <a href={TG_URL} target="_blank" rel="noreferrer">{TG_NAME}</a> — items are captured automatically.
      </p>
    </div>
  );
}

function TxRow({ t, today, open, onToggle, onEdit, onDelete }: {
  t: Tx; today: string; open: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const c = catOf(t.category, t.kind);
  const name = displayName(t);
  const expandable = t.items.length > 0 || t.hasImage;
  const gap = t.currency === "JPY" ? t.amount - t.itemsNet : 0;
  const actionBtn = "flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-fainter";
  return (
    <div>
      <div onClick={expandable ? onToggle : undefined}
           className={`flex items-center gap-3 rounded-[11px] p-2 hover:bg-wash ${expandable ? "cursor-pointer" : ""}`}>
        <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] font-semibold text-[13px] leading-none text-white" style={{ background: c.color }}>
          {name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[7px]">
            <span className="truncate font-semibold text-[13.5px] leading-[1.2] text-ink">{name}</span>
            {t.source === "receipt" && <ReceiptBadge />}
            {t.source === "recurring" && <RepeatBadge />}
            {t.date > today && <UpcomingChip />}
          </div>
          <div className="mt-px text-xs leading-[1.3] text-faint">{metaOf(t, false) || catOf(t.category, t.kind).label}</div>
        </div>
        <span className={`font-semibold text-sm leading-none ${amountCls(t)}`}>{amountLabel(t)}</span>
        <span className="flex flex-none gap-[2px]" onClick={(e) => e.stopPropagation()}>
          <button title="Edit" onClick={onEdit} className={`${actionBtn} hover:bg-cream hover:text-ink`}>
            <Pencil size={16} />
          </button>
          <button title="Delete" onClick={onDelete} className={`${actionBtn} hover:bg-bad-soft hover:text-bad`}>
            <XMark size={16} />
          </button>
          {expandable && (
            <span onClick={onToggle} className={`${actionBtn} hover:bg-cream hover:text-ink`}>
              <ChevronLeft size={16} className={`transition-transform duration-150 ${open ? "rotate-[270deg]" : "rotate-180"}`} />
            </span>
          )}
        </span>
      </div>

      {open && expandable && (
        <div className="mr-2 mb-2.5 ml-[54px] rounded-xl border border-line-soft bg-surface px-3.5 pt-[11px] pb-3">
          {t.items.map((it, i) => (
            <div key={i} className="flex items-center gap-2 py-1">
              <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.45] text-ink-soft">
                {it.name}
                {it.qty != null && it.qty !== 1 && <span className="text-faint"> ×{it.qty}</span>}
              </span>
              {it.discount ? (
                <span className="flex-none rounded-md bg-bad-soft px-1.5 py-[3px] font-semibold text-[11px] leading-none text-bad">−{yen(it.discount)}</span>
              ) : null}
              <span className="flex-none font-medium text-[13px] leading-none text-ink">{yen(it.net)}</span>
            </div>
          ))}
          {t.items.length > 0 && (
            <div className="mt-2 flex items-center gap-2.5 border-t border-line-soft pt-[9px]">
              <span className="font-semibold text-xs leading-none text-muted">Items net</span>
              <span className="flex-1" />
              {gap !== 0 && (
                <span className="font-medium text-xs leading-none text-faint">
                  {gap > 0 ? `+${yen(gap)} tax / rounding` : `−${yen(-gap)} adjustment`}
                </span>
              )}
              <span className="font-semibold text-[13px] leading-none text-ink">{yen(t.itemsNet)}</span>
            </div>
          )}
          {t.hasImage && (
            <div className={t.items.length ? "mt-[9px]" : ""}>
              <a href={`/api/receipt/${t.id}`} target="_blank" rel="noreferrer" className="font-semibold text-[12.5px] leading-none">
                View receipt ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CatChips({ cats, sel, onPick }: {
  cats: Record<string, { label: string; color: string }>; sel: string; onPick: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {Object.entries(cats).map(([id, c]) => {
        const on = id === sel;
        return (
          <button key={id} onClick={() => onPick(id)}
                  className="flex cursor-pointer items-center gap-[7px] rounded-[9px] border px-[13px] py-2 font-semibold text-[13px] leading-none"
                  style={on
                    ? { background: c.color, borderColor: c.color, color: "#fff" }
                    : { background: "#fff", borderColor: "#e6e1d5", color: "#6b6659" }}>
            <span className="h-[9px] w-[9px] flex-none rounded-full" style={{ background: on ? "rgba(255,255,255,.9)" : c.color }} />
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- recurring rules ---------- */

type RuleDraft = {
  kind: "expense" | "income"; name: string; amount: string;
  category: string; day: string; startMonth: string; endMonth: string;
};

const emptyDraft = (today: string): RuleDraft =>
  ({ kind: "expense", name: "", amount: "", category: "bills", day: "1", startMonth: today.slice(0, 7), endMonth: "" });

const ord = (n: number) =>
  n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");

function daysIn(m: string): number {
  return new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
}

// Status label: the next date the materializer will write, or Paused/Ended.
function ruleStatus(r: Recurring, today: string): string {
  if (!r.active) return "paused";
  let m = r.lastRun ? addMonth(r.lastRun, 1) : r.startMonth;
  if (m < r.startMonth) m = r.startMonth;
  if (r.endMonth && m > r.endMonth) return `ended ${monthLabel(r.endMonth)}`;
  return `next ${fmtDate(`${m}-${String(Math.min(r.day, daysIn(m))).padStart(2, "0")}`)}`;
}

function Switch({ on, title, onClick }: { on: boolean; title: string; onClick: () => void }) {
  return (
    <button title={title} aria-pressed={on} onClick={onClick}
            className={`relative h-[18px] w-8 flex-none cursor-pointer rounded-full border-none transition-colors duration-150 ${on ? "bg-good" : "bg-[#d0cabb]"}`}>
      <span className={`absolute top-[2px] h-3.5 w-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.2)] transition-[left] duration-150 ${on ? "left-[16px]" : "left-[2px]"}`} />
    </button>
  );
}

function RecurringCard({ rules, today, onSave, onToggle, onDelete }: {
  rules: Recurring[] | null; today: string;
  onSave: (f: RecurringFields, id: number | null) => Promise<boolean>;
  onToggle: (r: Recurring) => void; onDelete: (r: Recurring) => void;
}) {
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(() => emptyDraft(today));
  const [saving, setSaving] = useState(false);

  const label = "font-semibold text-xs leading-none text-muted";
  const field = "w-full rounded-xl border-none bg-field px-3.5 font-medium text-sm text-ink outline-none";
  const seg = (active: boolean) =>
    `flex-1 cursor-pointer rounded-lg border-none py-[9px] font-semibold text-[13.5px] leading-none ${active ? "bg-white text-ink shadow-[0_1px_3px_rgba(60,50,30,.12)]" : "bg-transparent text-muted"}`;
  const actionBtn = "flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-fainter";

  const openNew = () => { setDraft(emptyDraft(today)); setEditing("new"); };
  const openEdit = (r: Recurring) => {
    setDraft({ kind: r.kind, name: r.name, amount: String(r.amount), category: r.category,
               day: String(r.day), startMonth: r.startMonth, endMonth: r.endMonth ?? "" });
    setEditing(r.id);
  };
  const setKind = (kind: RuleDraft["kind"]) =>
    setDraft({ ...draft, kind, category: kind === "expense" ? "bills" : "salary" });

  const day = Number(draft.day);
  const canSave = !!draft.name.trim() && Number(draft.amount) > 0 && day >= 1 && day <= 31 &&
    /^\d{4}-\d{2}$/.test(draft.startMonth);

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    const ok = await onSave(
      { name: draft.name.trim(), kind: draft.kind, amount: Number(draft.amount), category: draft.category,
        day, startMonth: draft.startMonth, endMonth: draft.endMonth || null },
      editing === "new" ? null : (editing as number)
    );
    setSaving(false);
    if (ok) setEditing(null);
  };

  return (
    <div className={`${CARD} px-[18px] py-4`}>
      <div className="flex items-center gap-[9px]">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cream text-muted">
          <Repeat size={14} />
        </span>
        <h3 className="flex-1 font-semibold text-sm leading-[1.2] text-ink">Recurring</h3>
        {editing == null && (
          <button onClick={openNew}
                  className="flex cursor-pointer items-center gap-1 border-none bg-transparent px-1 py-[2px] font-semibold text-[13px] leading-none text-accent-deep hover:text-accent-deeper">
            <Plus size={14} /> New
          </button>
        )}
      </div>

      {rules?.length === 0 && editing == null && (
        <p className="mt-3 pb-1 text-[12.5px] leading-[1.5] text-faint">
          Rent, bills, subscriptions, salary — monthly entries written automatically at the start of each
          month, shown as upcoming until their day arrives.
        </p>
      )}

      {!!rules?.length && (
        <div className="mt-1.5 flex flex-col">
          {rules.map((r) => {
            const c = catOf(r.category, r.kind);
            return (
              <div key={r.id} className={`flex items-center gap-[11px] px-[2px] py-[9px] ${r.active ? "" : "opacity-55"}`}>
                <span className="h-[9px] w-[9px] flex-none rounded-full" style={{ background: c.color }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-[13.5px] leading-[1.2] text-ink">{r.name}</div>
                  <div className="mt-px truncate text-xs leading-[1.3] text-faint">
                    {(r.kind === "income" ? "+" : "") + yen(r.amount)} · the {ord(r.day)} · {ruleStatus(r, today)}
                  </div>
                </div>
                <Switch on={r.active} title={r.active ? "Pause" : "Resume"} onClick={() => onToggle(r)} />
                <button title="Edit" onClick={() => openEdit(r)} className={`${actionBtn} hover:bg-cream hover:text-ink`}>
                  <Pencil size={15} />
                </button>
                <button title="Delete" onClick={() => onDelete(r)} className={`${actionBtn} hover:bg-bad-soft hover:text-bad`}>
                  <XMark size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {editing != null && (
        <div className="mt-2.5 flex flex-col gap-3.5 rounded-xl border border-line-soft bg-surface p-3.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold text-[13px] leading-none text-ink">
              {editing === "new" ? "New recurring" : "Edit recurring"}
            </span>
            <button onClick={() => setEditing(null)}
                    className="cursor-pointer border-none bg-transparent px-1 py-[2px] font-semibold text-xs leading-none text-faint hover:text-ink">
              Cancel
            </button>
          </div>

          <div className="flex gap-1 rounded-[11px] bg-track p-1">
            <button onClick={() => setKind("expense")} className={seg(draft.kind === "expense")}>Expense</button>
            <button onClick={() => setKind("income")} className={seg(draft.kind === "income")}>Income</button>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="min-w-[140px] flex-[2_1_160px]">
              <div className={`${label} mb-[7px]`}>Name</div>
              <input type="text" placeholder={draft.kind === "expense" ? "Rent, Netflix…" : "Salary…"} value={draft.name}
                     onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${field} h-[42px]`} />
            </div>
            <div className="min-w-[110px] flex-[1_1_110px]">
              <div className={`${label} mb-[7px]`}>Amount ¥</div>
              <input type="text" inputMode="numeric" placeholder="0" value={draft.amount}
                     onChange={(e) => setDraft({ ...draft, amount: e.target.value.replace(/[^0-9]/g, "").slice(0, 9) })}
                     className={`${field} h-[42px]`} />
            </div>
          </div>

          <div>
            <div className={`${label} mb-[9px]`}>Category</div>
            <CatChips cats={draft.kind === "expense" ? CATS : INCOME_CATS} sel={draft.category}
                      onPick={(id) => setDraft({ ...draft, category: id })} />
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="min-w-[74px] flex-[1_1_74px]">
              <div className={`${label} mb-[7px]`}>Day</div>
              <input type="text" inputMode="numeric" value={draft.day}
                     onChange={(e) => setDraft({ ...draft, day: e.target.value.replace(/[^0-9]/g, "").slice(0, 2) })}
                     className={`${field} h-[42px]`} />
            </div>
            <div className="min-w-[126px] flex-[2_1_126px]">
              <div className={`${label} mb-[7px]`}>First month</div>
              <input type="month" value={draft.startMonth}
                     onChange={(e) => setDraft({ ...draft, startMonth: e.target.value })} className={`${field} h-[42px]`} />
            </div>
            <div className="min-w-[126px] flex-[2_1_126px]">
              <div className={`${label} mb-[7px]`}>Last month</div>
              <input type="month" value={draft.endMonth}
                     onChange={(e) => setDraft({ ...draft, endMonth: e.target.value })} className={`${field} h-[42px]`} />
            </div>
          </div>

          <button onClick={save} disabled={!canSave || saving}
                  className={`h-11 w-full rounded-xl border-none font-semibold text-sm leading-none text-white ${canSave && !saving ? "cursor-pointer bg-accent hover:bg-accent-hover active:scale-[.99]" : "cursor-not-allowed bg-[#dad5c7]"}`}>
            {editing === "new" ? "Add recurring" : "Save changes"}
          </button>
          <p className="-mt-1 text-[11.5px] leading-[1.5] text-faint">
            The month’s entries are written up front and count as upcoming until their day (29–31 falls
            back to the last day of shorter months). If an amount differs — like a variable phone bill —
            edit that month’s entry; the rule keeps its usual amount.
          </p>
        </div>
      )}
    </div>
  );
}

function MerchantCard({ d }: { d: MonthData }) {
  return (
    <div className={`${CARD} px-[18px] py-4`}>
      <div className="mb-3 flex items-center gap-[9px]">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cream text-muted">
          <BagYen size={16} />
        </span>
        <h3 className="flex-1 font-semibold text-sm leading-[1.2] text-ink">By merchant</h3>
        <span className="font-medium text-xs leading-none text-faint">{monthLabel(d.month)}</span>
      </div>
      <div className="flex flex-col">
        {d.byMerchant.length ? (
          d.byMerchant.map((m) => {
            const c = catOf(m.category);
            return (
              <div key={m.merchant} className="flex items-center gap-[11px] px-[2px] py-[9px]">
                <span className="h-[9px] w-[9px] flex-none rounded-full" style={{ background: c.color }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-[13.5px] leading-[1.2] text-ink">{m.merchant}</div>
                  <div className="mt-px text-xs leading-[1.3] text-faint">
                    {c.label} · {m.count} {m.count === 1 ? "entry" : "entries"}
                  </div>
                </div>
                <span className="font-semibold text-[13px] leading-none text-ink">{yen(m.total)}</span>
              </div>
            );
          })
        ) : (
          <div className="py-3.5 text-[13px] leading-[1.4] text-faint">Nothing this month.</div>
        )}
      </div>
    </div>
  );
}
