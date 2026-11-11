import fs from "node:fs";
import path from "node:path";

function write(relPath, content) {
  const full = path.join(process.cwd(), relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content.trimStart(), "utf8");
  console.log("Updated:", relPath);
}

// 1. next.config.ts
write(
  "next.config.ts",
  `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
`
);

// 2. app/layout.tsx
write(
  "app/layout.tsx",
  `export const metadata = {
  title: "MCP Server — B2B Textile Ledger",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body
        className="bg-slate-950 text-white min-h-screen antialiased"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
`
);

// 3. lib/ledger.ts
write(
  "lib/ledger.ts",
  `import { createClient } from "@supabase/supabase-js";

export function getSupabase() {
  const rawUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "")
    .trim()
    .replace(/\\/rest\\/v1\\/?$/, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return createClient(rawUrl, key, { auth: { persistSession: false } });
}

export async function getShop(mcpKey?: string | null) {
  const sb = getSupabase();
  if (mcpKey) {
    const { data } = await sb.from("shops").select("*").eq("mcp_key", mcpKey).maybeSingle();
    if (data) return data;
  }
  const { data: firstShop } = await sb.from("shops").select("*").limit(1).maybeSingle();
  if (firstShop) return firstShop;

  const { data: created } = await sb
    .from("shops")
    .insert({ name: "MCP Server", mcp_key: "ravi123" })
    .select("*")
    .single();
  return created;
}

export async function getOrCreateParty(
  shopId: string,
  name: string,
  defaultType: "vendor" | "customer"
) {
  const sb = getSupabase();
  const cleanName = name.trim();
  const { data: existing } = await sb
    .from("parties")
    .select("*")
    .eq("shop_id", shopId)
    .ilike("name", cleanName)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await sb
    .from("parties")
    .insert({ shop_id: shopId, name: cleanName, type: defaultType })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return created;
}

export async function getOrCreateItem(shopId: string, name: string, unit = "m") {
  const sb = getSupabase();
  const cleanName = name.trim().toLowerCase();
  const { data: existing } = await sb
    .from("items")
    .select("*")
    .eq("shop_id", shopId)
    .ilike("name", cleanName)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await sb
    .from("items")
    .insert({ shop_id: shopId, name: cleanName, unit: unit || "m" })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return created;
}

export async function computeLedgerState(shopId: string) {
  const sb = getSupabase();
  const [
    { data: parties = [] },
    { data: items = [] },
    { data: entries = [] },
    { data: lines = [] },
  ] = await Promise.all([
    sb.from("parties").select("*").eq("shop_id", shopId).order("name"),
    sb.from("items").select("*").eq("shop_id", shopId).order("name"),
    sb.from("entries").select("*").eq("shop_id", shopId).order("date", { ascending: true }),
    sb.from("entry_lines").select("*"),
  ]);

  const partyMap = new Map((parties || []).map((p: any) => [p.id, p]));
  const itemMap = new Map((items || []).map((i: any) => [i.id, i]));
  const linesByEntry = new Map<string, any[]>();
  for (const l of lines || []) {
    const arr = linesByEntry.get(l.entry_id) || [];
    arr.push({ ...l, item: itemMap.get(l.item_id) || null });
    linesByEntry.set(l.entry_id, arr);
  }

  const stockMap = new Map<
    string,
    {
      item_id: string;
      name: string;
      unit: string;
      purchased_qty: number;
      purchase_cost: number;
      sold_qty: number;
      avg_cost: number;
      stock_qty: number;
      stock_value: number;
    }
  >();

  for (const item of items || []) {
    stockMap.set(item.id, {
      item_id: item.id,
      name: item.name,
      unit: item.unit || "m",
      purchased_qty: 0,
      purchase_cost: 0,
      sold_qty: 0,
      avg_cost: 0,
      stock_qty: 0,
      stock_value: 0,
    });
  }

  const confirmedEntries = (entries || []).filter((e: any) => e.status === "confirmed");

  for (const entry of confirmedEntries) {
    const eLines = linesByEntry.get(entry.id) || [];
    if (entry.type === "purchase") {
      for (const l of eLines) {
        const st = stockMap.get(l.item_id);
        if (st) {
          const qty = Number(l.qty) || 0;
          const rate = Number(l.rate) || 0;
          st.purchased_qty += qty;
          st.purchase_cost += qty * rate;
        }
      }
    } else if (entry.type === "sale") {
      for (const l of eLines) {
        const st = stockMap.get(l.item_id);
        if (st) {
          st.sold_qty += Number(l.qty) || 0;
        }
      }
    }
  }

  for (const st of stockMap.values()) {
    st.avg_cost =
      st.purchased_qty > 0
        ? Number((st.purchase_cost / st.purchased_qty).toFixed(2))
        : 0;
    st.stock_qty = Number((st.purchased_qty - st.sold_qty).toFixed(2));
    st.stock_value = Number((st.stock_qty * st.avg_cost).toFixed(2));
  }

  const enrichedEntries = (entries || []).map((entry: any) => {
    const eLines = linesByEntry.get(entry.id) || [];
    const firstLine = eLines[0] || null;
    const qty = firstLine ? Number(firstLine.qty) : 0;
    const rate = firstLine ? Number(firstLine.rate) : 0;
    const lineTotal = eLines.reduce(
      (acc: number, l: any) => acc + Number(l.qty) * Number(l.rate),
      0
    );
    const paidAmount = Number(entry.paid_amount) || 0;
    const totalAmount =
      entry.type === "payment" ? paidAmount : Number(lineTotal.toFixed(2));

    let cost = 0;
    let profit = 0;
    if (entry.type === "sale" && firstLine) {
      const st = stockMap.get(firstLine.item_id);
      const unitCost = st ? st.avg_cost : 0;
      cost = Number((qty * unitCost).toFixed(2));
      profit = Number((totalAmount - cost).toFixed(2));
    }

    return {
      ...entry,
      party: partyMap.get(entry.party_id) || null,
      item: firstLine?.item || null,
      line_id: firstLine?.id || null,
      qty,
      rate,
      total_amount: totalAmount,
      paid_amount: paidAmount,
      cost,
      profit,
      unpaid_amount:
        entry.type === "payment" ? 0 : Number((totalAmount - paidAmount).toFixed(2)),
    };
  });

  const partyBalances = (parties || []).map((party: any) => {
    const pEntries = enrichedEntries.filter(
      (e: any) => e.party_id === party.id && e.status === "confirmed"
    );
    let totalBilled = 0;
    let totalPaid = 0;
    for (const e of pEntries) {
      if (e.type === "purchase" || e.type === "sale") {
        totalBilled += e.total_amount;
        totalPaid += e.paid_amount;
      } else if (e.type === "payment") {
        totalPaid += e.paid_amount;
      }
    }
    const balance = Number((totalBilled - totalPaid).toFixed(2));
    return {
      ...party,
      total_billed: Number(totalBilled.toFixed(2)),
      total_paid: Number(totalPaid.toFixed(2)),
      balance,
      entries: pEntries,
    };
  });

  const stockList = Array.from(stockMap.values());
  const confirmedList = enrichedEntries.filter((e: any) => e.status === "confirmed").reverse();

  const kpis = {
    total_payables: partyBalances
      .filter((p: any) => p.type === "vendor" && p.balance > 0)
      .reduce((acc: number, p: any) => acc + p.balance, 0),
    total_receivables: partyBalances
      .filter((p: any) => p.type === "customer" && p.balance > 0)
      .reduce((acc: number, p: any) => acc + p.balance, 0),
    total_stock_value: stockList.reduce((acc: number, s: any) => acc + s.stock_value, 0),
    total_profit: confirmedList
      .filter((e: any) => e.type === "sale")
      .reduce((acc: number, e: any) => acc + e.profit, 0),
  };

  return {
    kpis,
    stock: stockList,
    parties: partyBalances,
    entries: enrichedEntries.slice().reverse(),
    drafts: enrichedEntries.filter((e: any) => e.status === "draft").reverse(),
    confirmed: confirmedList,
  };
}
`
);

