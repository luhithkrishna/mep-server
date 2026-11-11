"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

export default function HomePage() {
  const [tab, setTab] = useState<"inbox" | "parties" | "stock">("inbox");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedMcp, setCopiedMcp] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [form, setForm] = useState({
    type: "purchase",
    party_name: "Shah Textiles",
    item_name: "white cotton",
    qty: "200",
    rate: "300",
    bill_no: "4521",
    paid_amount: "0",
    due_days: "30",
    payment_method: "UPI",
  });

  async function loadData() {
    const res = await fetch("/api/ledger").then((r) => r.json());
    setData(res);
    setLoading(false);
  }

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 4000);
    return () => clearInterval(timer);
  }, []);

  function getEditVal(entry: any, field: string) {
    if (edits[entry.id] && edits[entry.id][field] !== undefined) {
      return edits[entry.id][field];
    }
    return entry[field] ?? "";
  }

  function setEditVal(entryId: string, field: string, value: any) {
    setEdits((prev) => ({
      ...prev,
      [entryId]: { ...(prev[entryId] || {}), [field]: value },
    }));
  }

  async function saveOrConfirm(entry: any, confirm: boolean) {
    setBusyId(entry.id);
    const current = edits[entry.id] || {};
    const payload = {
      action: "update_or_confirm",
      entry_id: entry.id,
      qty: current.qty !== undefined ? Number(current.qty) : entry.qty,
      rate: current.rate !== undefined ? Number(current.rate) : entry.rate,
      paid_amount:
        current.paid_amount !== undefined
          ? Number(current.paid_amount)
          : entry.paid_amount,
      bill_no: current.bill_no !== undefined ? current.bill_no : entry.bill_no,
      payment_method:
        current.payment_method !== undefined
          ? current.payment_method
          : entry.payment_method,
      confirm,
    };
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => r.json());
    if (res.state) setData((prev: any) => ({ ...prev, ...res.state }));
    setBusyId(null);
  }

  async function deleteEntry(entryId: string) {
    setBusyId(entryId);
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_entry", entry_id: entryId }),
    }).then((r) => r.json());
    if (res.state) setData((prev: any) => ({ ...prev, ...res.state }));
    setBusyId(null);
  }

  async function handleResetAll() {
    if (!confirm("Reset all demo bills, parties, and stock to start fresh?")) return;
    setLoading(true);
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset_all" }),
    }).then((r) => r.json());
    if (res.state) setData((prev: any) => ({ ...prev, ...res.state }));
    setLoading(false);
  }

  async function handleQuickAdd(e: React.FormEvent) {
    e.preventDefault();
    await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_draft", ...form }),
    });
    setShowQuickAdd(false);
    await loadData();
  }

  function copyMcpUrl() {
    const url = `${window.location.origin}/api/mcp?key=ravi123`;
    navigator.clipboard.writeText(url);
    setCopiedMcp(true);
    setTimeout(() => setCopiedMcp(false), 2000);
  }

  function copyStatementUrl(token: string) {
    const url = `${window.location.origin}/s/${token}`;
    navigator.clipboard.writeText(url);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2000);
  }

  const drafts = data?.drafts || [];
  const confirmed = data?.confirmed || [];
  const parties = data?.parties || [];
  const stock = data?.stock || [];
  const kpis = data?.kpis || {
    total_payables: 0,
    total_receivables: 0,
    total_stock_value: 0,
    total_profit: 0,
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white pb-24 flex flex-col items-center">
      {/* Top Header */}
      <header className="w-full max-w-md sticky top-0 z-20 bg-slate-950/95 backdrop-blur border-b border-slate-800 px-4 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <h1 className="text-base font-bold tracking-tight">MCP Server</h1>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-semibold">
                No AI Inside
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Claude MCP Textile Ledger • Exact Code Math
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowQuickAdd(!showQuickAdd)}
              className="text-[11px] bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1.5 rounded-lg font-medium cursor-pointer"
            >
              + Draft
            </button>
            <button
              onClick={handleResetAll}
              className="text-[11px] bg-slate-900 hover:bg-rose-950 border border-slate-800 text-slate-400 hover:text-rose-300 px-2 py-1.5 rounded-lg cursor-pointer"
              title="Clear all demo entries"
            >
              Reset
            </button>
            <Link
              href="/login"
              className="text-[11px] text-slate-400 hover:text-white px-1.5 py-1"
            >
              Login
            </Link>
          </div>
        </div>

        {/* 1-Click MCP Connector Bar for Reviewers */}
        <div className="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-xl px-3 py-1.5 text-[11px]">
          <span className="text-slate-400 truncate mr-2">
            MCP: <code className="text-emerald-400">/api/mcp?key=ravi123</code>
          </span>
          <button
            onClick={copyMcpUrl}
            className="bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 px-2.5 py-0.5 rounded-md font-semibold shrink-0 cursor-pointer"
          >
            {copiedMcp ? "✓ Copied!" : "Copy MCP URL"}
          </button>
        </div>
      </header>

      <main className="w-full max-w-md px-4 pt-3 space-y-4">
        {/* 4 Live Scoreboard KPI Cards */}
        <div className="grid grid-cols-4 gap-2">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-2.5">
            <p className="text-[10px] text-slate-400">You Owe</p>
            <p className="text-xs font-extrabold text-amber-400 mt-0.5">
              ₹{Number(kpis.total_payables).toLocaleString("en-IN")}
            </p>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-2.5">
            <p className="text-[10px] text-slate-400">Owed to You</p>
            <p className="text-xs font-extrabold text-sky-400 mt-0.5">
              ₹{Number(kpis.total_receivables).toLocaleString("en-IN")}
            </p>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-2.5">
            <p className="text-[10px] text-slate-400">Stock Value</p>
            <p className="text-xs font-extrabold text-white mt-0.5">
              ₹{Number(kpis.total_stock_value).toLocaleString("en-IN")}
            </p>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-2.5">
            <p className="text-[10px] text-slate-400">Net Profit</p>
            <p className="text-xs font-extrabold text-emerald-400 mt-0.5">
              +₹{Number(kpis.total_profit).toLocaleString("en-IN")}
            </p>
          </div>
        </div>

        {/* Optional Quick Test Draft Creator */}
        {showQuickAdd && (
          <form
            onSubmit={handleQuickAdd}
            className="bg-slate-900 border border-emerald-500/40 rounded-2xl p-4 space-y-3"
          >
            <div className="flex justify-between items-center">
              <span className="text-xs font-bold text-emerald-400 uppercase">
                Simulate Claude MCP Draft
              </span>
              <button
                type="button"
                onClick={() => setShowQuickAdd(false)}
                className="text-xs text-slate-400"
              >
                Close
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {["purchase", "sale", "payment"].map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={() =>
                    setForm({
                      ...form,
                      type: t,
                      party_name: t === "sale" ? "Kiran" : "Shah Textiles",
                      rate: t === "sale" ? "450" : "300",
                      qty: t === "sale" ? "10" : "200",
                      paid_amount:
                        t === "sale" ? "2000" : t === "payment" ? "25000" : "0",
                    })
                  }
                  className={`py-1.5 rounded-lg text-xs font-semibold uppercase border ${
                    form.type === t
                      ? "bg-emerald-500 text-slate-950 border-emerald-400"
                      : "bg-slate-800 text-slate-300 border-slate-700"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                placeholder="Party Name"
                value={form.party_name}
                onChange={(e) => setForm({ ...form, party_name: e.target.value })}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs"
              />
              {form.type !== "payment" && (
                <input
                  placeholder="Item (white cotton)"
                  value={form.item_name}
                  onChange={(e) => setForm({ ...form, item_name: e.target.value })}
                  className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs"
                />
              )}
              {form.type !== "payment" && (
                <input
                  type="number"
                  placeholder="Qty (m)"
                  value={form.qty}
                  onChange={(e) => setForm({ ...form, qty: e.target.value })}
                  className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs"
                />
              )}
              {form.type !== "payment" && (
                <input
                  type="number"
                  placeholder="Rate (₹/m)"
                  value={form.rate}
                  onChange={(e) => setForm({ ...form, rate: e.target.value })}
                  className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs"
                />
              )}
              <input
                type="number"
                placeholder={
                  form.type === "payment" ? "Payment Amount (₹)" : "Paid Now (₹)"
                }
                value={form.paid_amount}
                onChange={(e) => setForm({ ...form, paid_amount: e.target.value })}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs"
              />
              <input
                placeholder="Bill No. (e.g. 4521)"
                value={form.bill_no}
                onChange={(e) => setForm({ ...form, bill_no: e.target.value })}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs"
              />
            </div>
            <button
              type="submit"
              className="w-full bg-emerald-500 text-slate-950 font-bold py-2.5 rounded-xl text-xs cursor-pointer"
            >
              Create Draft in Inbox
            </button>
          </form>
        )}

        {loading && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-xs text-slate-400">
            Loading MCP Server ledger...
          </div>
        )}

        {/* TAB 1: INBOX */}
        {!loading && tab === "inbox" && (
          <div className="space-y-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-amber-400">
                  Drafts Waiting for Review ({drafts.length})
                </h2>
                <span className="text-[11px] text-slate-400">Auto-syncs every 4s</span>
              </div>

              {drafts.length === 0 && (
                <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-5 text-center space-y-1">
                  <p className="text-xs text-slate-300 font-medium">
                    No unconfirmed drafts
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Tell Claude about a purchase, sale, or payment to see it appear live here.
                  </p>
                </div>
              )}

              {drafts.map((d: any) => {
                const editQty = Number(getEditVal(d, "qty")) || 0;
                const editRate = Number(getEditVal(d, "rate")) || 0;
                const editPaid = Number(getEditVal(d, "paid_amount")) || 0;
                const liveTotal =
                  d.type === "payment"
                    ? editPaid
                    : Number((editQty * editRate).toFixed(2));
                const liveUnpaid =
                  d.type === "payment" ? 0 : Number((liveTotal - editPaid).toFixed(2));

                return (
                  <div
                    key={d.id}
                    className="bg-slate-900 border-2 border-amber-500/40 rounded-2xl p-4 space-y-3 shadow-lg"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-300">
                          DRAFT {d.type}
                        </span>
                        <h3 className="text-base font-bold mt-1">
                          {d.party?.name || "Unknown Party"}
                        </h3>
                        {d.item && (
                          <p className="text-xs text-slate-400">
                            Item:{" "}
                            <span className="text-slate-200">{d.item.name}</span> (
                            {d.item.unit})
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-slate-400">Recalculated Total</p>
                        <p className="text-xl font-extrabold text-emerald-400">
                          ₹{liveTotal.toLocaleString("en-IN")}
                        </p>
                        {d.type !== "payment" && (
                          <p className="text-[11px] text-amber-300">
                            Credit / Owed: ₹{liveUnpaid.toLocaleString("en-IN")}
                          </p>
                        )}
                      </div>
                    </div>

                    {d.type !== "payment" ? (
                      <div className="grid grid-cols-2 gap-2.5 pt-1">
                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Quantity ({d.item?.unit || "m"})
                          </label>
                          <input
                            type="number"
                            value={getEditVal(d, "qty")}
                            onChange={(e) => setEditVal(d.id, "qty", e.target.value)}
                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm font-semibold"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Rate (₹/{d.item?.unit || "m"})
                          </label>
                          <input
                            type="number"
                            value={getEditVal(d, "rate")}
                            onChange={(e) => setEditVal(d.id, "rate", e.target.value)}
                            className="w-full bg-slate-950 border border-amber-500/60 rounded-xl px-3 py-2 text-sm font-semibold text-amber-200"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Paid Now (₹)
                          </label>
                          <input
                            type="number"
                            value={getEditVal(d, "paid_amount")}
                            onChange={(e) =>
                              setEditVal(d.id, "paid_amount", e.target.value)
                            }
                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Bill No.
                          </label>
                          <input
                            type="text"
                            value={getEditVal(d, "bill_no")}
                            onChange={(e) => setEditVal(d.id, "bill_no", e.target.value)}
                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2.5 pt-1">
                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Payment Amount (₹)
                          </label>
                          <input
                            type="number"
                            value={getEditVal(d, "paid_amount")}
                            onChange={(e) =>
                              setEditVal(d.id, "paid_amount", e.target.value)
                            }
                            className="w-full bg-slate-950 border border-amber-500/60 rounded-xl px-3 py-2 text-sm font-semibold"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Method (UPI/Cash)
                          </label>
                          <input
                            type="text"
                            value={getEditVal(d, "payment_method")}
                            onChange={(e) =>
                              setEditVal(d.id, "payment_method", e.target.value)
                            }
                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm"
                          />
                        </div>
                      </div>
                    )}

                    <div className="flex gap-2 pt-1">
                      <button
                        disabled={busyId === d.id}
                        onClick={() => saveOrConfirm(d, true)}
                        className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold py-3 rounded-xl text-sm transition cursor-pointer"
                      >
                        {busyId === d.id
                          ? "Posting..."
                          : "✓ Confirm & Post to Ledger"}
                      </button>
                      <button
                        disabled={busyId === d.id}
                        onClick={() => deleteEntry(d.id)}
                        className="px-3 py-3 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 text-xs font-semibold cursor-pointer"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Confirmed Ledger History */}
            <div className="space-y-3 pt-2">
              <h2 className="text-sm font-bold text-slate-300">
                Confirmed Ledger Entries ({confirmed.length})
              </h2>
              {confirmed.length === 0 && (
                <p className="text-xs text-slate-500">
                  Confirmed entries will appear here with exact stock, cost, and profit math.
                </p>
              )}
              {confirmed.map((c: any) => (
                <div
                  key={c.id}
                  className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                        CONFIRMED {c.type}
                      </span>
                      {c.bill_no && (
                        <span className="ml-2 text-xs text-slate-400">
                          Bill #{c.bill_no}
                        </span>
                      )}
                      <h3 className="text-sm font-bold mt-1">{c.party?.name}</h3>
                    </div>
                    <div className="text-right flex items-start gap-2">
                      <div>
                        <p className="text-base font-bold text-white">
                          ₹{Number(c.total_amount).toLocaleString("en-IN")}
                        </p>
                        {c.type !== "payment" && (
                          <p className="text-[11px] text-slate-400">
                            Paid: ₹{Number(c.paid_amount).toLocaleString("en-IN")} • Due: ₹
                            {Number(c.unpaid_amount).toLocaleString("en-IN")}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => deleteEntry(c.id)}
                        title="Delete entry"
                        className="text-xs text-slate-500 hover:text-rose-400 px-1.5 py-0.5 rounded bg-slate-800/60 cursor-pointer"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {c.item && (
                    <p className="text-xs text-slate-300">
                      {c.type === "purchase" ? "+" : "-"}
                      {c.qty} {c.item.unit} {c.item.name} @ ₹{c.rate}/{c.item.unit}
                    </p>
                  )}

                  {c.type === "sale" && (
                    <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                      <div>
                        <span className="text-slate-400 block">Stock</span>
                        <span className="font-bold text-rose-300">
                          -{c.qty} {c.item?.unit || "m"}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block">Avg Cost</span>
                        <span className="font-bold text-slate-200">
                          ₹{Number(c.cost).toLocaleString("en-IN")}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block">Exact Profit</span>
                        <span className="font-bold text-emerald-400">
                          +₹{Number(c.profit).toLocaleString("en-IN")}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 2: PARTIES & LIVE STATEMENT LINKS */}
        {!loading && tab === "parties" && (
          <div className="space-y-3">
            <h2 className="text-sm font-bold text-slate-200">
              Vendor & Customer Balances ({parties.length})
            </h2>
            {parties.length === 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-400">
                No parties yet. Confirm a purchase or sale first.
              </div>
            )}
            {parties.map((p: any) => {
              const statementUrl =
                typeof window !== "undefined"
                  ? `${window.location.origin}/s/${p.statement_token}`
                  : `/s/${p.statement_token}`;
              const waText = encodeURIComponent(
                `Hi ${p.name}, here is your live verified account statement with MCP Server (Balance: ₹${Number(
                  p.balance
                ).toLocaleString("en-IN")}): ${statementUrl}`
              );

              return (
                <div
                  key={p.id}
                  className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                        {p.type}
                      </span>
                      <h3 className="text-base font-bold mt-1">{p.name}</h3>
                      <p className="text-xs text-slate-400">
                        Billed: ₹{Number(p.total_billed).toLocaleString("en-IN")} • Paid: ₹
                        {Number(p.total_paid).toLocaleString("en-IN")}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] text-slate-400">
                        {p.type === "vendor" ? "You Owe" : "Owes You"}
                      </p>
                      <p className="text-xl font-extrabold text-emerald-400">
                        ₹{Number(p.balance).toLocaleString("en-IN")}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <Link
                      href={`/s/${p.statement_token}`}
                      target="_blank"
                      className="text-center bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 font-bold py-2 rounded-xl text-xs"
                    >
                      Open Live ↗
                    </Link>
                    <button
                      onClick={() => copyStatementUrl(p.statement_token)}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold py-2 rounded-xl text-xs cursor-pointer"
                    >
                      {copiedToken === p.statement_token ? "✓ Copied" : "Copy Link"}
                    </button>
                    <a
                      href={`https://wa.me/?text=${waText}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-center bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 font-semibold py-2 rounded-xl text-xs"
                    >
                      WhatsApp
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* TAB 3: STOCK & WEIGHTED-AVERAGE COST */}
        {!loading && tab === "stock" && (
          <div className="space-y-3">
            <h2 className="text-sm font-bold text-slate-200">
              Live Cloth Stock & Weighted-Avg Cost ({stock.length})
            </h2>
            {stock.length === 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-400">
                No stock items yet. Confirm a purchase to see live stock.
              </div>
            )}
            {stock.map((s: any) => (
              <div
                key={s.item_id}
                className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex justify-between items-center"
              >
                <div>
                  <h3 className="text-base font-bold capitalize">{s.name}</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    In: {s.purchased_qty} {s.unit} • Sold: {s.sold_qty} {s.unit}
                  </p>
                  <p className="text-xs text-emerald-400 font-semibold mt-1">
                    Weighted-Avg Cost: ₹{s.avg_cost}/{s.unit}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-extrabold text-white">
                    {s.stock_qty}{" "}
                    <span className="text-sm font-normal text-slate-400">
                      {s.unit}
                    </span>
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Value: ₹
                    {Number((s.stock_qty * s.avg_cost).toFixed(0)).toLocaleString(
                      "en-IN"
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 bg-slate-900/95 backdrop-blur border-t border-slate-800 flex justify-center">
        <div className="w-full max-w-md grid grid-cols-3 py-2 px-4 gap-2">
          <button
            onClick={() => setTab("inbox")}
            className={`py-2.5 rounded-xl text-xs font-bold cursor-pointer ${
              tab === "inbox"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Inbox ({drafts.length})
          </button>
          <button
            onClick={() => setTab("parties")}
            className={`py-2.5 rounded-xl text-xs font-bold cursor-pointer ${
              tab === "parties"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Parties ({parties.length})
          </button>
          <button
            onClick={() => setTab("stock")}
            className={`py-2.5 rounded-xl text-xs font-bold cursor-pointer ${
              tab === "stock"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Stock ({stock.length})
          </button>
        </div>
      </nav>
    </div>
  );
}
