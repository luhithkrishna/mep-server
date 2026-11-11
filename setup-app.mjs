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
      sales_revenue: number;
      avg_cost: number;
      avg_selling_rate: number;
      stock_qty: number;
      stock_value: number;
      sell_through_pct: number;
      first_purchase_date: string | null;
      last_sale_date: string | null;
      age_days: number;
      locked_share_pct: number;
      clearance_breakeven_rate: number;
      clearance_10pct_rate: number;
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
      sales_revenue: 0,
      avg_cost: 0,
      avg_selling_rate: 0,
      stock_qty: 0,
      stock_value: 0,
      sell_through_pct: 0,
      first_purchase_date: null,
      last_sale_date: null,
      age_days: 0,
      locked_share_pct: 0,
      clearance_breakeven_rate: 0,
      clearance_10pct_rate: 0,
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
          if (!st.first_purchase_date || new Date(entry.date) < new Date(st.first_purchase_date)) {
            st.first_purchase_date = entry.date;
          }
        }
      }
    } else if (entry.type === "sale") {
      for (const l of eLines) {
        const st = stockMap.get(l.item_id);
        if (st) {
          const qty = Number(l.qty) || 0;
          const rate = Number(l.rate) || 0;
          st.sold_qty += qty;
          st.sales_revenue += qty * rate;
          if (!st.last_sale_date || new Date(entry.date) > new Date(st.last_sale_date)) {
            st.last_sale_date = entry.date;
          }
        }
      }
    }
  }

  let totalShopStockValue = 0;
  for (const st of stockMap.values()) {
    st.avg_cost =
      st.purchased_qty > 0
        ? Number((st.purchase_cost / st.purchased_qty).toFixed(2))
        : 0;
    st.avg_selling_rate =
      st.sold_qty > 0
        ? Number((st.sales_revenue / st.sold_qty).toFixed(2))
        : 0;
    st.stock_qty = Number((st.purchased_qty - st.sold_qty).toFixed(2));
    st.stock_value = Number((Math.max(0, st.stock_qty) * st.avg_cost).toFixed(2));
    totalShopStockValue += st.stock_value;

    st.sell_through_pct =
      st.purchased_qty > 0
        ? Number(Math.min(100, (st.sold_qty / st.purchased_qty) * 100).toFixed(1))
        : 0;

    const refDate = st.last_sale_date || st.first_purchase_date;
    if (refDate) {
      const diff = Date.now() - new Date(refDate).getTime();
      st.age_days = Math.max(1, Math.round(diff / 86400000));
    }

    st.clearance_breakeven_rate = st.avg_cost;
    st.clearance_10pct_rate = Number((st.avg_cost * 0.9).toFixed(0));

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

  for (const st of stockMap.values()) {
    st.locked_share_pct =
      totalShopStockValue > 0
        ? Number(((st.stock_value / totalShopStockValue) * 100).toFixed(1))
        : 0;
  }

  const enrichedEntries = (entries || []).map((entry: any) => {
    const eLines = linesByEntry.get(entry.id) || [];
    const lineTotal = eLines.reduce(
      (acc: number, l: any) => acc + Number(l.qty) * Number(l.rate),
      0
    );
    const paidAmount = Number(entry.paid_amount) || 0;
    const totalAmount =
      entry.type === "payment" ? paidAmount : Number(lineTotal.toFixed(2));

    let cost = 0;
    let profit = 0;
    if (entry.type === "sale") {
      for (const l of eLines) {
        const st = stockMap.get(l.item_id);
        const unitCost = st ? st.avg_cost : 0;
        cost += Number((Number(l.qty) * unitCost).toFixed(2));
      }
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
      lines: eLines,
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
    let totalCost = 0;
    let totalQty = 0;
    let orderCount = 0;
    const itemCounts: Record<string, number> = {};

    for (const e of pEntries) {
      if (e.type === "purchase" || e.type === "sale") {
        totalBilled += e.total_amount;
        totalPaid += e.paid_amount;
        orderCount += 1;
        if (e.type === "sale") {
          totalProfit += e.profit;
          totalCost += e.cost;
        }
        for (const l of e.lines || []) {
          totalQty += Number(l.qty || 0);
          if (l.item?.name) {
            itemCounts[l.item.name] = (itemCounts[l.item.name] || 0) + Number(l.qty || 0);
          }
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
    const aov = orderCount > 0 ? Math.round(totalBilled / orderCount) : 0;
    const avgRatePaid = totalQty > 0 ? Math.round(totalBilled / totalQty) : 0;

    let customerTier: "VIP Cash Buyer" | "High-Margin Credit" | "Credit Risk" | "New" = "New";
    if (party.type === "customer" && orderCount > 0) {
      if (paymentRatioPct >= 75) {
        customerTier = "VIP Cash Buyer";
      } else if (paymentRatioPct >= 40 && profitMarginPct >= 20) {
        customerTier = "High-Margin Credit";
      } else {
        customerTier = "Credit Risk";
      }
    }

    const ack = partyAcks.get(party.statement_token) || null;

    return {
      ...party,
      total_billed: Number(totalBilled.toFixed(2)),
      total_paid: Number(totalPaid.toFixed(2)),
      total_cost: Number(totalCost.toFixed(2)),
      balance,
      order_count: orderCount,
      total_qty: totalQty,
      aov,
      avg_rate_paid: avgRatePaid,
      total_profit: Number(totalProfit.toFixed(2)),
      profit_margin_pct: profitMarginPct,
      payment_ratio_pct: paymentRatioPct,
      favorite_item: topItem,
      customer_tier: customerTier,
      ack,
      entries: pEntries,
    };
  });

  const stockList = Array.from(stockMap.values());
  const confirmedList = enrichedEntries
    .filter((e: any) => e.status === "confirmed")
    .reverse();

  const totalPayables = partyBalances
    .filter((p: any) => p.type === "vendor" && p.balance > 0)
    .reduce((acc: number, p: any) => acc + p.balance, 0);

  const totalReceivables = partyBalances
    .filter((p: any) => p.type === "customer" && p.balance > 0)
    .reduce((acc: number, p: any) => acc + p.balance, 0);

  const totalBookedProfit = confirmedList
    .filter((e: any) => e.type === "sale")
    .reduce((acc: number, e: any) => acc + e.profit, 0);

  const totalCashCollected = partyBalances
    .filter((p: any) => p.type === "customer")
    .reduce((acc: number, p: any) => acc + p.total_paid, 0);

  const deadstockValue = stockList
    .filter((s: any) => s.stock_status === "DEADSTOCK" || s.stock_status === "SLOW_MOVING")
    .reduce((acc: number, s: any) => acc + s.stock_value, 0);

  const activeStockValue = Math.max(0, totalShopStockValue - deadstockValue);
  const coverageRatio =
    totalPayables > 0
      ? Number(((totalReceivables + activeStockValue) / totalPayables).toFixed(2))
      : 99;

  const kpis = {
    total_payables: totalPayables,
    total_receivables: totalReceivables,
    total_stock_value: totalShopStockValue,
    active_stock_value: activeStockValue,
    total_profit: totalBookedProfit,
    total_cash_collected: totalCashCollected,
    deadstock_value: deadstockValue,
    coverage_ratio: coverageRatio,
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
      const { entry_id, paid_amount, bill_no, due_days, payment_method, confirm } = body;
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
      const ramesh = await getOrCreateParty(shop.id, "Ramesh Traders", "customer");
      const kiran = await getOrCreateParty(shop.id, "Kiran Boutique", "customer");

      const cotton = await getOrCreateItem(shop.id, "white cotton", "m");
      const velvet = await getOrCreateItem(shop.id, "red velvet", "m");

      const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
      const daysAhead = (d: number) => new Date(Date.now() + d * 86400000).toISOString();

      // 1. Purchase: Surat Silk Mills (50m red velvet @ ₹500/m = ₹25,000)
      const { data: e1 } = await sb
        .from("entries")
        .insert({
          shop_id: shop.id,
          type: "purchase",
          party_id: surat.id,
          bill_no: "8810",
          date: daysAgo(45),
          status: "confirmed",
          paid_amount: 25000,
          payment_method: "Bank",
        })
        .select("*")
        .single();
      await sb.from("entry_lines").insert({
        entry_id: e1.id,
        item_id: velvet.id,
        qty: 50,
        rate: 500,
      });

      // 2. Purchase: Shah Textiles (200m white cotton @ ₹310/m = ₹62,000)
      const { data: e2 } = await sb
        .from("entries")
        .insert({
          shop_id: shop.id,
          type: "purchase",
          party_id: shah.id,
          bill_no: "4521",
          date: daysAgo(20),
          due_date: daysAhead(10),
          status: "confirmed",
          paid_amount: 0,
        })
        .select("*")
        .single();
      await sb.from("entry_lines").insert({
        entry_id: e2.id,
        item_id: cotton.id,
        qty: 200,
        rate: 310,
      });

      // 3. Sale: Ramesh Traders (90m white cotton @ ₹420/m = ₹37,800, paid ₹30,000)
      const { data: e4 } = await sb
        .from("entries")
        .insert({
          shop_id: shop.id,
          type: "sale",
          party_id: ramesh.id,
          bill_no: "S-101",
          date: daysAgo(8),
          due_date: daysAhead(7),
          status: "confirmed",
          paid_amount: 30000,
        })
        .select("*")
        .single();
      await sb.from("entry_lines").insert({
        entry_id: e4.id,
        item_id: cotton.id,
        qty: 90,
        rate: 420,
      });

      const state = await computeLedgerState(shop.id);
      return NextResponse.json({ ok: true, state });
    }

    if (body.action === "create_draft") {
      const {
        type,
        party_name,
        items,
        bill_no,
        paid_amount,
        due_days,
        days_ago,
        payment_method,
      } = body;

      const defaultPartyType = type === "sale" ? "customer" : "vendor";
      const party = await getOrCreateParty(shop.id, party_name, defaultPartyType);

      const entryDate =
        days_ago && Number(days_ago) > 0
          ? new Date(Date.now() - Number(days_ago) * 86400000).toISOString()
          : new Date().toISOString();

      const dueDate =
        due_days && Number(due_days) > 0
          ? new Date(new Date(entryDate).getTime() + Number(due_days) * 86400000).toISOString()
          : null;

      const { data: entry, error } = await sb
        .from("entries")
        .insert({
          shop_id: shop.id,
          type,
          party_id: party.id,
          bill_no: bill_no || null,
          date: entryDate,
          due_date: dueDate,
          status: "draft",
          paid_amount: Number(paid_amount) || 0,
          payment_method: payment_method || (type === "payment" ? "UPI" : null),
        })
        .select("*")
        .single();

      if (error) throw new Error(error.message);

      if (items && Array.isArray(items)) {
        for (const it of items) {
          const itemRec = await getOrCreateItem(shop.id, it.item_name || "cloth", it.unit || "m");
          const qty = Number(it.qty) || 1;
          const rate = Number(it.rate) || 0;
          await sb.from("entry_lines").insert({
            entry_id: entry.id,
            item_id: itemRec.id,
            qty,
            rate,
          });
        }
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

// 5. app/api/mcp/route.ts (Upgraded to accept multiple items array)
write(
  "app/api/mcp/route.ts",
  `import { NextRequest, NextResponse } from "next/server";
import {
  getSupabase,
  getShop,
  getOrCreateParty,
  getOrCreateItem,
  computeLedgerState,
} from "@/lib/ledger";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-Id",
};

const TOOLS = [
  {
    name: "create_purchase",
    description: "Record a vendor purchase bill with multiple items (e.g. sarees, jeans, jackets) and partial upfront payment.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string", description: "Vendor name, e.g. 'Sai Ram Textile'" },
        items: {
          type: "array",
          description: "List of items purchased",
          items: {
            type: "object",
            properties: {
              item_name: { type: "string", description: "Name of item, e.g. 'sarees'" },
              qty: { type: "number", description: "Quantity" },
              unit: { type: "string", description: "'m' for meters or 'pcs' for pieces" },
              rate: { type: "number", description: "Price per unit in INR" }
            },
            required: ["item_name", "qty", "rate"]
          }
        },
        bill_no: { type: "string" },
        paid_amount: { type: "number", description: "Amount paid upfront in INR" },
        due_days: { type: "number" },
        days_ago: { type: "number" }
      },
      required: ["party_name", "items"]
    }
  },
  {
    name: "create_sale",
    description: "Record a customer sale with multiple items and partial payment.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item_name: { type: "string" },
              qty: { type: "number" },
              unit: { type: "string" },
              rate: { type: "number" }
            },
            required: ["item_name", "qty", "rate"]
          }
        },
        paid_amount: { type: "number" },
        due_days: { type: "number" },
        days_ago: { type: "number" }
      },
      required: ["party_name", "items"]
    }
  },
  {
    name: "create_payment",
    description: "Record a payment made to a vendor or received from a customer.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string" },
        amount: { type: "number" },
        method: { type: "string" }
      },
      required: ["party_name", "amount"]
    }
  },
  {
    name: "get_stock",
    description: "Get stock quantity, weighted-average cost, and deadstock status.",
    inputSchema: { type: "object", properties: { item_name: { type: "string" } } },
  },
  {
    name: "get_party_balance",
    description: "Get vendor or customer balance and statement link.",
    inputSchema: { type: "object", properties: { party_name: { type: "string" } }, required: ["party_name"] },
  },
  {
    name: "list_outstanding",
    description: "List all vendors we owe and customers who owe us.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_business_insights",
    description: "Analyze working capital, sales revenue, booked profit, cash collected vs pending udhaar, and deadstock.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function executeTool(name: string, args: any, reqUrl: string, mcpKey?: string | null) {
  const sb = getSupabase();
  const shop = await getShop(mcpKey);

  if (name === "create_purchase" || name === "create_sale") {
    const { party_name, items = [], paid_amount = 0, due_days, days_ago, bill_no } = args || {};
    const defaultType = name === "create_sale" ? "customer" : "vendor";
    const party = await getOrCreateParty(shop.id, party_name, defaultType);
    const entryDate = days_ago ? new Date(Date.now() - days_ago * 86400000).toISOString() : new Date().toISOString();
    const dueDate = due_days ? new Date(new Date(entryDate).getTime() + due_days * 86400000).toISOString() : null;

    const { data: entry, error } = await sb.from("entries").insert({
      shop_id: shop.id,
      type: name === "create_sale" ? "sale" : "purchase",
      party_id: party.id,
      bill_no: bill_no ? String(bill_no) : null,
      date: entryDate,
      due_date: dueDate,
      status: "draft",
      paid_amount: Number(paid_amount) || 0,
    }).select("*").single();

    if (error) throw new Error(error.message);

    for (const it of items) {
      const itemRec = await getOrCreateItem(shop.id, it.item_name || "cloth", it.unit || "m");
      await sb.from("entry_lines").insert({
        entry_id: entry.id,
        item_id: itemRec.id,
        qty: Number(it.qty) || 1,
        rate: Number(it.rate) || 0,
      });
    }

    return \`Draft multi-item \${name === "create_sale" ? "sale" : "purchase"} saved in Inbox for \${party.name}.\`;
  }

  if (name === "create_payment") {
    const { party_name, amount, method = "UPI" } = args || {};
    const { data: allParties = [] } = await sb.from("parties").select("*").eq("shop_id", shop.id);
    const matched = allParties.find((p: any) => p.name.toLowerCase().includes(String(party_name).toLowerCase())) || await getOrCreateParty(shop.id, party_name, "vendor");

    await sb.from("entries").insert({
      shop_id: shop.id, type: "payment", party_id: matched.id, status: "draft", paid_amount: Number(amount), payment_method: method,
    });
    return \`Draft Payment saved in Inbox for \${matched.name}.\`;
  }

  if (name === "get_stock") {
    const state = await computeLedgerState(shop.id);
    return state.stock.map((s: any) => \`• \${s.name}: \${s.stock_qty} \${s.unit} left (Avg Cost: ₹\${s.avg_cost}/\${s.unit}, Status: \${s.stock_status})\`).join("\\n");
  }

  if (name === "get_party_balance") {
    const { party_name } = args || {};
    const state = await computeLedgerState(shop.id);
    const party = state.parties.find((p: any) => p.name.toLowerCase().includes(party_name.toLowerCase()));
    if (!party) return \`Party not found.\`;
    return \`\${party.name} (\${party.type}): Balance ₹\${party.balance} | Statement: \${new URL(reqUrl).origin}/s/\${party.statement_token}\`;
  }

  if (name === "list_outstanding") {
    const state = await computeLedgerState(shop.id);
    return state.parties.filter((p: any) => p.balance !== 0).map((p: any) => \`• \${p.name} (\${p.type}): ₹\${p.balance}\`).join("\\n");
  }

  if (name === "get_business_insights") {
    const state = await computeLedgerState(shop.id);
    return \`=== Business Insights ===\\n• Total Sales Revenue: ₹\${state.parties.filter((p: any) => p.type === "customer").reduce((a, c) => a + c.total_billed, 0)}\\n• Total Booked Profit: +₹\${state.kpis.total_profit}\\n• Total Cash Collected: ₹\${state.kpis.total_cash_collected}\\n• Pending Customer Udhaar: ₹\${state.kpis.total_receivables}\`;
  }

  throw new Error(\`Unknown tool: \${name}\`);
}

async function handleJsonRpcMessage(msg: any, reqUrl: string, mcpKey?: string | null) {
  const { id, method, params } = msg || {};
  if (method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mcp-server", version: "1.0.0" } } };
  if (method === "notifications/initialized" || method === "notifications/cancelled" || method === "ping") return null;
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    try {
      const text = await executeTool(params?.name, params?.arguments || {}, reqUrl, mcpKey);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } };
    } catch (err: any) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: \`Error: \${err.message}\` }], isError: true } };
    }
  }
  return null;
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS_HEADERS }); }
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const shop = await getShop(searchParams.get("key"));
  return NextResponse.json({ name: "MCP Server", status: "live", shop: shop?.name }, { headers: CORS_HEADERS });
}
export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const mcpKey = searchParams.get("key");
    const body = await req.json();
    if (Array.isArray(body)) {
      const res = [];
      for (const item of body) { const r = await handleJsonRpcMessage(item, req.url, mcpKey); if (r) res.push(r); }
      return NextResponse.json(res, { headers: CORS_HEADERS });
    }
    const res = await handleJsonRpcMessage(body, req.url, mcpKey);
    return NextResponse.json(res, { headers: CORS_HEADERS });
  } catch (err: any) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: err.message } }, { status: 400, headers: CORS_HEADERS });
  }
}
export async function DELETE() { return new NextResponse(null, { status: 200, headers: CORS_HEADERS }); }
`
);

// 6. app/page.tsx (With Multi-Item Dynamic Manual Entry Form & Unit Toggles)
write(
  "app/page.tsx",
  `"use client";
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
        const saved = localStorage.getItem(\`mcp_ack_\${p.statement_token}\`);
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
                  className={\`py-1.5 rounded-lg text-xs font-semibold uppercase border cursor-pointer \${
                    formType === t ? "bg-emerald-500 text-slate-950 border-emerald-400" : "bg-slate-800 text-slate-300 border-slate-700"
                  }\`}
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
                  <button onClick={() => setInboxSubTab("all")} className={\`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer \${inboxSubTab === "all" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}\`}>All</button>
                  <button onClick={() => setInboxSubTab("sales")} className={\`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer \${inboxSubTab === "sales" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}\`}>Sales</button>
                  <button onClick={() => setInboxSubTab("purchases")} className={\`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer \${inboxSubTab === "purchases" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}\`}>Purchases</button>
                  <button onClick={() => setInboxSubTab("payments")} className={\`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer \${inboxSubTab === "payments" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}\`}>Payments</button>
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
              <button onClick={() => setPartySubTab("vendors")} className={\`py-2 rounded-lg text-xs font-bold cursor-pointer \${partySubTab === "vendors" ? "bg-amber-500 text-slate-950" : "text-slate-400"}\`}>
                📦 Vendors You Owe ({vendorsList.length})
              </button>
              <button onClick={() => setPartySubTab("customers")} className={\`py-2 rounded-lg text-xs font-bold cursor-pointer \${partySubTab === "customers" ? "bg-sky-500 text-slate-950" : "text-slate-400"}\`}>
                🛍️ Customers Who Owe ({customersList.length})
              </button>
            </div>

            {partySubTab === "vendors" ? (
              <div className="space-y-3 pt-1">
                {vendorsList.map((p: any) => {
                  const statementUrl = \`\${window.location.origin}/s/\${p.statement_token}\`;
                  const waText = encodeURIComponent(\`Hi \${p.name}, here is your live statement (Balance: ₹\${p.balance}): \${statementUrl}\`);
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
                        <Link href={\`/s/\${p.statement_token}\`} target="_blank" className="text-center bg-emerald-500/15 text-emerald-300 font-bold py-2 rounded-xl text-xs">Open Live ↗</Link>
                        <button onClick={() => copyStatementUrl(p.statement_token)} className="bg-slate-800 text-slate-200 py-2 rounded-xl text-xs cursor-pointer">Copy Link</button>
                        <a href={\`https://wa.me/?text=\${waText}\`} target="_blank" rel="noreferrer" className="text-center bg-emerald-600/20 text-emerald-300 py-2 rounded-xl text-xs">WhatsApp</a>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                {customersList.map((p: any) => {
                  const statementUrl = \`\${window.location.origin}/s/\${p.statement_token}\`;
                  const waText = encodeURIComponent(\`Hi \${p.name}, statement link: \${statementUrl}\`);
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
                        <Link href={\`/s/\${p.statement_token}\`} target="_blank" className="text-center bg-emerald-500/15 text-emerald-300 font-bold py-2 rounded-xl text-xs">Open Live ↗</Link>
                        <button onClick={() => copyStatementUrl(p.statement_token)} className="bg-slate-800 text-slate-200 py-2 rounded-xl text-xs cursor-pointer">Copy Link</button>
                        <a href={\`https://wa.me/?text=\${waText}\`} target="_blank" rel="noreferrer" className="text-center bg-emerald-600/20 text-emerald-300 py-2 rounded-xl text-xs">WhatsApp</a>
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
          <button onClick={() => setTab("inbox")} className={\`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer \${tab === "inbox" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}\`}>Inbox ({drafts.length})</button>
          <button onClick={() => setTab("parties")} className={\`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer \${tab === "parties" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}\`}>Parties ({parties.length})</button>
          <button onClick={() => setTab("stock")} className={\`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer \${tab === "stock" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}\`}>Stock ({stock.length})</button>
          <button onClick={() => setTab("insights")} className={\`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer \${tab === "insights" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}\`}>Insights 📊</button>
        </div>
      </nav>
    </div>
  );
}
`
);

console.log("MULTI-ITEM & DYNAMIC UNIT TOGGLE APPLIED!");