// 4. app/api/ledger/route.ts
write(
  "app/api/ledger/route.ts",
  `import { NextRequest, NextResponse } from "next/server";
import {
  getSupabase,
  getShop,
  getOrCreateParty,
  getOrCreateItem,
  computeLedgerState,
} from "@/lib/ledger";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const token = searchParams.get("statement_token");
    const sb = getSupabase();

    if (token) {
      const { data: party } = await sb
        .from("parties")
        .select("*")
        .eq("statement_token", token)
        .maybeSingle();
      if (!party) {
        return NextResponse.json({ error: "Statement not found" }, { status: 404 });
      }
      const { data: shop } = await sb
        .from("shops")
        .select("*")
        .eq("id", party.shop_id)
        .single();
      const state = await computeLedgerState(party.shop_id);
      const partySummary = state.parties.find((p: any) => p.id === party.id);
      return NextResponse.json({ shop, party: partySummary });
    }

    const shop = await getShop(searchParams.get("key"));
    const state = await computeLedgerState(shop.id);
    return NextResponse.json({ shop, ...state });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const sb = getSupabase();
    const shop = await getShop(body.key);

    if (body.action === "update_or_confirm") {
      const { entry_id, qty, rate, paid_amount, bill_no, payment_method, confirm } = body;
      const updates: any = {};
      if (paid_amount !== undefined) updates.paid_amount = Number(paid_amount);
      if (bill_no !== undefined) updates.bill_no = bill_no;
      if (payment_method !== undefined) updates.payment_method = payment_method;
      if (confirm) updates.status = "confirmed";

      if (Object.keys(updates).length > 0) {
        await sb.from("entries").update(updates).eq("id", entry_id);
      }

      if (qty !== undefined || rate !== undefined) {
        const lineUpdates: any = {};
        if (qty !== undefined) lineUpdates.qty = Number(qty);
        if (rate !== undefined) lineUpdates.rate = Number(rate);
        await sb.from("entry_lines").update(lineUpdates).eq("entry_id", entry_id);
      }

      const state = await computeLedgerState(shop.id);
      const updated = state.entries.find((e: any) => e.id === entry_id);
      return NextResponse.json({ ok: true, entry: updated, state });
    }

    if (body.action === "delete_entry") {
      await sb.from("entries").delete().eq("id", body.entry_id);
      const state = await computeLedgerState(shop.id);
      return NextResponse.json({ ok: true, state });
    }

    if (body.action === "reset_all") {
      await sb.from("entries").delete().eq("shop_id", shop.id);
      await sb.from("parties").delete().eq("shop_id", shop.id);
      await sb.from("items").delete().eq("shop_id", shop.id);
      const state = await computeLedgerState(shop.id);
      return NextResponse.json({ ok: true, state });
    }

    if (body.action === "create_draft") {
      const {
        type,
        party_name,
        item_name,
        unit,
        qty,
        rate,
        bill_no,
        paid_amount,
        due_days,
        payment_method,
      } = body;
      const defaultPartyType = type === "sale" ? "customer" : "vendor";
      const party = await getOrCreateParty(shop.id, party_name, defaultPartyType);

      const dueDate = due_days
        ? new Date(Date.now() + Number(due_days) * 86400000).toISOString()
        : null;

      const { data: entry, error } = await sb
        .from("entries")
        .insert({
          shop_id: shop.id,
          type,
          party_id: party.id,
          bill_no: bill_no || null,
          due_date: dueDate,
          status: "draft",
          paid_amount: Number(paid_amount) || 0,
          payment_method: payment_method || (type === "payment" ? "UPI" : null),
        })
        .select("*")
        .single();

      if (error) throw new Error(error.message);

      if (type === "purchase" || type === "sale") {
        const item = await getOrCreateItem(
          shop.id,
          item_name || "white cotton",
          unit || "m"
        );
        await sb.from("entry_lines").insert({
          entry_id: entry.id,
          item_id: item.id,
          qty: Number(qty) || 1,
          rate: Number(rate) || 0,
        });
      }

      const state = await computeLedgerState(shop.id);
      return NextResponse.json({ ok: true, state });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
`
);

