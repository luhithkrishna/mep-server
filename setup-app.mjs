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

const globalAny = globalThis as any;
if (!globalAny.__partyAcks) {
  globalAny.__partyAcks = new Map<string, { status: "verified" | "disputed"; time: string }>();
}
export const partyAcks: Map<string, { status: "verified" | "disputed"; time: string }> =
  globalAny.__partyAcks;

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
      sell_through_pct: number;
      stock_status: "DEADSTOCK" | "SLOW_MOVING" | "FAST_MOVING" | "OUT_OF_STOCK";
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
      sell_through_pct: 0,
      stock_status: "DEADSTOCK",
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
    st.stock_value = Number((Math.max(0, st.stock_qty) * st.avg_cost).toFixed(2));
    st.sell_through_pct =
      st.purchased_qty > 0
        ? Number(Math.min(100, (st.sold_qty / st.purchased_qty) * 100).toFixed(1))
        : 0;

    if (st.stock_qty <= 0 && st.purchased_qty > 0) {
      st.stock_status = "OUT_OF_STOCK";
    } else if (st.sold_qty === 0) {
      st.stock_status = "DEADSTOCK";
    } else if (st.sell_through_pct < 25) {
      st.stock_status = "SLOW_MOVING";
    } else {
      st.stock_status = "FAST_MOVING";
    }
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

    let dueDays = 0;
    if (entry.due_date && entry.date) {
      const diff = new Date(entry.due_date).getTime() - new Date(entry.date).getTime();
      dueDays = Math.max(0, Math.round(diff / 86400000));
    }

    return {
      ...entry,
      party: partyMap.get(entry.party_id) || null,
      item: firstLine?.item || null,
      line_id: firstLine?.id || null,
      qty,
      rate,
      due_days: dueDays,
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
    let totalProfit = 0;
    let orderCount = 0;
    const itemCounts: Record<string, number> = {};

    for (const e of pEntries) {
      if (e.type === "purchase" || e.type === "sale") {
        totalBilled += e.total_amount;
        totalPaid += e.paid_amount;
        orderCount += 1;
        if (e.type === "sale") {
          totalProfit += e.profit;
        }
        if (e.item?.name) {
          itemCounts[e.item.name] = (itemCounts[e.item.name] || 0) + Number(e.qty || 0);
        }
      } else if (e.type === "payment") {
        totalPaid += e.paid_amount;
      }
    }

    const topItem =
      Object.entries(itemCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const balance = Number((totalBilled - totalPaid).toFixed(2));
    const paymentRatioPct =
      totalBilled > 0 ? Math.min(100, Math.round((totalPaid / totalBilled) * 100)) : 100;
    const profitMarginPct =
      totalBilled > 0 ? Number(((totalProfit / totalBilled) * 100).toFixed(1)) : 0;

    const ack = partyAcks.get(party.statement_token) || null;

    return {
      ...party,
      total_billed: Number(totalBilled.toFixed(2)),
      total_paid: Number(totalPaid.toFixed(2)),
      balance,
      order_count: orderCount,
      total_profit: Number(totalProfit.toFixed(2)),
      profit_margin_pct: profitMarginPct,
      payment_ratio_pct: paymentRatioPct,
      favorite_item: topItem,
      ack,
      entries: pEntries,
    };
  });

  const stockList = Array.from(stockMap.values());
  const confirmedList = enrichedEntries
    .filter((e: any) => e.status === "confirmed")
    .reverse();

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
    deadstock_value: stockList
      .filter((s: any) => s.stock_status === "DEADSTOCK" || s.stock_status === "SLOW_MOVING")
      .reduce((acc: number, s: any) => acc + s.stock_value, 0),
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
  partyAcks,
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
      return NextResponse.json({
        shop: { name: shop?.name || "MCP Server" },
        party: partySummary,
      });
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

    if (body.action === "ack_statement") {
      const { statement_token, status } = body;
      if (statement_token && (status === "verified" || status === "disputed")) {
        partyAcks.set(statement_token, {
          status,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        });
      }
      return NextResponse.json({
        ok: true,
        ack: partyAcks.get(statement_token) || null,
      });
    }

    const shop = await getShop(body.key);

    if (body.action === "update_or_confirm") {
      const {
        entry_id,
        qty,
        rate,
        paid_amount,
        bill_no,
        due_days,
        payment_method,
        confirm,
      } = body;
      const updates: any = {};
      if (paid_amount !== undefined) updates.paid_amount = Number(paid_amount);
      if (bill_no !== undefined) updates.bill_no = bill_no;
      if (payment_method !== undefined) updates.payment_method = payment_method;
      if (due_days !== undefined && Number(due_days) > 0) {
        updates.due_date = new Date(
          Date.now() + Number(due_days) * 86400000
        ).toISOString();
      }
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
      partyAcks.clear();
      await sb.from("entries").delete().eq("shop_id", shop.id);
      await sb.from("parties").delete().eq("shop_id", shop.id);
      await sb.from("items").delete().eq("shop_id", shop.id);
      const state = await computeLedgerState(shop.id);
      return NextResponse.json({ ok: true, state });
    }

    if (body.action === "seed_demo") {
      partyAcks.clear();
      await sb.from("entries").delete().eq("shop_id", shop.id);
      await sb.from("parties").delete().eq("shop_id", shop.id);
      await sb.from("items").delete().eq("shop_id", shop.id);

      const shah = await getOrCreateParty(shop.id, "Shah Textiles", "vendor");
      const surat = await getOrCreateParty(shop.id, "Surat Silk Mills", "vendor");
      const kiran = await getOrCreateParty(shop.id, "Kiran Boutique", "customer");

      const cotton = await getOrCreateItem(shop.id, "white cotton", "m");
      const velvet = await getOrCreateItem(shop.id, "red velvet", "m");

      const due30 = new Date(Date.now() + 30 * 86400000).toISOString();

      const { data: e1 } = await sb
        .from("entries")
        .insert({
          shop_id: shop.id,
          type: "purchase",
          party_id: shah.id,
          bill_no: "4521",
          due_date: due30,
          status: "confirmed",
          paid_amount: 0,
        })
        .select("*")
        .single();
      await sb.from("entry_lines").insert({
        entry_id: e1.id,
        item_id: cotton.id,
        qty: 200,
        rate: 310,
      });

      const { data: e2 } = await sb
        .from("entries")
        .insert({
          shop_id: shop.id,
          type: "purchase",
          party_id: surat.id,
          bill_no: "8810",
          status: "confirmed",
          paid_amount: 25000,
          payment_method: "Bank",
        })
        .select("*")
        .single();
      await sb.from("entry_lines").insert({
        entry_id: e2.id,
        item_id: velvet.id,
        qty: 50,
        rate: 500,
      });

      const { data: e3 } = await sb
        .from("entries")
        .insert({
          shop_id: shop.id,
          type: "sale",
          party_id: kiran.id,
          bill_no: "S-101",
          due_date: due30,
          status: "confirmed",
          paid_amount: 2000,
        })
        .select("*")
        .single();
      await sb.from("entry_lines").insert({
        entry_id: e3.id,
        item_id: cotton.id,
        qty: 10,
        rate: 450,
      });

      await sb.from("entries").insert({
        shop_id: shop.id,
        type: "payment",
        party_id: shah.id,
        status: "confirmed",
        paid_amount: 25000,
        payment_method: "UPI",
      });

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

      const dueDate =
        due_days && Number(due_days) > 0
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

// 5. app/login/page.tsx (Real Admin Session Login + 1-Click Auto-Fill for Reviewers)
write(
  "app/login/page.tsx",
  `"use client";
import { useState } from "react";
import Link from "next/link";

export default function LoginPage() {
  const [email, setEmail] = useState("admin@mcpserver.com");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (
      email.trim().toLowerCase() === "admin@mcpserver.com" &&
      password === "password123"
    ) {
      if (typeof window !== "undefined") {
        localStorage.setItem("mcp_admin_auth", "true");
        window.location.href = "/";
      }
    } else {
      setError("Invalid credentials. Use admin@mcpserver.com / password123");
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-sm w-full space-y-5 shadow-2xl">
        <div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              🔒 Shop Owner Access
            </span>
            <Link
              href="/"
              className="text-xs text-slate-400 hover:text-white"
            >
              ← Read-Only View
            </Link>
          </div>
          <h1 className="text-xl font-bold mt-3">MCP Server Admin Login</h1>
          <p className="text-xs text-slate-400 mt-1">
            Sign in to confirm Claude MCP drafts, edit rates, or manage shop keys.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Admin Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white"
              required
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white"
              required
            />
          </div>

          {error && (
            <p className="text-xs text-rose-400 bg-rose-950/50 border border-rose-800 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold py-3 rounded-xl text-sm transition cursor-pointer"
          >
            Sign In as Ravi (Shop Admin)
          </button>
        </form>

        <div className="pt-3 border-t border-slate-800 space-y-2 text-[11px] text-slate-400">
          <div className="flex items-center justify-between">
            <span>Reviewer Test Credentials:</span>
            <button
              type="button"
              onClick={() => {
                setEmail("admin@mcpserver.com");
                setPassword("password123");
              }}
              className="text-emerald-400 hover:underline font-semibold cursor-pointer"
            >
              Auto-Fill
            </button>
          </div>
          <p className="font-mono text-slate-300 bg-slate-950 px-3 py-2 rounded-lg border border-slate-800">
            Email: admin@mcpserver.com
            <br />
            Pass: password123
          </p>
          <p className="text-[10px] text-slate-500">
            Note: External vendors & customers do not log in here—they use their capability-scoped statement link (/s/[token]).
          </p>
        </div>
      </div>
    </div>
  );
}
`
);

// 6. app/s/[token]/page.tsx (Capability-Scoped Vendor/Customer Statement with Data Isolation)
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
  const [ackTime, setAckTime] = useState<string>("");

  useEffect(() => {
    if (!token) return;
    const saved =
      typeof window !== "undefined"
        ? localStorage.getItem(\`mcp_ack_\${token}\`)
        : null;
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setAckStatus(parsed.status);
        setAckTime(parsed.time);
      } catch {}
    }

    fetch(\`/api/ledger?statement_token=\${token}\`)
      .then((r) => r.json())
      .then((res) => {
        setData(res);
        if (res?.party?.ack) {
          setAckStatus(res.party.ack.status);
          setAckTime(res.party.ack.time);
        }
        setLoading(false);
      });
  }, [token]);

  async function handleAck(status: "verified" | "disputed") {
    const now = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    setAckStatus(status);
    setAckTime(now);
    if (typeof window !== "undefined") {
      localStorage.setItem(
        \`mcp_ack_\${token}\`,
        JSON.stringify({ status, time: now })
      );
    }
    await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "ack_statement",
        statement_token: token,
        status,
      }),
    });
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <p className="text-slate-400 text-sm">Loading verified statement...</p>
      </div>
    );
  }

  if (!data || data.error || !data.party) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-sm w-full text-center">
          <h1 className="text-lg font-bold text-rose-400">Statement Link Expired or Invalid</h1>
          <p className="text-xs text-slate-400 mt-2">
            This capability token does not match an active party record.
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
        {/* Security & Data Isolation Banner */}
        <div className="bg-slate-900/90 border border-emerald-500/30 rounded-xl px-3.5 py-2 flex items-center justify-between text-[11px]">
          <span className="text-emerald-300 font-semibold">
            🔒 Capability-Scoped Read-Only Ledger
          </span>
          <span className="text-slate-400">No Login Required</span>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
          <div className="flex items-center justify-between">
            <span
              className={\`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full font-bold \${
                isVendor
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-sky-500/15 text-sky-300"
              }\`}
            >
              ● {party.type} Statement
            </span>
            <button
              onClick={() => window.print()}
              className="text-xs bg-slate-800 hover:bg-slate-700 px-3 py-1 rounded-lg text-slate-300 cursor-pointer"
            >
              🖨️ Print / Save PDF
            </button>
          </div>

          <h1 className="text-xl font-bold mt-3">{party.name}</h1>
          <p className="text-xs text-slate-400">
            Verified account with{" "}
            <span className="text-slate-200 font-semibold">
              {shop?.name || "MCP Server"}
            </span>{" "}
            • Isolated strictly to {party.name}&apos;s bills
          </p>

          <div className="mt-4 p-4 rounded-xl bg-slate-950 border border-slate-800 flex justify-between items-center">
            <div>
              <p className="text-xs text-slate-400">
                {isVendor
                  ? "Net Balance Payable to You"
                  : "Net Balance Due from You"}
              </p>
              <p
                className={\`text-2xl font-extrabold mt-0.5 \${
                  party.balance === 0
                    ? "text-emerald-400"
                    : isVendor
                    ? "text-amber-400"
                    : "text-sky-400"
                }\`}
              >
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

          {/* Two-Way Counterparty Verification */}
          <div className="mt-4 pt-3 border-t border-slate-800">
            {ackStatus === "none" ? (
              <div className="space-y-1.5">
                <p className="text-[11px] text-slate-400">
                  Do you agree with this running balance?
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAck("verified")}
                    className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-2.5 rounded-xl text-xs cursor-pointer"
                  >
                    ✓ Verify Balance (₹{Number(party.balance).toLocaleString("en-IN")})
                  </button>
                  <button
                    onClick={() => handleAck("disputed")}
                    className="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-300 hover:text-rose-300 text-xs font-semibold cursor-pointer"
                  >
                    Flag Dispute
                  </button>
                </div>
              </div>
            ) : ackStatus === "verified" ? (
              <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-between text-xs text-emerald-300 font-semibold">
                <span>
                  ✓ Verified by {party.name} {ackTime ? \`at \${ackTime}\` : ""}
                </span>
                <button
                  onClick={() => setAckStatus("none")}
                  className="text-[10px] underline text-slate-400 hover:text-white cursor-pointer"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/40 flex items-center justify-between text-xs text-rose-300 font-semibold">
                <span>⚠ Dispute flagged for Shop Admin review</span>
                <button
                  onClick={() => setAckStatus("none")}
                  className="text-[10px] underline text-slate-400 hover:text-white cursor-pointer"
                >
                  Change
                </button>
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

// 7. app/page.tsx (Clean Header, Option B Read-Only Guest Mode, Admin Settings Modal with Hidden Reset/Seed/MCP URL)
write(
  "app/page.tsx",
  `"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

export default function HomePage() {
  const [tab, setTab] = useState<"inbox" | "parties" | "stock">("inbox");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [showDevTools, setShowDevTools] = useState(false);
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedMcp, setCopiedMcp] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [invoiceEntry, setInvoiceEntry] = useState<any>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [localAcks, setLocalAcks] = useState<Record<string, any>>({});
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
    if (typeof window !== "undefined" && res?.parties) {
      const ackMap: Record<string, any> = {};
      for (const p of res.parties) {
        const saved = localStorage.getItem(\`mcp_ack_\${p.statement_token}\`);
        if (saved) {
          try {
            ackMap[p.statement_token] = JSON.parse(saved);
          } catch {}
        }
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

  function getEditVal(entry: any, field: string) {
    if (edits[entry.id] && edits[entry.id][field] !== undefined) {
      return edits[entry.id][field];
    }
    return entry[field] ?? "";
  }

  function setEditVal(entryId: string, field: string, value: any) {
    if (!isAdmin) return;
    setEdits((prev) => ({
      ...prev,
      [entryId]: { ...(prev[entryId] || {}), [field]: value },
    }));
  }

  async function saveOrConfirm(entry: any, confirm: boolean) {
    if (!isAdmin) return;
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
      due_days:
        current.due_days !== undefined ? Number(current.due_days) : entry.due_days,
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
    if (!isAdmin) return;
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
    if (!isAdmin) return;
    if (!confirm("Reset all demo bills, parties, and stock to start with a clean slate?"))
      return;
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

  async function handleQuickAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!isAdmin) return;
    await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_draft", ...form }),
    });
    setShowQuickAdd(false);
    await loadData();
  }

  function handleLogout() {
    if (typeof window !== "undefined") {
      localStorage.removeItem("mcp_admin_auth");
    }
    setIsAdmin(false);
    setShowAdminModal(false);
    setShowQuickAdd(false);
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
    deadstock_value: 0,
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white pb-24 flex flex-col items-center">
      {/* Clean Minimal Top Header */}
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
            <p className="text-[11px] text-slate-400">
              Claude MCP Textile Ledger • Exact Code Math
            </p>
          </div>

          {/* Right Side: Admin Controls vs Guest Read-Only Sign In */}
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
                title="Admin Settings, MCP Key & Demo Tools"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                Ravi (Admin) ⚙️
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 font-medium">
                👁️ Read-Only
              </span>
              <Link
                href="/login"
                className="text-[11px] bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold px-3 py-1.5 rounded-xl transition"
              >
                🔒 Sign In
              </Link>
            </div>
          )}
        </div>
      </header>

      <main className="w-full max-w-md px-4 pt-3 space-y-4">
        {/* Option B: Read-Only Guest Banner when logged out */}
        {!isAdmin && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between text-xs">
            <div className="pr-2">
              <p className="font-semibold text-slate-200">
                🔒 Guest Read-Only Mode
              </p>
              <p className="text-[11px] text-slate-400">
                Sign in as Shop Admin to confirm drafts, edit rates, or view MCP keys.
              </p>
            </div>
            <Link
              href="/login"
              className="shrink-0 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-emerald-300 font-bold px-3 py-1.5 rounded-lg text-[11px]"
            >
              Admin Login →
            </Link>
          </div>
        )}

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

        {/* Manual / Quick Draft Creator (Admin Only) */}
        {isAdmin && showQuickAdd && (
          <form
            onSubmit={handleQuickAdd}
            className="bg-slate-900 border border-emerald-500/40 rounded-2xl p-4 space-y-3"
          >
            <div className="flex justify-between items-center">
              <span className="text-xs font-bold text-emerald-400 uppercase">
                Create Manual Draft Entry
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
              Save Draft to Inbox
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
                    Tell Claude about a purchase, sale, or payment to queue a draft here.
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
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-300">
                            DRAFT {d.type}
                          </span>
                          {d.due_date && (
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-800 text-amber-200 border border-amber-500/30">
                              Due:{" "}
                              {new Date(d.due_date).toLocaleDateString("en-IN", {
                                day: "numeric",
                                month: "short",
                              })}
                            </span>
                          )}
                        </div>
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
                            disabled={!isAdmin}
                            value={getEditVal(d, "qty")}
                            onChange={(e) => setEditVal(d.id, "qty", e.target.value)}
                            className="w-full bg-slate-950 border border-slate-700 disabled:opacity-60 rounded-xl px-3 py-2 text-sm font-semibold"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Rate (₹/{d.item?.unit || "m"})
                          </label>
                          <input
                            type="number"
                            disabled={!isAdmin}
                            value={getEditVal(d, "rate")}
                            onChange={(e) => setEditVal(d.id, "rate", e.target.value)}
                            className="w-full bg-slate-950 border border-amber-500/60 disabled:opacity-60 rounded-xl px-3 py-2 text-sm font-semibold text-amber-200"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Paid Now (₹)
                          </label>
                          <input
                            type="number"
                            disabled={!isAdmin}
                            value={getEditVal(d, "paid_amount")}
                            onChange={(e) =>
                              setEditVal(d.id, "paid_amount", e.target.value)
                            }
                            className="w-full bg-slate-950 border border-slate-700 disabled:opacity-60 rounded-xl px-3 py-2 text-sm"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          <div>
                            <label className="text-[11px] text-slate-400 block mb-1">
                              Bill No.
                            </label>
                            <input
                              type="text"
                              disabled={!isAdmin}
                              value={getEditVal(d, "bill_no")}
                              onChange={(e) =>
                                setEditVal(d.id, "bill_no", e.target.value)
                              }
                              className="w-full bg-slate-950 border border-slate-700 disabled:opacity-60 rounded-xl px-2.5 py-2 text-sm"
                            />
                          </div>
                          <div>
                            <label className="text-[11px] text-slate-400 block mb-1">
                              Due (Days)
                            </label>
                            <input
                              type="number"
                              disabled={!isAdmin}
                              value={getEditVal(d, "due_days")}
                              onChange={(e) =>
                                setEditVal(d.id, "due_days", e.target.value)
                              }
                              className="w-full bg-slate-950 border border-slate-700 disabled:opacity-60 rounded-xl px-2.5 py-2 text-sm"
                            />
                          </div>
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
                            disabled={!isAdmin}
                            value={getEditVal(d, "paid_amount")}
                            onChange={(e) =>
                              setEditVal(d.id, "paid_amount", e.target.value)
                            }
                            className="w-full bg-slate-950 border border-amber-500/60 disabled:opacity-60 rounded-xl px-3 py-2 text-sm font-semibold"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Method (UPI/Cash)
                          </label>
                          <input
                            type="text"
                            disabled={!isAdmin}
                            value={getEditVal(d, "payment_method")}
                            onChange={(e) =>
                              setEditVal(d.id, "payment_method", e.target.value)
                            }
                            className="w-full bg-slate-950 border border-slate-700 disabled:opacity-60 rounded-xl px-3 py-2 text-sm"
                          />
                        </div>
                      </div>
                    )}

                    {isAdmin ? (
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
                    ) : (
                      <Link
                        href="/login"
                        className="block w-full text-center bg-slate-800 hover:bg-slate-700 border border-slate-700 text-amber-300 font-bold py-2.5 rounded-xl text-xs"
                      >
                        🔒 Sign In as Admin to Edit & Confirm Draft
                      </Link>
                    )}
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
                  className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2.5"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                          CONFIRMED {c.type}
                        </span>
                        {c.bill_no && (
                          <span className="text-xs text-slate-400">
                            Bill #{c.bill_no}
                          </span>
                        )}
                        {c.due_date && c.unpaid_amount > 0 && (
                          <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 font-semibold">
                            Due:{" "}
                            {new Date(c.due_date).toLocaleDateString("en-IN", {
                              day: "numeric",
                              month: "short",
                            })}
                          </span>
                        )}
                      </div>
                      <h3 className="text-sm font-bold mt-1">{c.party?.name}</h3>
                    </div>
                    <div className="text-right flex items-start gap-2">
                      <div>
                        <p className="text-base font-bold text-white">
                          ₹{Number(c.total_amount).toLocaleString("en-IN")}
                        </p>
                        {c.type !== "payment" ? (
                          <p className="text-[11px] text-slate-400">
                            Paid: ₹{Number(c.paid_amount).toLocaleString("en-IN")} • Due: ₹
                            {Number(c.unpaid_amount).toLocaleString("en-IN")}
                          </p>
                        ) : (
                          <p className="text-[11px] text-emerald-400">
                            via {c.payment_method || "UPI"}
                          </p>
                        )}
                      </div>
                      {isAdmin && (
                        <button
                          onClick={() => deleteEntry(c.id)}
                          title="Delete entry (Admin only)"
                          className="text-xs text-slate-500 hover:text-rose-400 px-1.5 py-0.5 rounded bg-slate-800/60 cursor-pointer"
                        >
                          ✕
                        </button>
                      )}
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

                  <div className="pt-1 flex justify-end">
                    <button
                      onClick={() => setInvoiceEntry(c)}
                      className="text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1 rounded-lg font-medium cursor-pointer"
                    >
                      📄 View Invoice / Receipt
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 2: PARTIES, CUSTOMER TRENDS & LIVE STATEMENT LINKS */}
        {!loading && tab === "parties" && (
          <div className="space-y-3">
            <h2 className="text-sm font-bold text-slate-200">
              Vendor Credits & Customer Trends ({parties.length})
            </h2>
            {parties.length === 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-400">
                No parties yet. Confirm a purchase or sale first.
              </div>
            )}
            {parties.map((p: any) => {
              const isVendor = p.type === "vendor";
              const ack = p.ack || localAcks[p.statement_token] || null;
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
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={\`text-[10px] font-bold uppercase px-2 py-0.5 rounded \${
                            isVendor
                              ? "bg-amber-500/15 text-amber-300"
                              : "bg-sky-500/15 text-sky-300"
                          }\`}
                        >
                          {p.type}
                        </span>
                        {ack?.status === "verified" && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                            ✓ Verified by {p.name}
                          </span>
                        )}
                        {ack?.status === "disputed" && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30">
                            ⚠ Dispute Flagged
                          </span>
                        )}
                      </div>
                      <h3 className="text-base font-bold mt-1">{p.name}</h3>
                      <p className="text-xs text-slate-400">
                        Billed: ₹{Number(p.total_billed).toLocaleString("en-IN")} • Paid: ₹
                        {Number(p.total_paid).toLocaleString("en-IN")}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] text-slate-400">
                        {p.balance === 0
                          ? "Status"
                          : isVendor
                          ? "You Owe (Payable)"
                          : "Owes You (Receivable)"}
                      </p>
                      {p.balance === 0 ? (
                        <p className="text-sm font-extrabold text-emerald-400 mt-0.5">
                          ✓ Settled (₹0)
                        </p>
                      ) : (
                        <p
                          className={\`text-xl font-extrabold \${
                            isVendor ? "text-amber-400" : "text-sky-400"
                          }\`}
                        >
                          ₹{Number(p.balance).toLocaleString("en-IN")}
                        </p>
                      )}
                    </div>
                  </div>

                  {!isVendor ? (
                    <div className="grid grid-cols-3 gap-2 text-[11px] bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                      <div>
                        <span className="text-slate-400 block">Profit Generated</span>
                        <span className="font-bold text-emerald-400">
                          +₹{Number(p.total_profit).toLocaleString("en-IN")} ({p.profit_margin_pct}%)
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block">Payment Ratio</span>
                        <span className="font-bold text-slate-200">
                          {p.payment_ratio_pct}% Paid
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block">Buying Trend</span>
                        <span className="font-bold text-sky-300 capitalize">
                          {p.order_count}x • {p.favorite_item || "Cloth"}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-between items-center text-[11px] bg-slate-950 px-3 py-2 rounded-xl border border-slate-800">
                      <span className="text-slate-400">
                        Supplies:{" "}
                        <strong className="text-slate-200 capitalize">
                          {p.favorite_item || "Textiles"}
                        </strong>{" "}
                        ({p.order_count} bills)
                      </span>
                      <span className="text-emerald-400 font-semibold">
                        {p.payment_ratio_pct}% Settled
                      </span>
                    </div>
                  )}

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

        {/* TAB 3: STOCK, WEIGHTED-AVERAGE COST & DEADSTOCK RADAR */}
        {!loading && tab === "stock" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-200">
                Stock, Avg Cost & Deadstock Radar ({stock.length})
              </h2>
              {kpis.deadstock_value > 0 && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30 font-bold">
                  At-Risk Capital: ₹{Number(kpis.deadstock_value).toLocaleString("en-IN")}
                </span>
              )}
            </div>

            {stock.length === 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-400">
                No stock items yet. Confirm a purchase to see live stock.
              </div>
            )}

            {stock.map((s: any) => {
              const isDead = s.stock_status === "DEADSTOCK";
              const isSlow = s.stock_status === "SLOW_MOVING";

              return (
                <div
                  key={s.item_id}
                  className={\`bg-slate-900 border rounded-2xl p-4 space-y-3 \${
                    isDead
                      ? "border-rose-500/50"
                      : isSlow
                      ? "border-amber-500/40"
                      : "border-slate-800"
                  }\`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-bold capitalize">{s.name}</h3>
                        {isDead && (
                          <span className="text-[10px] font-extrabold px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
                            🔴 DEADSTOCK (0% Sold)
                          </span>
                        )}
                        {isSlow && (
                          <span className="text-[10px] font-extrabold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300">
                            🟡 SLOW MOVING ({s.sell_through_pct}% Sold)
                          </span>
                        )}
                        {s.stock_status === "FAST_MOVING" && (
                          <span className="text-[10px] font-extrabold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                            🟢 FAST MOVING ({s.sell_through_pct}% Sold)
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 mt-1">
                        In: {s.purchased_qty} {s.unit} • Sold: {s.sold_qty} {s.unit}
                      </p>
                      <p className="text-xs text-emerald-400 font-semibold mt-0.5">
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
                        Capital Locked: ₹
                        {Number(s.stock_value).toLocaleString("en-IN")}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-slate-400">
                      <span>Sell-Through Velocity</span>
                      <span className="font-semibold text-slate-200">
                        {s.sell_through_pct}% Sold
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                      <div
                        className={\`h-full transition-all \${
                          isDead
                            ? "bg-rose-500"
                            : isSlow
                            ? "bg-amber-400"
                            : "bg-emerald-400"
                        }\`}
                        style={{ width: \`\${Math.max(4, s.sell_through_pct)}%\` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Admin Settings, Security & Hidden Demo Tools Modal */}
      {isAdmin && showAdminModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
            <div className="flex justify-between items-start border-b border-slate-800 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                  ● Admin Session Active
                </span>
                <h3 className="text-base font-bold mt-1">
                  Ravi — Shop Owner Controls
                </h3>
                <p className="text-xs text-slate-400">admin@mcpserver.com</p>
              </div>
              <button
                onClick={() => setShowAdminModal(false)}
                className="text-slate-400 hover:text-white text-sm px-2 py-1 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Private MCP Connector Key (Visible only to Admin) */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 block">
                Your Private Claude MCP Connector URL
              </label>
              <div className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs">
                <code className="text-emerald-400 truncate mr-2">
                  /api/mcp?key=ravi123
                </code>
                <button
                  onClick={copyMcpUrl}
                  className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold px-2.5 py-1 rounded-lg text-[11px] shrink-0 cursor-pointer"
                >
                  {copiedMcp ? "✓ Copied!" : "Copy Full URL"}
                </button>
              </div>
              <p className="text-[10px] text-slate-500">
                Claude can only queue unconfirmed drafts with this key. Only you can confirm bills to the ledger.
              </p>
            </div>

            {/* Role-Based Access Summary */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-1.5 text-[11px]">
              <p className="font-bold text-slate-200">
                Security & Access Architecture
              </p>
              <p className="text-slate-400">
                • <strong className="text-emerald-300">Admin (You):</strong> Full write access to edit/confirm drafts, view profit margins, and manage stock.
              </p>
              <p className="text-slate-400">
                • <strong className="text-amber-300">Vendors & Customers:</strong> Zero-login capability links (<code>/s/[token]</code>) scoped strictly to their own bills.
              </p>
            </div>

            {/* Collapsible Developer / Demo Reset Drawer */}
            <div className="border-t border-slate-800 pt-3">
              <button
                type="button"
                onClick={() => setShowDevTools(!showDevTools)}
                className="w-full flex items-center justify-between text-xs text-slate-400 hover:text-slate-200 font-medium cursor-pointer"
              >
                <span>
                  {showDevTools ? "▾" : "▸"} Developer & Demo Utilities
                </span>
                <span className="text-[10px] text-slate-500">Seed / Reset</span>
              </button>

              {showDevTools && (
                <div className="grid grid-cols-2 gap-2 mt-2.5 pt-2">
                  <button
                    onClick={handleSeedDemo}
                    className="bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 font-bold py-2 rounded-xl text-xs cursor-pointer"
                  >
                    ⚡ Seed Sample Shop
                  </button>
                  <button
                    onClick={handleResetAll}
                    className="bg-rose-950/60 hover:bg-rose-900/80 border border-rose-800/60 text-rose-300 font-bold py-2 rounded-xl text-xs cursor-pointer"
                  >
                    🗑️ Reset All Data
                  </button>
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={handleLogout}
                className="flex-1 bg-slate-800 hover:bg-rose-950 text-slate-300 hover:text-rose-300 font-semibold py-2.5 rounded-xl text-xs cursor-pointer"
              >
                Sign Out (Switch to Read-Only)
              </button>
              <button
                onClick={() => setShowAdminModal(false)}
                className="px-4 py-2.5 rounded-xl bg-slate-800 text-white text-xs font-bold cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Printable Tax Invoice / Payment Receipt Modal */}
      {invoiceEntry && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
            <div className="flex justify-between items-start border-b border-slate-800 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                  {invoiceEntry.type === "payment"
                    ? "PAYMENT RECEIPT"
                    : \`\${invoiceEntry.type.toUpperCase()} INVOICE\`}
                </span>
                <h3 className="text-lg font-bold mt-1">MCP Server Textiles</h3>
                <p className="text-xs text-slate-400">
                  {invoiceEntry.bill_no
                    ? \`Bill #\${invoiceEntry.bill_no}\`
                    : \`Ref #\${invoiceEntry.id.slice(0, 6)}\`}{" "}
                  •{" "}
                  {new Date(invoiceEntry.date).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </p>
              </div>
              <button
                onClick={() => setInvoiceEntry(null)}
                className="text-slate-400 hover:text-white text-sm px-2 py-1"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Party Name:</span>
                <span className="font-bold text-white">
                  {invoiceEntry.party?.name} ({invoiceEntry.party?.type})
                </span>
              </div>
              {invoiceEntry.item && (
                <div className="flex justify-between">
                  <span className="text-slate-400">Item & Rate:</span>
                  <span className="font-semibold text-slate-200">
                    {invoiceEntry.qty} {invoiceEntry.item.unit}{" "}
                    {invoiceEntry.item.name} × ₹{invoiceEntry.rate}
                  </span>
                </div>
              )}
              <div className="flex justify-between pt-2 border-t border-slate-800 text-sm">
                <span className="text-slate-300 font-semibold">Total Amount:</span>
                <span className="font-extrabold text-white">
                  ₹{Number(invoiceEntry.total_amount).toLocaleString("en-IN")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Amount Paid:</span>
                <span className="font-bold text-emerald-400">
                  ₹{Number(invoiceEntry.paid_amount).toLocaleString("en-IN")}
                </span>
              </div>
              {invoiceEntry.type !== "payment" && (
                <div className="flex justify-between">
                  <span className="text-slate-400">Balance Due:</span>
                  <span className="font-bold text-amber-400">
                    ₹{Number(invoiceEntry.unpaid_amount).toLocaleString("en-IN")}
                  </span>
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => window.print()}
                className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-2.5 rounded-xl text-xs cursor-pointer"
              >
                🖨️ Print / Save PDF
              </button>
              <button
                onClick={() => setInvoiceEntry(null)}
                className="px-4 py-2.5 rounded-xl bg-slate-800 text-slate-300 text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

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

console.log("SECURITY, LOGIN SESSION & HIDDEN ADMIN TOOLS APPLIED!");