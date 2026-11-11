"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

export default function HomePage() {
  const [tab, setTab] = useState<"inbox" | "parties" | "stock" | "insights">("inbox");
  const [inboxSubTab, setInboxSubTab] = useState<"all" | "sales" | "purchases" | "payments">("all");
  const [partySubTab, setPartySubTab] = useState<"vendors" | "customers">("vendors");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [showDevTools, setShowDevTools] = useState(false);
  const [copiedMcp, setCopiedMcp] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [invoiceEntry, setInvoiceEntry] = useState<any>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [localAcks, setLocalAcks] = useState<Record<string, any>>({});

  // Multi-item manual entry form state
  const [formType, setFormType] = useState<"purchase" | "sale" | "payment">("purchase");
  const [partyName, setPartyName] = useState("Sai Ram Textile");
  const [paidAmount, setPaidAmount] = useState("8000");
  const [billNo, setBillNo] = useState("SR-99");
  const [dueDays, setDueDays] = useState("30");
  const [paymentMethod, setPaymentMethod] = useState("UPI");
  const [itemsList, setItemsList] = useState([
    { item_name: "sarees", unit: "pcs", qty: "50", total_price: "10000", rate: "200" },
    { item_name: "jeans", unit: "pcs", qty: "150", total_price: "12000", rate: "80" },
    { item_name: "jacket bit", unit: "m", qty: "80", total_price: "4000", rate: "50" },
  ]);

  async function loadData() {
    const res = await fetch("/api/ledger").then((r) => r.json());
    setData(res);
    setLoading(false);
    if (typeof window !== "undefined" && res?.parties) {
      const ackMap: Record<string, any> = {};
      for (const p of res.parties) {
        const saved = localStorage.getItem(`mcp_ack_${p.statement_token}`);
        if (saved) { try { ackMap[p.statement_token] = JSON.parse(saved); } catch {} }
      }
      setLocalAcks(ackMap);
    }
  }

  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsAdmin(localStorage.getItem("mcp_admin_auth") === "true");
    }
    loadData();
    const timer = setInterval(loadData, 4000);
    return () => clearInterval(timer);
  }, []);

  function updateItemRow(index: number, field: string, value: any) {
    const updated = [...itemsList];
    updated[index] = { ...updated[index], [field]: value };
    
    // Auto-adjust rate or total price dynamically
    const qty = Number(updated[index].qty) || 0;
    if (field === "total_price" && qty > 0) {
      const tot = Number(value) || 0;
      updated[index].rate = (tot / qty).toFixed(2);
    } else if ((field === "rate" || field === "qty") && qty > 0) {
      const rate = Number(updated[index].rate) || 0;
      updated[index].total_price = (qty * rate).toFixed(2);
    }
    setItemsList(updated);
  }

  function addItemRow() {
    setItemsList([...itemsList, { item_name: "", unit: "pcs", qty: "1", total_price: "100", rate: "100" }]);
  }

  function removeItemRow(index: number) {
    if (itemsList.length === 1) return;
    setItemsList(itemsList.filter((_, i) => i !== index));
  }

  async function handleQuickAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!isAdmin) return;
    const payload = {
      action: "create_draft",
      type: formType,
      party_name: partyName,
      paid_amount: paidAmount,
      bill_no: billNo,
      due_days: dueDays,
      payment_method: paymentMethod,
      items: itemsList.map(it => ({
        item_name: it.item_name,
        unit: it.unit,
        qty: Number(it.qty) || 1,
        rate: Number(it.rate) || 0
      }))
    };

    await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setShowQuickAdd(false);
    await loadData();
  }

  async function deleteEntry(entryId: string) {
    if (!isAdmin) return;
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_entry", entry_id: entryId }),
    }).then((r) => r.json());
    if (res.state) setData((prev: any) => ({ ...prev, ...res.state }));
  }

  async function confirmEntry(entryId: string) {
    if (!isAdmin) return;
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_or_confirm", entry_id: entryId, confirm: true }),
    }).then((r) => r.json());
    if (res.state) setData((prev: any) => ({ ...prev, ...res.state }));
  }

  async function handleResetAll() {
    if (!isAdmin) return;
    if (!confirm("Reset all data?")) return;
    setLoading(true);
    setShowAdminModal(false);
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset_all" }),
    }).then((r) => r.json());
    if (res.state) setData((prev: any) => ({ ...prev, ...res.state }));
    setLoading(false);
  }

  async function handleSeedDemo() {
    if (!isAdmin) return;
    setLoading(true);
    setShowAdminModal(false);
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "seed_demo" }),
    }).then((r) => r.json());
    if (res.state) setData((prev: any) => ({ ...prev, ...res.state }));
    setLoading(false);
  }

  function handleLogout() {
    if (typeof window !== "undefined") localStorage.removeItem("mcp_admin_auth");
    setIsAdmin(false);
    setShowAdminModal(false);
    setShowQuickAdd(false);
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
  const kpis = data?.kpis || { total_payables: 0, total_receivables: 0, total_stock_value: 0, total_profit: 0, total_cash_collected: 0, deadstock_value: 0 };

  const vendorsList = parties.filter((p: any) => p.type === "vendor");
  const customersList = parties.filter((p: any) => p.type === "customer").sort((a: any, b: any) => b.total_profit - a.total_profit);
  const deadOrSlowStock = stock.filter((s: any) => s.stock_status === "DEADSTOCK" || s.stock_status === "SLOW_MOVING");

  const filteredConfirmed = confirmed.filter((c: any) => {
    if (inboxSubTab === "sales") return c.type === "sale";
    if (inboxSubTab === "purchases") return c.type === "purchase";
    if (inboxSubTab === "payments") return c.type === "payment";
    return true;
  });

  const totalSalesRevenue = confirmed.filter((c: any) => c.type === "sale").reduce((acc: number, c: any) => acc + c.total_amount, 0);
  const totalSalesProfit = confirmed.filter((c: any) => c.type === "sale").reduce((acc: number, c: any) => acc + c.profit, 0);

  return (
    <div className="min-h-screen bg-slate-950 text-white pb-24 flex flex-col items-center">
      <header className="w-full max-w-md sticky top-0 z-20 bg-slate-950/95 backdrop-blur border-b border-slate-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <h1 className="text-base font-bold tracking-tight">MCP Server</h1>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-semibold">
                No AI Inside
              </span>
            </div>
            <p className="text-[11px] text-slate-400">Claude MCP Textile Ledger • Exact Code Math</p>
          </div>

          {isAdmin ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShowQuickAdd(!showQuickAdd)}
                className="text-[11px] bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1.5 rounded-xl font-semibold cursor-pointer"
              >
                + Entry
              </button>
              <button
                onClick={() => setShowAdminModal(true)}
                className="text-[11px] bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 px-2.5 py-1.5 rounded-xl font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                Ravi (Admin) ⚙️
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 font-medium">👁️ Read-Only</span>
              <Link href="/login" className="text-[11px] bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold px-3 py-1.5 rounded-xl transition">
                🔒 Sign In
              </Link>
            </div>
          )}
        </div>
      </header>

      <main className="w-full max-w-md px-4 pt-3 space-y-4">
        {!isAdmin && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between text-xs">
            <div className="pr-2">
              <p className="font-semibold text-slate-200">🔒 Guest Read-Only Mode</p>
              <p className="text-[11px] text-slate-400">Sign in as Admin to confirm drafts or manage shop keys.</p>
            </div>
            <Link href="/login" className="shrink-0 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-emerald-300 font-bold px-3 py-1.5 rounded-lg text-[11px]">
              Admin Login →
            </Link>
          </div>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-4 gap-2">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-2.5">
            <p className="text-[10px] text-slate-400">You Owe</p>
            <p className="text-xs font-extrabold text-amber-400 mt-0.5">₹{Number(kpis.total_payables).toLocaleString("en-IN")}</p>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-2.5">
            <p className="text-[10px] text-slate-400">Owed to You</p>
            <p className="text-xs font-extrabold text-sky-400 mt-0.5">₹{Number(kpis.total_receivables).toLocaleString("en-IN")}</p>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-2.5">
            <p className="text-[10px] text-slate-400">Stock Value</p>
            <p className="text-xs font-extrabold text-white mt-0.5">₹{Number(kpis.total_stock_value).toLocaleString("en-IN")}</p>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-2.5">
            <p className="text-[10px] text-slate-400">Booked Profit</p>
            <p className="text-xs font-extrabold text-emerald-400 mt-0.5">+₹{Number(kpis.total_profit).toLocaleString("en-IN")}</p>
          </div>
        </div>

        {/* Multi-Item Manual Entry Form */}
        {isAdmin && showQuickAdd && (
          <form onSubmit={handleQuickAdd} className="bg-slate-900 border border-emerald-500/40 rounded-2xl p-4 space-y-3 shadow-xl">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-xs font-bold text-emerald-400 uppercase block">Multi-Item Draft Entry</span>
                <span className="text-[11px] text-slate-400">Add multiple items (sarees, jeans, shirts) under one bill.</span>
              </div>
              <button type="button" onClick={() => setShowQuickAdd(false)} className="text-xs text-slate-400 hover:text-white px-2 py-0.5 cursor-pointer">
                Close ✕
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {(["purchase", "sale", "payment"] as const).map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={() => setFormType(t)}
                  className={`py-1.5 rounded-lg text-xs font-semibold uppercase border cursor-pointer ${
                    formType === t ? "bg-emerald-500 text-slate-950 border-emerald-400" : "bg-slate-800 text-slate-300 border-slate-700"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Party Name</label>
                <input
                  value={partyName}
                  onChange={(e) => setPartyName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Paid Upfront Now (₹)</label>
                <input
                  type="number"
                  value={paidAmount}
                  onChange={(e) => setPaidAmount(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-emerald-300"
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Bill No.</label>
                <input
                  value={billNo}
                  onChange={(e) => setBillNo(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-white"
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Due (Days)</label>
                <input
                  type="number"
                  value={dueDays}
                  onChange={(e) => setDueDays(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-white"
                />
              </div>
            </div>

            {/* Dynamic Items List */}
            {formType !== "payment" && (
              <div className="space-y-2.5 pt-2 border-t border-slate-800">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold text-slate-300">Bill Items</span>
                  <button
                    type="button"
                    onClick={addItemRow}
                    className="text-[11px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2.5 py-1 rounded-lg font-bold cursor-pointer"
                  >
                    + Add Another Item
                  </button>
                </div>

                {itemsList.map((it, idx) => (
                  <div key={idx} className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2 relative">
                    <div className="flex gap-2">
                      <input
                        placeholder="Item name (e.g. sarees)"
                        value={it.item_name}
                        onChange={(e) => updateItemRow(idx, "item_name", e.target.value)}
                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white"
                      />
                      <select
                        value={it.unit}
                        onChange={(e) => updateItemRow(idx, "unit", e.target.value)}
                        className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-amber-300 font-semibold cursor-pointer"
                      >
                        <option value="pcs">Pieces (pcs)</option>
                        <option value="m">Meters (m)</option>
                      </select>
                      {itemsList.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItemRow(idx)}
                          className="text-xs text-rose-400 hover:text-rose-300 px-1.5 cursor-pointer"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="text-[10px] text-slate-400 block">Quantity</label>
                        <input
                          type="number"
                          value={it.qty}
                          onChange={(e) => updateItemRow(idx, "qty", e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-400 block">Total Price (₹)</label>
                        <input
                          type="number"
                          value={it.total_price}
                          onChange={(e) => updateItemRow(idx, "total_price", e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-emerald-300 font-semibold"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-400 block">Rate / Unit (₹)</label>
                        <input
                          type="number"
                          value={it.rate}
                          onChange={(e) => updateItemRow(idx, "rate", e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-amber-200"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button type="submit" className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold py-2.5 rounded-xl text-xs cursor-pointer transition">
              + Save Multi-Item Draft to Inbox
            </button>
          </form>
        )}

        {loading && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-xs text-slate-400">Loading ledger...</div>
        )}

        {/* TAB 1: INBOX */}
        {!loading && tab === "inbox" && (
          <div className="space-y-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-amber-400">Drafts Waiting for Review ({drafts.length})</h2>
              </div>

              {drafts.length === 0 && (
                <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-5 text-center space-y-1">
                  <p className="text-xs text-slate-300 font-medium">No unconfirmed drafts</p>
                  <p className="text-[11px] text-slate-400">Tell Claude or use + Entry to queue a draft.</p>
                </div>
              )}

              {drafts.map((d: any) => {
                const draftTotal = d.lines?.reduce((acc: number, l: any) => acc + Number(l.qty) * Number(l.rate), 0) || d.total_amount;
                const draftUnpaid = d.type === "payment" ? 0 : Number((draftTotal - Number(d.paid_amount)).toFixed(2));

                return (
                  <div key={d.id} className="bg-slate-900 border-2 border-amber-500/40 rounded-2xl p-4 space-y-3 shadow-lg">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-300">
                          DRAFT {d.type}
                        </span>
                        <h3 className="text-base font-bold mt-1">{d.party?.name}</h3>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-slate-400">Total Bill</p>
                        <p className="text-xl font-extrabold text-emerald-400">₹{Number(draftTotal).toLocaleString("en-IN")}</p>
                        <p className="text-[11px] text-amber-300">Credit / Owed: ₹{draftUnpaid.toLocaleString("en-IN")}</p>
                      </div>
                    </div>

                    <div className="space-y-1.5 bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                      <p className="text-[11px] text-slate-400 font-semibold">Bill Items:</p>
                      {d.lines?.map((l: any, i: number) => (
                        <div key={i} className="flex justify-between text-xs text-slate-200">
                          <span className="capitalize">• {l.qty} {l.item?.unit || "m"} {l.item?.name}</span>
                          <span className="font-bold text-amber-200">₹{Number(l.qty) * Number(l.rate)} (@₹{l.rate})</span>
                        </div>
                      ))}
                    </div>

                    {isAdmin ? (
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={() => confirmEntry(d.id)}
                          className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold py-2.5 rounded-xl text-sm transition cursor-pointer"
                        >
                          ✓ Confirm & Post to Ledger
                        </button>
                        <button
                          onClick={() => deleteEntry(d.id)}
                          className="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 text-xs font-semibold cursor-pointer"
                        >
                          Discard
                        </button>
                      </div>
                    ) : (
                      <Link href="/login" className="block w-full text-center bg-slate-800 text-amber-300 font-bold py-2 rounded-xl text-xs">
                        🔒 Sign In as Admin to Confirm
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Confirmed History */}
            <div className="space-y-3 pt-2">
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-bold text-slate-300">Confirmed Ledger Entries ({filteredConfirmed.length})</h2>
                <div className="grid grid-cols-4 gap-1.5 bg-slate-900 p-1.5 rounded-xl border border-slate-800">
                  <button onClick={() => setInboxSubTab("all")} className={`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer ${inboxSubTab === "all" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}>All</button>
                  <button onClick={() => setInboxSubTab("sales")} className={`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer ${inboxSubTab === "sales" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}>Sales</button>
                  <button onClick={() => setInboxSubTab("purchases")} className={`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer ${inboxSubTab === "purchases" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}>Purchases</button>
                  <button onClick={() => setInboxSubTab("payments")} className={`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer ${inboxSubTab === "payments" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}>Payments</button>
                </div>
              </div>

              {filteredConfirmed.map((c: any) => (
                <div key={c.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2.5">
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300">CONFIRMED {c.type}</span>
                      <h3 className="text-sm font-bold mt-1">{c.party?.name}</h3>
                    </div>
                    <div className="text-right flex items-start gap-2">
                      <div>
                        <p className="text-base font-bold text-white">₹{Number(c.total_amount).toLocaleString("en-IN")}</p>
                        <p className="text-[11px] text-slate-400">Paid: ₹{Number(c.paid_amount).toLocaleString("en-IN")} • Due: ₹{Number(c.unpaid_amount).toLocaleString("en-IN")}</p>
                      </div>
                      {isAdmin && (
                        <button onClick={() => deleteEntry(c.id)} className="text-xs text-slate-500 hover:text-rose-400 px-1.5 py-0.5 rounded bg-slate-800 cursor-pointer">✕</button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1 bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                    {c.lines?.map((l: any, i: number) => (
                      <div key={i} className="flex justify-between text-xs text-slate-300">
                        <span className="capitalize">{l.qty} {l.item?.unit || "m"} {l.item?.name} @ ₹{l.rate}</span>
                        <span className="font-bold text-white">₹{Number(l.qty) * Number(l.rate)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="pt-1 flex justify-between items-center text-[11px] text-slate-500">
                    <span>{new Date(c.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                    <button onClick={() => setInvoiceEntry(c)} className="bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1 rounded-lg cursor-pointer">📄 View Invoice</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 2: PARTIES */}
        {!loading && tab === "parties" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 bg-slate-900 p-1.5 rounded-xl border border-slate-800">
              <button onClick={() => setPartySubTab("vendors")} className={`py-2 rounded-lg text-xs font-bold cursor-pointer ${partySubTab === "vendors" ? "bg-amber-500 text-slate-950" : "text-slate-400"}`}>
                📦 Vendors You Owe ({vendorsList.length})
              </button>
              <button onClick={() => setPartySubTab("customers")} className={`py-2 rounded-lg text-xs font-bold cursor-pointer ${partySubTab === "customers" ? "bg-sky-500 text-slate-950" : "text-slate-400"}`}>
                🛍️ Customers Who Owe ({customersList.length})
              </button>
            </div>

            {partySubTab === "vendors" ? (
              <div className="space-y-3 pt-1">
                {vendorsList.map((p: any) => {
                  const statementUrl = `${window.location.origin}/s/${p.statement_token}`;
                  const waText = encodeURIComponent(`Hi ${p.name}, here is your live statement (Balance: ₹${p.balance}): ${statementUrl}`);
                  return (
                    <div key={p.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                      <div className="flex justify-between items-start">
                        <div>
                          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-amber-500/15 text-amber-300">VENDOR</span>
                          <h3 className="text-base font-bold mt-1">{p.name}</h3>
                        </div>
                        <div className="text-right">
                          <p className="text-[11px] text-slate-400">You Owe (Payable)</p>
                          <p className="text-xl font-extrabold text-amber-400">₹{Number(p.balance).toLocaleString("en-IN")}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <Link href={`/s/${p.statement_token}`} target="_blank" className="text-center bg-emerald-500/15 text-emerald-300 font-bold py-2 rounded-xl text-xs">Open Live ↗</Link>
                        <button onClick={() => copyStatementUrl(p.statement_token)} className="bg-slate-800 text-slate-200 py-2 rounded-xl text-xs cursor-pointer">Copy Link</button>
                        <a href={`https://wa.me/?text=${waText}`} target="_blank" rel="noreferrer" className="text-center bg-emerald-600/20 text-emerald-300 py-2 rounded-xl text-xs">WhatsApp</a>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                {customersList.map((p: any) => {
                  const statementUrl = `${window.location.origin}/s/${p.statement_token}`;
                  const waText = encodeURIComponent(`Hi ${p.name}, statement link: ${statementUrl}`);
                  return (
                    <div key={p.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                      <div className="flex justify-between items-start">
                        <div>
                          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-sky-500/15 text-sky-300">CUSTOMER</span>
                          <h3 className="text-base font-bold mt-1">{p.name}</h3>
                        </div>
                        <div className="text-right">
                          <p className="text-[11px] text-slate-400">Owes You</p>
                          <p className="text-xl font-extrabold text-sky-400">₹{Number(p.balance).toLocaleString("en-IN")}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <Link href={`/s/${p.statement_token}`} target="_blank" className="text-center bg-emerald-500/15 text-emerald-300 font-bold py-2 rounded-xl text-xs">Open Live ↗</Link>
                        <button onClick={() => copyStatementUrl(p.statement_token)} className="bg-slate-800 text-slate-200 py-2 rounded-xl text-xs cursor-pointer">Copy Link</button>
                        <a href={`https://wa.me/?text=${waText}`} target="_blank" rel="noreferrer" className="text-center bg-emerald-600/20 text-emerald-300 py-2 rounded-xl text-xs">WhatsApp</a>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: STOCK */}
        {!loading && tab === "stock" && (
          <div className="space-y-3">
            <h2 className="text-sm font-bold text-slate-200">Stock & Velocity ({stock.length})</h2>
            {stock.map((s: any) => (
              <div key={s.item_id} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-base font-bold capitalize">{s.name}</h3>
                    <p className="text-xs text-emerald-400">Avg Cost: ₹{s.avg_cost}/{s.unit}</p>
                  </div>
                  <p className="text-2xl font-extrabold text-white">{s.stock_qty} <span className="text-sm font-normal text-slate-400">{s.unit}</span></p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* TAB 4: INSIGHTS */}
        {!loading && tab === "insights" && (
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
              <h2 className="text-sm font-bold text-emerald-400">Profit & Cash Overview</h2>
              <div className="grid grid-cols-2 gap-2.5">
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
                  <p className="text-[11px] text-slate-400">Total Booked Profit</p>
                  <p className="text-lg font-extrabold text-emerald-400 mt-0.5">+₹{Number(kpis.total_profit).toLocaleString("en-IN")}</p>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
                  <p className="text-[11px] text-slate-400">Cash Collected</p>
                  <p className="text-lg font-extrabold text-sky-400 mt-0.5">₹{Number(kpis.total_cash_collected).toLocaleString("en-IN")}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Admin Modal */}
      {isAdmin && showAdminModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
            <div className="flex justify-between items-start border-b border-slate-800 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">● Admin Active</span>
                <h3 className="text-base font-bold mt-1">Ravi — Controls</h3>
              </div>
              <button onClick={() => setShowAdminModal(false)} className="text-slate-400 hover:text-white text-sm px-2 py-1 cursor-pointer">✕</button>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 block">MCP Connector URL</label>
              <div className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs">
                <code className="text-emerald-400 truncate mr-2">/api/mcp?key=ravi123</code>
                <button onClick={copyMcpUrl} className="bg-emerald-500 text-slate-950 font-bold px-2.5 py-1 rounded-lg text-[11px] shrink-0 cursor-pointer">
                  {copiedMcp ? "✓" : "Copy"}
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={handleSeedDemo} className="bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold py-2 rounded-xl text-xs cursor-pointer">⚡ Seed Demo</button>
              <button onClick={handleResetAll} className="bg-rose-950/60 border border-rose-800 text-rose-300 font-bold py-2 rounded-xl text-xs cursor-pointer">🗑️ Reset</button>
            </div>
            <button onClick={handleLogout} className="w-full bg-slate-800 hover:bg-rose-950 text-slate-300 font-semibold py-2.5 rounded-xl text-xs cursor-pointer">Sign Out</button>
          </div>
        </div>
      )}

      {/* Invoice Modal */}
      {invoiceEntry && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
            <div className="flex justify-between items-start border-b border-slate-800 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">INVOICE</span>
                <h3 className="text-lg font-bold mt-1">MCP Server Textiles</h3>
              </div>
              <button onClick={() => setInvoiceEntry(null)} className="text-slate-400 hover:text-white text-sm px-2 py-1">✕</button>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-slate-400">Party:</span><span className="font-bold text-white">{invoiceEntry.party?.name}</span></div>
              <div className="space-y-1 pt-2 border-t border-slate-800">
                {invoiceEntry.lines?.map((l: any, i: number) => (
                  <div key={i} className="flex justify-between">
                    <span>{l.qty} {l.item?.unit} {l.item?.name} @ ₹{l.rate}</span>
                    <span className="font-bold">₹{Number(l.qty) * Number(l.rate)}</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between pt-2 border-t border-slate-800 text-sm font-extrabold">
                <span>Total:</span><span>₹{invoiceEntry.total_amount}</span>
              </div>
            </div>
            <button onClick={() => window.print()} className="w-full bg-emerald-500 text-slate-950 font-bold py-2.5 rounded-xl text-xs cursor-pointer">🖨️ Print / PDF</button>
          </div>
        </div>
      )}

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 bg-slate-900/95 backdrop-blur border-t border-slate-800 flex justify-center">
        <div className="w-full max-w-md grid grid-cols-4 py-2 px-3 gap-1.5">
          <button onClick={() => setTab("inbox")} className={`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer ${tab === "inbox" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}>Inbox ({drafts.length})</button>
          <button onClick={() => setTab("parties")} className={`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer ${tab === "parties" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}>Parties ({parties.length})</button>
          <button onClick={() => setTab("stock")} className={`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer ${tab === "stock" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}>Stock ({stock.length})</button>
          <button onClick={() => setTab("insights")} className={`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer ${tab === "insights" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}>Insights 📊</button>
        </div>
      </nav>
    </div>
  );
}