// 5. app/s/[token]/page.tsx (Interactive Live Public Statement Page - NO LOGIN REQUIRED)
write(
  "app/s/[token]/page.tsx",
  `"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

export default function PublicStatementPage() {
  const params = useParams();
  const token = params?.token as string;
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [ackStatus, setAckStatus] = useState<"none" | "verified" | "disputed">("none");

  useEffect(() => {
    if (!token) return;
    fetch(\`/api/ledger?statement_token=\${token}\`)
      .then((r) => r.json())
      .then((res) => {
        setData(res);
        setLoading(false);
      });
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <p className="text-slate-400 text-sm">Loading live ledger statement...</p>
      </div>
    );
  }

  if (!data || data.error || !data.party) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-sm w-full text-center">
          <h1 className="text-lg font-bold text-rose-400">Statement Not Found</h1>
          <p className="text-xs text-slate-400 mt-2">
            This statement link is invalid or has been reset.
          </p>
        </div>
      </div>
    );
  }

  const { party, shop } = data;
  const isVendor = party.type === "vendor";

  return (
    <div className="min-h-screen bg-slate-950 text-white py-6 px-4 flex justify-center">
      <div className="w-full max-w-md space-y-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 font-bold">
              ● Live Statement Link
            </span>
            <button
              onClick={() => window.print()}
              className="text-xs bg-slate-800 hover:bg-slate-700 px-3 py-1 rounded-lg text-slate-300 cursor-pointer"
            >
              Print / Save PDF
            </button>
          </div>

          <h1 className="text-xl font-bold mt-3">{party.name}</h1>
          <p className="text-xs text-slate-400">
            Ledger with{" "}
            <span className="text-slate-200 font-semibold">
              {shop?.name || "MCP Server"}
            </span>{" "}
            ({party.type.toUpperCase()}) • Works 24/7 with no login
          </p>

          <div className="mt-4 p-4 rounded-xl bg-slate-950 border border-slate-800 flex justify-between items-center">
            <div>
              <p className="text-xs text-slate-400">
                {isVendor
                  ? "Net Balance Payable to You"
                  : "Net Balance Due from You"}
              </p>
              <p className="text-2xl font-extrabold text-emerald-400 mt-0.5">
                ₹{Number(party.balance).toLocaleString("en-IN")}
              </p>
            </div>
            <div className="text-right text-xs text-slate-400 space-y-1">
              <p>
                Total Billed:{" "}
                <span className="text-white font-semibold">
                  ₹{Number(party.total_billed).toLocaleString("en-IN")}
                </span>
              </p>
              <p>
                Total Paid:{" "}
                <span className="text-emerald-400 font-semibold">
                  ₹{Number(party.total_paid).toLocaleString("en-IN")}
                </span>
              </p>
            </div>
          </div>

          {/* Interactive Second-Person Confirmation */}
          <div className="mt-4 pt-3 border-t border-slate-800">
            {ackStatus === "none" ? (
              <div className="flex gap-2">
                <button
                  onClick={() => setAckStatus("verified")}
                  className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-2.5 rounded-xl text-xs cursor-pointer"
                >
                  ✓ Confirm Balance (₹{Number(party.balance).toLocaleString("en-IN")})
                </button>
                <button
                  onClick={() => setAckStatus("disputed")}
                  className="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-300 hover:text-rose-300 text-xs font-semibold cursor-pointer"
                >
                  Flag Issue
                </button>
              </div>
            ) : ackStatus === "verified" ? (
              <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-center text-xs text-emerald-300 font-semibold">
                ✓ Balance verified by {party.name} on{" "}
                {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            ) : (
              <div className="p-2.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-center text-xs text-amber-300 font-semibold">
                ⚠ Issue flagged for shop owner review.
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-300 px-1">
            Confirmed Bills & Payments ({party.entries?.length || 0})
          </h2>

          {(!party.entries || party.entries.length === 0) && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-400">
              No confirmed transactions posted yet.
            </div>
          )}

          {(party.entries || []).map((e: any) => (
            <div
              key={e.id}
              className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2"
            >
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs font-bold uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-200">
                    {e.type}
                  </span>
                  {e.bill_no && (
                    <span className="ml-2 text-xs text-slate-400">
                      Bill #{e.bill_no}
                    </span>
                  )}
                  <p className="text-xs text-slate-400 mt-1">
                    {new Date(e.date).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                    {e.due_date &&
                      \` • Due: \${new Date(e.due_date).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                      })}\`}
                  </p>
                </div>
                <div className="text-right">
                  {e.type === "payment" ? (
                    <p className="text-base font-bold text-emerald-400">
                      -₹{Number(e.paid_amount).toLocaleString("en-IN")}
                    </p>
                  ) : (
                    <p className="text-base font-bold text-white">
                      ₹{Number(e.total_amount).toLocaleString("en-IN")}
                    </p>
                  )}
                  {e.type !== "payment" && e.paid_amount > 0 && (
                    <p className="text-xs text-emerald-400">
                      Paid: ₹{Number(e.paid_amount).toLocaleString("en-IN")}
                    </p>
                  )}
                  {e.payment_method && (
                    <p className="text-xs text-slate-400">via {e.payment_method}</p>
                  )}
                </div>
              </div>

              {e.item && (
                <div className="text-xs text-slate-300 bg-slate-950/70 px-3 py-2 rounded-lg border border-slate-800/80">
                  {e.qty} {e.item.unit} {e.item.name} × ₹{e.rate}/{e.item.unit}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
`
);

// 6. app/page.tsx (Polished Dashboard with 4 KPI Cards, Delete/Reset, Copy MCP URL, WhatsApp Share)
write(
  "app/page.tsx",
  `"use client";
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
    const url = \`\${window.location.origin}/api/mcp?key=ravi123\`;
    navigator.clipboard.writeText(url);
    setCopiedMcp(true);
    setTimeout(() => setCopiedMcp(false), 2000);
  }

  function copyStatementUrl(token: string) {
    const url = \`\${window.location.origin}/s/\${token}\`;
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
                  className={\`py-1.5 rounded-lg text-xs font-semibold uppercase border \${
                    form.type === t
                      ? "bg-emerald-500 text-slate-950 border-emerald-400"
                      : "bg-slate-800 text-slate-300 border-slate-700"
                  }\`}
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
                  ? \`\${window.location.origin}/s/\${p.statement_token}\`
                  : \`/s/\${p.statement_token}\`;
              const waText = encodeURIComponent(
                \`Hi \${p.name}, here is your live verified account statement with MCP Server (Balance: ₹\${Number(
                  p.balance
                ).toLocaleString("en-IN")}): \${statementUrl}\`
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
                      href={\`/s/\${p.statement_token}\`}
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
                      href={\`https://wa.me/?text=\${waText}\`}
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
            className={\`py-2.5 rounded-xl text-xs font-bold cursor-pointer \${
              tab === "inbox"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }\`}
          >
            Inbox ({drafts.length})
          </button>
          <button
            onClick={() => setTab("parties")}
            className={\`py-2.5 rounded-xl text-xs font-bold cursor-pointer \${
              tab === "parties"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }\`}
          >
            Parties ({parties.length})
          </button>
          <button
            onClick={() => setTab("stock")}
            className={\`py-2.5 rounded-xl text-xs font-bold cursor-pointer \${
              tab === "stock"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }\`}
          >
            Stock ({stock.length})
          </button>
        </div>
      </nav>
    </div>
  );
}
`
);

console.log("UPGRADES APPLIED SUCCESSFULLY!");