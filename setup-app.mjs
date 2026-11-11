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
  const cleanName = (name || "Unknown Party").trim();
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

export function inferUnit(itemName: string, explicitUnit?: string) {
  if (explicitUnit && (explicitUnit === "pcs" || explicitUnit === "m")) {
    return explicitUnit;
  }
  const lower = (itemName || "").toLowerCase();
  if (
    lower.includes("saree") ||
    lower.includes("jean") ||
    lower.includes("shirt") ||
    lower.includes("kurti") ||
    lower.includes("dupatta") ||
    lower.includes("legging") ||
    lower.includes("pc") ||
    lower.includes("piece")
  ) {
    return "pcs";
  }
  return explicitUnit || "m";
}

export async function getOrCreateItem(shopId: string, name: string, unit?: string) {
  const sb = getSupabase();
  const cleanName = (name || "cloth").trim().toLowerCase();
  const resolvedUnit = inferUnit(cleanName, unit);
  const { data: existing } = await sb
    .from("items")
    .select("*")
    .eq("shop_id", shopId)
    .ilike("name", cleanName)
    .maybeSingle();

  if (existing) {
    if (unit && existing.unit !== resolvedUnit) {
      await sb.from("items").update({ unit: resolvedUnit }).eq("id", existing.id);
      existing.unit = resolvedUnit;
    }
    return existing;
  }

  const { data: created, error } = await sb
    .from("items")
    .insert({ shop_id: shopId, name: cleanName, unit: resolvedUnit })
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
      age_days: 1,
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
    const firstLine = eLines[0] || null;
    const totalQty = eLines.reduce((acc: number, l: any) => acc + (Number(l.qty) || 0), 0);
    const lineTotal = eLines.reduce(
      (acc: number, l: any) => acc + (Number(l.qty) || 0) * (Number(l.rate) || 0),
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
        cost += (Number(l.qty) || 0) * unitCost;
      }
      cost = Number(cost.toFixed(2));
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
      item: firstLine?.item || null,
      line_id: firstLine?.id || null,
      qty: totalQty,
      rate: firstLine ? Number(firstLine.rate) : 0,
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
    const itemCounts: Record<string, { qty: number; unit: string }> = {};

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
          const q = Number(l.qty) || 0;
          totalQty += q;
          if (l.item?.name) {
            const cur = itemCounts[l.item.name] || { qty: 0, unit: l.item.unit || "m" };
            cur.qty += q;
            itemCounts[l.item.name] = cur;
          }
        }
      } else if (e.type === "payment") {
        totalPaid += e.paid_amount;
      }
    }

    const topEntry = Object.entries(itemCounts).sort((a, b) => b[1].qty - a[1].qty)[0];
    const topItem = topEntry ? topEntry[0] : null;
    const topUnit = topEntry ? topEntry[1].unit : "m";
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
      } else if (paymentRatioPct >= 40 && profitMarginPct >= 15) {
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
      favorite_unit: topUnit,
      customer_tier: customerTier,
      ack,
      entries: pEntries,
    };
  });

  const stockList = Array.from(stockMap.values()).filter(
    (s) => s.purchased_qty > 0 || s.sold_qty > 0
  );
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

  return {
    kpis: {
      total_payables: totalPayables,
      total_receivables: totalReceivables,
      total_stock_value: totalShopStockValue,
      active_stock_value: activeStockValue,
      total_profit: totalBookedProfit,
      total_cash_collected: totalCashCollected,
      deadstock_value: deadstockValue,
      coverage_ratio: coverageRatio,
    },
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
        lines,
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

      if (Array.isArray(lines) && lines.length > 0) {
        for (const l of lines) {
          if (l.id) {
            await sb
              .from("entry_lines")
              .update({ qty: Number(l.qty), rate: Number(l.rate) })
              .eq("id", l.id);
          }
        }
      } else if (qty !== undefined || rate !== undefined) {
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
      const ramesh = await getOrCreateParty(shop.id, "Ramesh Traders", "customer");
      const kiran = await getOrCreateParty(shop.id, "Kiran Boutique", "customer");
      const mehta = await getOrCreateParty(shop.id, "Mehta Fabrics", "customer");

      const cotton = await getOrCreateItem(shop.id, "white cotton", "m");
      const velvet = await getOrCreateItem(shop.id, "red velvet", "m");

      const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
      const daysAhead = (d: number) => new Date(Date.now() + d * 86400000).toISOString();

      // 1. Purchase: Surat Silk Mills (50m red velvet @ ₹500/m = ₹25,000, paid full)
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

      // 2. Purchase: Shah Textiles (100m white cotton @ ₹340/m = ₹34,000, paid ₹14,000)
      const { data: e2 } = await sb
        .from("entries")
        .insert({
          shop_id: shop.id,
          type: "purchase",
          party_id: shah.id,
          bill_no: "4599",
          date: daysAgo(14),
          due_date: daysAhead(16),
          status: "confirmed",
          paid_amount: 14000,
        })
        .select("*")
        .single();
      await sb.from("entry_lines").insert({
        entry_id: e2.id,
        item_id: cotton.id,
        qty: 100,
        rate: 340,
      });

      // 3. Sale: Ramesh Traders (90m white cotton @ ₹420/m = ₹37,800, paid ₹30,000)
      const { data: e3 } = await sb
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
        entry_id: e3.id,
        item_id: cotton.id,
        qty: 90,
        rate: 420,
      });

      // 4. Sale: Kiran Boutique (10m white cotton @ ₹450/m = ₹4,500, paid ₹2,000)
      const { data: e4 } = await sb
        .from("entries")
        .insert({
          shop_id: shop.id,
          type: "sale",
          party_id: kiran.id,
          bill_no: "S-102",
          date: daysAgo(3),
          due_date: daysAhead(27),
          status: "confirmed",
          paid_amount: 2000,
        })
        .select("*")
        .single();
      await sb.from("entry_lines").insert({
        entry_id: e4.id,
        item_id: cotton.id,
        qty: 10,
        rate: 450,
      });

      // 5. Sale: Mehta Fabrics (5m red velvet @ ₹600/m = ₹3,000, paid ₹0)
      const { data: e5 } = await sb
        .from("entries")
        .insert({
          shop_id: shop.id,
          type: "sale",
          party_id: mehta.id,
          bill_no: "S-103",
          date: daysAgo(1),
          due_date: daysAhead(14),
          status: "confirmed",
          paid_amount: 0,
        })
        .select("*")
        .single();
      await sb.from("entry_lines").insert({
        entry_id: e5.id,
        item_id: velvet.id,
        qty: 5,
        rate: 600,
      });

      // 6. Payment to Shah Textiles: ₹20,000 via UPI
      await sb.from("entries").insert({
        shop_id: shop.id,
        type: "payment",
        party_id: shah.id,
        date: daysAgo(1),
        status: "confirmed",
        paid_amount: 20000,
        payment_method: "UPI",
      });

      const state = await computeLedgerState(shop.id);
      return NextResponse.json({ ok: true, state });
    }

    if (body.action === "create_draft") {
      const {
        type,
        party_name,
        items,
        item_name,
        unit,
        qty,
        rate,
        total_amount,
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

      if (type === "purchase" || type === "sale") {
        const rawItems =
          Array.isArray(items) && items.length > 0
            ? items
            : [
                {
                  item_name: item_name || "white cotton",
                  unit: unit || "m",
                  qty: Number(qty) || 1,
                  rate:
                    rate !== undefined && Number(rate) > 0
                      ? Number(rate)
                      : total_amount !== undefined && Number(qty) > 0
                      ? Number((Number(total_amount) / Number(qty)).toFixed(2))
                      : 0,
                },
              ];

        for (const it of rawItems) {
          const itemRec = await getOrCreateItem(shop.id, it.item_name || "cloth", it.unit);
          const q = Number(it.qty) || 1;
          const r =
            it.rate !== undefined && Number(it.rate) > 0
              ? Number(it.rate)
              : it.total_price !== undefined && q > 0
              ? Number((Number(it.total_price) / q).toFixed(2))
              : 0;
          await sb.from("entry_lines").insert({
            entry_id: entry.id,
            item_id: itemRec.id,
            qty: q,
            rate: r,
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

// 5. app/api/mcp/route.ts (Universal Polymorphic MCP Parser: handles rate OR total_amount, single item OR items[])
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
    description:
      "Record a vendor purchase bill as a draft entry. Supports either a single item (item_name, qty, rate or total_amount) OR multiple items via the items array.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string", description: "Vendor name, e.g. 'Sai Ram Textile'" },
        item_name: { type: "string", description: "Item name if single item, e.g. 'shirts'" },
        qty: { type: "number", description: "Quantity if single item" },
        unit: { type: "string", description: "'pcs' for pieces or 'm' for meters" },
        rate: { type: "number", description: "Rate per unit in INR (optional if total_amount is given)" },
        total_amount: { type: "number", description: "Total bill amount in INR" },
        items: {
          type: "array",
          description: "Optional list of multiple items purchased in one bill",
          items: {
            type: "object",
            properties: {
              item_name: { type: "string" },
              qty: { type: "number" },
              unit: { type: "string" },
              rate: { type: "number" },
              total_amount: { type: "number" },
            },
            required: ["item_name", "qty"],
          },
        },
        bill_no: { type: "string" },
        paid_amount: { type: "number", description: "Amount paid upfront in INR" },
        due_days: { type: "number" },
        days_ago: { type: "number" },
        idempotency_key: { type: "string" },
      },
      required: ["party_name"],
    },
  },
  {
    name: "create_sale",
    description:
      "Record a customer sale as a draft entry. Supports either a single item (item_name, qty, rate or total_amount) OR multiple items via the items array.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string", description: "Customer name, e.g. 'Ramesh Traders'" },
        item_name: { type: "string", description: "Item name if single item, e.g. 'sarees'" },
        qty: { type: "number", description: "Quantity sold" },
        unit: { type: "string", description: "'pcs' or 'm'" },
        rate: { type: "number", description: "Selling rate per unit in INR (optional if total_amount is given)" },
        total_amount: { type: "number", description: "Total sale bill amount in INR" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item_name: { type: "string" },
              qty: { type: "number" },
              unit: { type: "string" },
              rate: { type: "number" },
              total_amount: { type: "number" },
            },
            required: ["item_name", "qty"],
          },
        },
        bill_no: { type: "string" },
        paid_amount: { type: "number", description: "Amount paid upfront in INR" },
        due_days: { type: "number" },
        days_ago: { type: "number" },
        idempotency_key: { type: "string" },
      },
      required: ["party_name"],
    },
  },
  {
    name: "create_payment",
    description: "Record a payment made to a vendor or received from a customer.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string" },
        amount: { type: "number" },
        method: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["party_name", "amount"],
    },
  },
  {
    name: "get_stock",
    description: "Get stock quantity, weighted-average cost, sell-through velocity, and deadstock status.",
    inputSchema: { type: "object", properties: { item_name: { type: "string" } } },
  },
  {
    name: "get_party_balance",
    description: "Get vendor or customer balance and live statement link.",
    inputSchema: {
      type: "object",
      properties: { party_name: { type: "string" } },
      required: ["party_name"],
    },
  },
  {
    name: "list_outstanding",
    description: "List all vendors we owe and customers who owe us with statement links.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_business_insights",
    description:
      "Analyze working capital, sales revenue, booked profit, cash collected vs pending udhaar, customer tiers, and deadstock liquidation.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function executeTool(name: string, args: any, reqUrl: string, mcpKey?: string | null) {
  const sb = getSupabase();
  const shop = await getShop(mcpKey);
  const origin = new URL(reqUrl).origin;

  if (name === "create_purchase" || name === "create_sale") {
    const {
      party_name,
      item_name,
      qty,
      unit,
      rate,
      total_amount,
      items,
      paid_amount = 0,
      due_days,
      days_ago,
      bill_no,
    } = args || {};

    const defaultType = name === "create_sale" ? "customer" : "vendor";
    const party = await getOrCreateParty(shop.id, party_name, defaultType);
    const entryDate = days_ago
      ? new Date(Date.now() - Number(days_ago) * 86400000).toISOString()
      : new Date().toISOString();
    const dueDate = due_days
      ? new Date(new Date(entryDate).getTime() + Number(due_days) * 86400000).toISOString()
      : null;

    const { data: entry, error } = await sb
      .from("entries")
      .insert({
        shop_id: shop.id,
        type: name === "create_sale" ? "sale" : "purchase",
        party_id: party.id,
        bill_no: bill_no ? String(bill_no) : null,
        date: entryDate,
        due_date: dueDate,
        status: "draft",
        paid_amount: Number(paid_amount) || 0,
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    // Normalize single-item or multi-item input
    let rawLines: Array<{ item_name: string; qty: number; unit?: string; rate?: number; total_amount?: number }> = [];
    if (Array.isArray(items) && items.length > 0) {
      rawLines = items.map((it: any) => ({
        item_name: it.item_name || item_name || "cloth",
        qty: Number(it.qty) || 1,
        unit: it.unit || unit,
        rate: it.rate !== undefined ? Number(it.rate) : undefined,
        total_amount: it.total_amount !== undefined ? Number(it.total_amount) : undefined,
      }));
    } else {
      rawLines = [
        {
          item_name: item_name || "cloth",
          qty: Number(qty) || 1,
          unit,
          rate: rate !== undefined ? Number(rate) : undefined,
          total_amount: total_amount !== undefined ? Number(total_amount) : undefined,
        },
      ];
    }

    // If top-level total_amount was given for a multi-item bill without individual item rates, distribute across total qty
    const totalQtyAll = rawLines.reduce((acc, l) => acc + (Number(l.qty) || 0), 0);
    const hasAnyItemPrice = rawLines.some(
      (l) => (l.rate !== undefined && l.rate > 0) || (l.total_amount !== undefined && l.total_amount > 0)
    );
    const topLevelTotal = Number(total_amount) || 0;

    const summaryParts: string[] = [];
    let grandTotal = 0;

    for (const line of rawLines) {
      const q = Number(line.qty) || 1;
      let computedRate = 0;
      if (line.rate !== undefined && line.rate > 0) {
        computedRate = Number(line.rate);
      } else if (line.total_amount !== undefined && line.total_amount > 0 && q > 0) {
        computedRate = Number((line.total_amount / q).toFixed(2));
      } else if (!hasAnyItemPrice && topLevelTotal > 0 && totalQtyAll > 0) {
        computedRate = Number((topLevelTotal / totalQtyAll).toFixed(2));
      }

      const itemRec = await getOrCreateItem(shop.id, line.item_name, line.unit);
      await sb.from("entry_lines").insert({
        entry_id: entry.id,
        item_id: itemRec.id,
        qty: q,
        rate: computedRate,
      });

      const lineAmt = Number((q * computedRate).toFixed(2));
      grandTotal += lineAmt;
      summaryParts.push(\`\${q} \${itemRec.unit} \${itemRec.name} @ ₹\${computedRate}/\${itemRec.unit} = ₹\${lineAmt}\`);
    }

    const unpaid = Number((grandTotal - (Number(paid_amount) || 0)).toFixed(2));
    return \`Draft \${name === "create_sale" ? "Sale" : "Purchase"} saved in Inbox for \${party.name}: \${summaryParts.join(", ")} | Total: ₹\${grandTotal} | Paid: ₹\${paid_amount || 0} | Balance Due: ₹\${unpaid}\`;
  }

  if (name === "create_payment") {
    const { party_name, amount, method = "UPI" } = args || {};
    const { data: allParties = [] } = await sb.from("parties").select("*").eq("shop_id", shop.id);
    const matched =
      allParties.find((p: any) =>
        p.name.toLowerCase().includes(String(party_name).toLowerCase())
      ) || (await getOrCreateParty(shop.id, party_name, "vendor"));

    await sb.from("entries").insert({
      shop_id: shop.id,
      type: "payment",
      party_id: matched.id,
      status: "draft",
      paid_amount: Number(amount),
      payment_method: method,
    });
    return \`Draft Payment of ₹\${amount} (\${method}) saved in Inbox for \${matched.name}.\`;
  }

  if (name === "get_stock") {
    const state = await computeLedgerState(shop.id);
    if (state.stock.length === 0) return "No confirmed stock items yet.";
    return state.stock
      .map(
        (s: any) =>
          \`• \${s.name}: \${s.stock_qty} \${s.unit} in stock (In: \${s.purchased_qty}, Sold: \${s.sold_qty}, Weighted-Avg Cost: ₹\${s.avg_cost}/\${s.unit}, Locked Value: ₹\${s.stock_value}, Status: \${s.stock_status})\`
      )
      .join("\\n");
  }

  if (name === "get_party_balance") {
    const { party_name } = args || {};
    const state = await computeLedgerState(shop.id);
    const party = state.parties.find((p: any) =>
      p.name.toLowerCase().includes(String(party_name).toLowerCase())
    );
    if (!party) return \`Party "\${party_name}" not found.\`;
    return \`\${party.name} (\${party.type.toUpperCase()}): Total Billed ₹\${party.total_billed} | Total Paid ₹\${party.total_paid} | Outstanding Balance: ₹\${party.balance} | Live Statement: \${origin}/s/\${party.statement_token}\`;
  }

  if (name === "list_outstanding") {
    const state = await computeLedgerState(shop.id);
    const vendors = state.parties.filter((p: any) => p.type === "vendor");
    const customers = state.parties.filter((p: any) => p.type === "customer");
    const vText =
      vendors.length > 0
        ? vendors.map((p: any) => \`• \${p.name}: You Owe ₹\${p.balance} (\${origin}/s/\${p.statement_token})\`).join("\\n")
        : "None";
    const cText =
      customers.length > 0
        ? customers.map((p: any) => \`• \${p.name} [\${p.customer_tier}]: Owes You ₹\${p.balance} (\${origin}/s/\${p.statement_token})\`).join("\\n")
        : "None";
    return \`=== Vendors You Owe (Total: ₹\${state.kpis.total_payables}) ===\\n\${vText}\\n\\n=== Customers Who Owe You (Total: ₹\${state.kpis.total_receivables}) ===\\n\${cText}\`;
  }

  if (name === "get_business_insights") {
    const state = await computeLedgerState(shop.id);
    const totalSales = state.parties
      .filter((p: any) => p.type === "customer")
      .reduce((acc: number, c: any) => acc + c.total_billed, 0);
    return \`=== MCP Server Business Insights ===\\n• Total Sales Revenue: ₹\${totalSales}\\n• Total Booked Profit: +₹\${state.kpis.total_profit}\\n• Cash Collected in Hand/Bank: ₹\${state.kpis.total_cash_collected}\\n• Pending Customer Udhaar: ₹\${state.kpis.total_receivables}\\n• Vendor Payables Due: ₹\${state.kpis.total_payables}\\n• Active Stock Value: ₹\${state.kpis.total_stock_value} (At-Risk Deadstock: ₹\${state.kpis.deadstock_value})\`;
  }

  throw new Error(\`Unknown tool: \${name}\`);
}

async function handleJsonRpcMessage(msg: any, reqUrl: string, mcpKey?: string | null) {
  const { id, method, params } = msg || {};
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-server", version: "2.0.0" },
      },
    };
  }
  if (
    method === "notifications/initialized" ||
    method === "notifications/cancelled" ||
    method === "ping"
  ) {
    return null;
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (method === "tools/call") {
    try {
      const text = await executeTool(params?.name, params?.arguments || {}, reqUrl, mcpKey);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }], isError: false },
      };
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: \`Error: \${err.message}\` }], isError: true },
      };
    }
  }
  return null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const shop = await getShop(searchParams.get("key"));
  return NextResponse.json(
    { name: "MCP Server", status: "live", shop: shop?.name },
    { headers: CORS_HEADERS }
  );
}
export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const mcpKey = searchParams.get("key");
    const body = await req.json();
    if (Array.isArray(body)) {
      const res = [];
      for (const item of body) {
        const r = await handleJsonRpcMessage(item, req.url, mcpKey);
        if (r) res.push(r);
      }
      return NextResponse.json(res, { headers: CORS_HEADERS });
    }
    const res = await handleJsonRpcMessage(body, req.url, mcpKey);
    return NextResponse.json(res, { headers: CORS_HEADERS });
  } catch (err: any) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: err.message } },
      { status: 400, headers: CORS_HEADERS }
    );
  }
}
export async function DELETE() {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}
`
);

// 6. app/page.tsx (Full Restored UI + Multi-Item Manual Form + Unit Toggles + Editable Drafts)
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
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedMcp, setCopiedMcp] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [invoiceEntry, setInvoiceEntry] = useState<any>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [localAcks, setLocalAcks] = useState<Record<string, any>>({});

  // Multi-item manual entry state with dynamic m/pcs unit toggle
  const [formType, setFormType] = useState<"purchase" | "sale" | "payment">("purchase");
  const [partyName, setPartyName] = useState("Sai Ram Textile");
  const [paidAmount, setPaidAmount] = useState("8000");
  const [billNo, setBillNo] = useState("SR-99");
  const [dueDays, setDueDays] = useState("30");
  const [paymentMethod, setPaymentMethod] = useState("UPI");
  const [itemsList, setItemsList] = useState([
    { item_name: "sarees", unit: "pcs", qty: "50", total_price: "10000", rate: "200" },
  ]);

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

  function updateItemRow(index: number, field: string, value: any) {
    const updated = [...itemsList];
    updated[index] = { ...updated[index], [field]: value };
    const qty = Number(updated[index].qty) || 0;

    if (field === "total_price" && qty > 0) {
      const tot = Number(value) || 0;
      updated[index].rate = Number((tot / qty).toFixed(2)).toString();
    } else if ((field === "rate" || field === "qty") && qty > 0) {
      const r = Number(updated[index].rate) || 0;
      updated[index].total_price = Number((qty * r).toFixed(2)).toString();
    }
    setItemsList(updated);
  }

  function addItemRow() {
    setItemsList([
      ...itemsList,
      { item_name: "", unit: "pcs", qty: "10", total_price: "1000", rate: "100" },
    ]);
  }

  function removeItemRow(index: number) {
    if (itemsList.length === 1) return;
    setItemsList(itemsList.filter((_, i) => i !== index));
  }

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
        current.paid_amount !== undefined ? Number(current.paid_amount) : entry.paid_amount,
      bill_no: current.bill_no !== undefined ? current.bill_no : entry.bill_no,
      due_days: current.due_days !== undefined ? Number(current.due_days) : entry.due_days,
      payment_method:
        current.payment_method !== undefined ? current.payment_method : entry.payment_method,
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
    if (!confirm("Reset all bills, parties, and stock?")) return;
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
      body: JSON.stringify({
        action: "create_draft",
        type: formType,
        party_name: partyName,
        paid_amount: Number(paidAmount) || 0,
        bill_no: billNo,
        due_days: Number(dueDays) || 0,
        payment_method: paymentMethod,
        items: itemsList.map((it) => ({
          item_name: it.item_name || "cloth",
          unit: it.unit,
          qty: Number(it.qty) || 1,
          rate: Number(it.rate) || 0,
        })),
      }),
    });
    setShowQuickAdd(false);
    await loadData();
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
  const kpis = data?.kpis || {
    total_payables: 0,
    total_receivables: 0,
    total_stock_value: 0,
    total_profit: 0,
    total_cash_collected: 0,
    deadstock_value: 0,
    coverage_ratio: 0,
  };

  const vendorsList = parties.filter((p: any) => p.type === "vendor");
  const customersList = parties
    .filter((p: any) => p.type === "customer")
    .sort((a: any, b: any) => b.total_profit - a.total_profit);
  const deadOrSlowStock = stock.filter(
    (s: any) => s.stock_status === "DEADSTOCK" || s.stock_status === "SLOW_MOVING"
  );

  const filteredConfirmed = confirmed.filter((c: any) => {
    if (inboxSubTab === "sales") return c.type === "sale";
    if (inboxSubTab === "purchases") return c.type === "purchase";
    if (inboxSubTab === "payments") return c.type === "payment";
    return true;
  });

  const totalSalesRevenue = confirmed
    .filter((c: any) => c.type === "sale")
    .reduce((acc: number, c: any) => acc + c.total_amount, 0);
  const totalSalesProfit = confirmed
    .filter((c: any) => c.type === "sale")
    .reduce((acc: number, c: any) => acc + c.profit, 0);

  const manualFormTotal =
    formType === "payment"
      ? Number(paidAmount) || 0
      : itemsList.reduce(
          (acc, it) => acc + (Number(it.qty) || 0) * (Number(it.rate) || 0),
          0
        );
  const manualFormUnpaid =
    formType === "payment" ? 0 : Math.max(0, manualFormTotal - (Number(paidAmount) || 0));

  return (
    <div className="min-h-screen bg-slate-950 text-white pb-24 flex flex-col items-center">
      {/* Top Header */}
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
        {!isAdmin && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between text-xs">
            <div className="pr-2">
              <p className="font-semibold text-slate-200">🔒 Guest Read-Only Mode</p>
              <p className="text-[11px] text-slate-400">
                Sign in as Admin to confirm drafts or manage shop keys.
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

        {/* 4 Scoreboard KPI Cards */}
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
            <p className="text-[10px] text-slate-400">Booked Profit</p>
            <p className="text-xs font-extrabold text-emerald-400 mt-0.5">
              +₹{Number(kpis.total_profit).toLocaleString("en-IN")}
            </p>
          </div>
        </div>

        {/* Multi-Item Labeled Manual Entry Form */}
        {isAdmin && showQuickAdd && (
          <form
            onSubmit={handleQuickAdd}
            className="bg-slate-900 border border-emerald-500/40 rounded-2xl p-4 space-y-3 shadow-xl"
          >
            <div className="flex justify-between items-start">
              <div>
                <span className="text-xs font-bold text-emerald-400 uppercase block">
                  Create Manual Draft Entry
                </span>
                <span className="text-[11px] text-slate-400">
                  Add one or multiple items (meters or pieces) under a single bill.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowQuickAdd(false)}
                className="text-xs text-slate-400 hover:text-white px-2 py-0.5 cursor-pointer"
              >
                Close ✕
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-1">
              {(["purchase", "sale", "payment"] as const).map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={() => {
                    setFormType(t);
                    if (t === "sale") {
                      setPartyName("Ramesh Traders");
                      setPaidAmount("5000");
                    } else if (t === "purchase") {
                      setPartyName("Sai Ram Textile");
                      setPaidAmount("8000");
                    } else {
                      setPartyName("Sai Ram Textile");
                      setPaidAmount("8000");
                    }
                  }}
                  className={\`py-1.5 rounded-lg text-xs font-semibold uppercase border cursor-pointer \${
                    formType === t
                      ? "bg-emerald-500 text-slate-950 border-emerald-400"
                      : "bg-slate-800 text-slate-300 border-slate-700"
                  }\`}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <div>
                <label className="text-[11px] text-slate-400 block mb-1 font-medium">
                  {formType === "sale" ? "Customer Name" : "Vendor / Party Name"}
                </label>
                <input
                  placeholder="e.g. Sai Ram Textile"
                  value={partyName}
                  onChange={(e) => setPartyName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                />
              </div>

              <div>
                <label className="text-[11px] text-slate-400 block mb-1 font-medium">
                  {formType === "payment" ? "Payment Amount (₹)" : "Paid Upfront Now (₹)"}
                </label>
                <input
                  type="number"
                  placeholder="0 if full credit"
                  value={paidAmount}
                  onChange={(e) => setPaidAmount(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-emerald-300"
                />
              </div>

              {formType !== "payment" ? (
                <>
                  <div>
                    <label className="text-[11px] text-slate-400 block mb-1 font-medium">
                      Bill No.
                    </label>
                    <input
                      placeholder="SR-99"
                      value={billNo}
                      onChange={(e) => setBillNo(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-slate-400 block mb-1 font-medium">
                      Due (Days)
                    </label>
                    <input
                      type="number"
                      placeholder="30"
                      value={dueDays}
                      onChange={(e) => setDueDays(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="text-[11px] text-slate-400 block mb-1 font-medium">
                      Payment Method
                    </label>
                    <input
                      placeholder="UPI / Cash / Bank"
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-slate-400 block mb-1 font-medium">
                      Reference / Bill No.
                    </label>
                    <input
                      placeholder="Optional"
                      value={billNo}
                      onChange={(e) => setBillNo(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white"
                    />
                  </div>
                </>
              )}
            </div>

            {formType !== "payment" && (
              <div className="space-y-2.5 pt-2 border-t border-slate-800">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold text-slate-200">
                    Bill Items ({itemsList.length})
                  </span>
                  <button
                    type="button"
                    onClick={addItemRow}
                    className="text-[11px] bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 px-2.5 py-1 rounded-lg font-bold cursor-pointer"
                  >
                    + Add Another Item
                  </button>
                </div>

                {itemsList.map((it, idx) => (
                  <div
                    key={idx}
                    className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2.5"
                  >
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <label className="text-[10px] text-slate-400 block mb-1">
                          Cloth / Item Name
                        </label>
                        <input
                          placeholder="e.g. sarees, jeans, white cotton"
                          value={it.item_name}
                          onChange={(e) => updateItemRow(idx, "item_name", e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-400 block mb-1">
                          Unit Toggle
                        </label>
                        <div className="grid grid-cols-2 bg-slate-900 border border-slate-700 rounded-lg p-0.5 text-[11px]">
                          <button
                            type="button"
                            onClick={() => updateItemRow(idx, "unit", "pcs")}
                            className={\`px-2 py-1 rounded font-bold cursor-pointer \${
                              it.unit === "pcs"
                                ? "bg-amber-500 text-slate-950"
                                : "text-slate-400 hover:text-white"
                            }\`}
                          >
                            Pieces (pcs)
                          </button>
                          <button
                            type="button"
                            onClick={() => updateItemRow(idx, "unit", "m")}
                            className={\`px-2 py-1 rounded font-bold cursor-pointer \${
                              it.unit === "m"
                                ? "bg-amber-500 text-slate-950"
                                : "text-slate-400 hover:text-white"
                            }\`}
                          >
                            Meters (m)
                          </button>
                        </div>
                      </div>
                      {itemsList.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItemRow(idx)}
                          className="text-xs text-rose-400 hover:text-rose-300 px-2 py-1.5 bg-slate-900 border border-slate-800 rounded-lg cursor-pointer"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="text-[10px] text-slate-400 block mb-1">
                          Quantity ({it.unit === "pcs" ? "pieces" : "meters"})
                        </label>
                        <input
                          type="number"
                          value={it.qty}
                          onChange={(e) => updateItemRow(idx, "qty", e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-400 block mb-1">
                          Rate per {it.unit === "pcs" ? "Piece (₹/pcs)" : "Meter (₹/m)"}
                        </label>
                        <input
                          type="number"
                          value={it.rate}
                          onChange={(e) => updateItemRow(idx, "rate", e.target.value)}
                          className="w-full bg-slate-900 border border-amber-500/60 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-amber-200"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-400 block mb-1">
                          Item Total (₹)
                        </label>
                        <input
                          type="number"
                          value={it.total_price}
                          onChange={(e) => updateItemRow(idx, "total_price", e.target.value)}
                          className="w-full bg-slate-900 border border-emerald-500/50 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-300"
                        />
                      </div>
                    </div>
                  </div>
                ))}

                <div className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 flex justify-between items-center text-xs">
                  <span className="text-slate-400">
                    Total Bill: <strong className="text-white">₹{manualFormTotal.toLocaleString("en-IN")}</strong>
                  </span>
                  <span className="text-amber-300 font-bold">
                    Yet to Pay (Udhaar): ₹{manualFormUnpaid.toLocaleString("en-IN")}
                  </span>
                </div>
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold py-2.5 rounded-xl text-xs cursor-pointer transition"
            >
              + Save Draft to Inbox
            </button>
          </form>
        )}

        {loading && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-xs text-slate-400">
            Loading MCP Server ledger...
          </div>
        )}

        {/* TAB 1: INBOX WITH INTERACTIVE DRAFTS & FILTER PILLS */}
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
                  <p className="text-xs text-slate-300 font-medium">No unconfirmed drafts</p>
                  <p className="text-[11px] text-slate-400">
                    Tell Claude about a purchase, sale, or payment to queue a draft here.
                  </p>
                </div>
              )}

              {drafts.map((d: any) => {
                const isMulti = (d.lines?.length || 0) > 1;
                const editQty = Number(getEditVal(d, "qty")) || 0;
                const editRate = Number(getEditVal(d, "rate")) || 0;
                const editPaid = Number(getEditVal(d, "paid_amount")) || 0;
                const liveTotal =
                  d.type === "payment"
                    ? editPaid
                    : isMulti
                    ? d.total_amount
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
                        {!isMulti && d.item && (
                          <p className="text-xs text-slate-400">
                            Item: <span className="text-slate-200">{d.item.name}</span> (
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

                    {isMulti && (
                      <div className="space-y-1.5 bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                        <p className="text-[11px] text-slate-400 font-semibold">
                          Bundled Bill Items ({d.lines.length}):
                        </p>
                        {d.lines.map((l: any, i: number) => (
                          <div key={i} className="flex justify-between text-xs text-slate-200">
                            <span className="capitalize">
                              • {l.qty} {l.item?.unit || "pcs"} {l.item?.name}
                            </span>
                            <span className="font-bold text-amber-200">
                              ₹{(Number(l.qty) * Number(l.rate)).toLocaleString("en-IN")} (@₹
                              {l.rate}/{l.item?.unit || "pcs"})
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {d.type !== "payment" ? (
                      <div className="grid grid-cols-2 gap-2.5 pt-1">
                        {!isMulti && (
                          <>
                            <div>
                              <label className="text-[11px] text-slate-400 block mb-1">
                                Quantity ({d.item?.unit || "pcs"})
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
                                Rate (₹/{d.item?.unit || "pcs"})
                              </label>
                              <input
                                type="number"
                                disabled={!isAdmin}
                                value={getEditVal(d, "rate")}
                                onChange={(e) => setEditVal(d.id, "rate", e.target.value)}
                                className="w-full bg-slate-950 border border-amber-500/60 disabled:opacity-60 rounded-xl px-3 py-2 text-sm font-semibold text-amber-200"
                              />
                            </div>
                          </>
                        )}
                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Paid Now (₹)
                          </label>
                          <input
                            type="number"
                            disabled={!isAdmin}
                            value={getEditVal(d, "paid_amount")}
                            onChange={(e) => setEditVal(d.id, "paid_amount", e.target.value)}
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
                              onChange={(e) => setEditVal(d.id, "bill_no", e.target.value)}
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
                              onChange={(e) => setEditVal(d.id, "due_days", e.target.value)}
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
                            onChange={(e) => setEditVal(d.id, "paid_amount", e.target.value)}
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
                            onChange={(e) => setEditVal(d.id, "payment_method", e.target.value)}
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
                          {busyId === d.id ? "Posting..." : "✓ Confirm & Post to Ledger"}
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

            {/* Confirmed Ledger History with Filter Pills */}
            <div className="space-y-3 pt-2">
              <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <h2 className="text-sm font-bold text-slate-300">
                    Confirmed Ledger Entries ({filteredConfirmed.length})
                  </h2>
                </div>

                <div className="grid grid-cols-4 gap-1.5 bg-slate-900 p-1.5 rounded-xl border border-slate-800">
                  <button
                    onClick={() => setInboxSubTab("all")}
                    className={\`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer \${
                      inboxSubTab === "all"
                        ? "bg-emerald-500 text-slate-950"
                        : "text-slate-400 hover:text-white"
                    }\`}
                  >
                    All ({confirmed.length})
                  </button>
                  <button
                    onClick={() => setInboxSubTab("sales")}
                    className={\`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer \${
                      inboxSubTab === "sales"
                        ? "bg-emerald-500 text-slate-950"
                        : "text-slate-400 hover:text-white"
                    }\`}
                  >
                    Sales ({confirmed.filter((c: any) => c.type === "sale").length})
                  </button>
                  <button
                    onClick={() => setInboxSubTab("purchases")}
                    className={\`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer \${
                      inboxSubTab === "purchases"
                        ? "bg-emerald-500 text-slate-950"
                        : "text-slate-400 hover:text-white"
                    }\`}
                  >
                    Purchases ({confirmed.filter((c: any) => c.type === "purchase").length})
                  </button>
                  <button
                    onClick={() => setInboxSubTab("payments")}
                    className={\`py-1.5 rounded-lg text-[11px] font-bold cursor-pointer \${
                      inboxSubTab === "payments"
                        ? "bg-emerald-500 text-slate-950"
                        : "text-slate-400 hover:text-white"
                    }\`}
                  >
                    Payments ({confirmed.filter((c: any) => c.type === "payment").length})
                  </button>
                </div>

                {inboxSubTab === "sales" && (
                  <div className="bg-slate-900 border border-emerald-500/30 rounded-xl p-3 flex justify-between items-center text-xs">
                    <div>
                      <p className="text-slate-400">Total Filtered Sales Revenue</p>
                      <p className="text-base font-extrabold text-white">
                        ₹{totalSalesRevenue.toLocaleString("en-IN")}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-slate-400">Total Profit Generated</p>
                      <p className="text-base font-extrabold text-emerald-400">
                        +₹{totalSalesProfit.toLocaleString("en-IN")}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {filteredConfirmed.length === 0 && (
                <p className="text-xs text-slate-500 text-center py-4">
                  No confirmed entries match this filter.
                </p>
              )}

              {filteredConfirmed.map((c: any) => (
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
                          <span className="text-xs text-slate-400">Bill #{c.bill_no}</span>
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
                          title="Delete entry"
                          className="text-xs text-slate-500 hover:text-rose-400 px-1.5 py-0.5 rounded bg-slate-800/60 cursor-pointer"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {c.lines && c.lines.length > 0 && (
                    <div className="space-y-1">
                      {c.lines.map((l: any, idx: number) => (
                        <p key={idx} className="text-xs text-slate-300">
                          {c.type === "purchase" ? "+" : "-"}
                          {l.qty} {l.item?.unit || "m"} {l.item?.name} @ ₹{l.rate}/
                          {l.item?.unit || "m"}
                        </p>
                      ))}
                    </div>
                  )}

                  {c.type === "sale" && (
                    <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                      <div>
                        <span className="text-slate-400 block">Stock Out</span>
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
                        <span className="text-slate-400 block">Booked Profit</span>
                        <span className="font-bold text-emerald-400">
                          +₹{Number(c.profit).toLocaleString("en-IN")}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="pt-1 flex justify-between items-center text-[11px] text-slate-500">
                    <span>
                      {new Date(c.date).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
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

        {/* TAB 2: PARTIES WITH VENDORS VS CUSTOMERS SUB-TABS */}
        {!loading && tab === "parties" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-200">Party Balances</h2>
            </div>

            <div className="grid grid-cols-2 gap-2 bg-slate-900 p-1.5 rounded-xl border border-slate-800">
              <button
                onClick={() => setPartySubTab("vendors")}
                className={\`py-2 rounded-lg text-xs font-bold cursor-pointer \${
                  partySubTab === "vendors"
                    ? "bg-amber-500 text-slate-950"
                    : "text-slate-400 hover:text-white"
                }\`}
              >
                📦 Vendors You Owe ({vendorsList.length})
              </button>
              <button
                onClick={() => setPartySubTab("customers")}
                className={\`py-2 rounded-lg text-xs font-bold cursor-pointer \${
                  partySubTab === "customers"
                    ? "bg-sky-500 text-slate-950"
                    : "text-slate-400 hover:text-white"
                }\`}
              >
                🛍️ Customers Who Owe ({customersList.length})
              </button>
            </div>

            {partySubTab === "vendors" ? (
              <div className="space-y-3 pt-1">
                {vendorsList.length === 0 && (
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-400">
                    No vendor credits. All supplier bills are settled!
                  </div>
                )}
                {vendorsList.map((p: any) => {
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
                            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-amber-500/15 text-amber-300">
                              VENDOR
                            </span>
                            {ack?.status === "verified" && (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                ✓ Verified by {p.name}
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
                            {p.balance === 0 ? "Status" : "You Owe (Payable)"}
                          </p>
                          {p.balance === 0 ? (
                            <p className="text-sm font-extrabold text-emerald-400 mt-0.5">
                              ✓ Settled (₹0)
                            </p>
                          ) : (
                            <p className="text-xl font-extrabold text-amber-400">
                              ₹{Number(p.balance).toLocaleString("en-IN")}
                            </p>
                          )}
                        </div>
                      </div>

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
            ) : (
              <div className="space-y-3 pt-1">
                {customersList.length === 0 && (
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-400">
                    No customer sales recorded yet.
                  </div>
                )}
                {customersList.map((p: any) => {
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
                            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-sky-500/15 text-sky-300">
                              CUSTOMER
                            </span>
                            <span
                              className={\`text-[10px] font-bold px-2 py-0.5 rounded \${
                                p.customer_tier === "VIP Cash Buyer"
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : p.customer_tier === "High-Margin Credit"
                                  ? "bg-amber-500/15 text-amber-300"
                                  : "bg-rose-500/15 text-rose-300"
                              }\`}
                            >
                              {p.customer_tier}
                            </span>
                            {ack?.status === "verified" && (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                ✓ Verified by {p.name}
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
                            {p.balance === 0 ? "Status" : "Owes You (Receivable)"}
                          </p>
                          {p.balance === 0 ? (
                            <p className="text-sm font-extrabold text-emerald-400 mt-0.5">
                              ✓ Settled (₹0)
                            </p>
                          ) : (
                            <p className="text-xl font-extrabold text-sky-400">
                              ₹{Number(p.balance).toLocaleString("en-IN")}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2 text-[11px] bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                        <div>
                          <span className="text-slate-400 block">Booked Profit</span>
                          <span className="font-bold text-emerald-400">
                            +₹{Number(p.total_profit).toLocaleString("en-IN")} (
                            {p.profit_margin_pct}%)
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400 block">Avg Rate Paid</span>
                          <span className="font-bold text-sky-300">
                            ₹{p.avg_rate_paid}/{p.favorite_unit || "m"}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400 block">Credit Risk</span>
                          <span className="font-bold text-slate-200">
                            {p.payment_ratio_pct}% Paid
                          </span>
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
          </div>
        )}

        {/* TAB 3: STOCK & DEADSTOCK RADAR */}
        {!loading && tab === "stock" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-200">
                Stock & Velocity ({stock.length})
              </h2>
              {kpis.deadstock_value > 0 && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30 font-bold">
                  At-Risk: ₹{Number(kpis.deadstock_value).toLocaleString("en-IN")}
                </span>
              )}
            </div>

            {stock.length === 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-400">
                No stock items yet. Confirm a purchase first.
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
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h3 className="text-base font-bold capitalize">{s.name}</h3>
                        {isDead && (
                          <span className="text-[10px] font-extrabold px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
                            🔴 DEADSTOCK • {s.age_days}d Unsold
                          </span>
                        )}
                        {isSlow && (
                          <span className="text-[10px] font-extrabold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300">
                            🟡 SLOW MOVING ({s.sell_through_pct}%)
                          </span>
                        )}
                        {s.stock_status === "FAST_MOVING" && (
                          <span className="text-[10px] font-extrabold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                            🟢 FAST MOVING ({s.sell_through_pct}% Sold)
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 mt-1">
                        In: {s.purchased_qty} {s.unit} • Sold: {s.sold_qty} {s.unit} •{" "}
                        {s.locked_share_pct}% of capital
                      </p>
                      <p className="text-xs text-emerald-400 font-semibold mt-0.5">
                        Weighted-Avg Cost: ₹{s.avg_cost}/{s.unit}
                        {s.avg_selling_rate > 0
                          ? \` • Avg Sell Rate: ₹\${s.avg_selling_rate}/\${s.unit}\`
                          : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-extrabold text-white">
                        {s.stock_qty}{" "}
                        <span className="text-sm font-normal text-slate-400">{s.unit}</span>
                      </p>
                      <p className="text-[11px] text-slate-400">
                        Locked: ₹{Number(s.stock_value).toLocaleString("en-IN")}
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
                          isDead ? "bg-rose-500" : isSlow ? "bg-amber-400" : "bg-emerald-400"
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

        {/* TAB 4: INSIGHTS (ALL 3 RICH SECTIONS RESTORED) */}
        {!loading && tab === "insights" && (
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-emerald-400">
                  1. Profit & Cash Collection Overview
                </h2>
                <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-semibold">
                  Udhaar Health
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
                  <p className="text-[11px] text-slate-400">Total Booked Profit</p>
                  <p className="text-lg font-extrabold text-emerald-400 mt-0.5">
                    +₹{Number(kpis.total_profit).toLocaleString("en-IN")}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    Exact profit earned on sales
                  </p>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
                  <p className="text-[11px] text-slate-400">Cash Collected in Bank/Hand</p>
                  <p className="text-lg font-extrabold text-sky-400 mt-0.5">
                    ₹{Number(kpis.total_cash_collected).toLocaleString("en-IN")}
                  </p>
                  <p className="text-[10px] text-sky-300/90 mt-0.5">
                    ₹{Number(kpis.total_receivables).toLocaleString("en-IN")} pending in
                    customer udhaar
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-sky-400">
                  2. Customer Buying & Pricing Matrix
                </h2>
                <span className="text-[10px] text-slate-400">Volume vs. Margin</span>
              </div>

              {customersList.length === 0 ? (
                <p className="text-xs text-slate-400">No customer sales confirmed yet.</p>
              ) : (
                <div className="space-y-2.5">
                  {customersList.map((c: any) => (
                    <div
                      key={c.id}
                      className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2"
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <h3 className="text-sm font-bold text-white">{c.name}</h3>
                            <span
                              className={\`text-[10px] font-bold px-2 py-0.5 rounded \${
                                c.customer_tier === "VIP Cash Buyer"
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : c.customer_tier === "High-Margin Credit"
                                  ? "bg-amber-500/15 text-amber-300"
                                  : "bg-rose-500/15 text-rose-300"
                              }\`}
                            >
                              {c.customer_tier}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            Buys:{" "}
                            <strong className="text-slate-200 capitalize">
                              {c.total_qty} {c.favorite_unit || "m"} {c.favorite_item || "cloth"}
                            </strong>{" "}
                            • AOV: ₹{Number(c.aov).toLocaleString("en-IN")}
                          </p>
                        </div>
                        <div className="text-right">
                          <span className="text-xs font-extrabold text-sky-300">
                            Pays ₹{c.avg_rate_paid}/{c.favorite_unit || "m"}
                          </span>
                          <p className="text-[10px] text-slate-400">
                            Margin: {c.profit_margin_pct}%
                          </p>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2 pt-1 border-t border-slate-800/80 text-[11px]">
                        <div>
                          <span className="text-slate-400 block">Booked Profit</span>
                          <span className="font-bold text-emerald-400">
                            +₹{Number(c.total_profit).toLocaleString("en-IN")}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400 block">Total Paid</span>
                          <span className="font-bold text-sky-300">
                            ₹{Number(c.total_paid).toLocaleString("en-IN")}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400 block">Pending Udhaar</span>
                          <span className="font-bold text-amber-400">
                            ₹{Number(c.balance).toLocaleString("en-IN")}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-rose-400">
                  3. Deadstock Liquidation & Capital Unlock
                </h2>
                <span className="text-[10px] text-slate-400">Break-Even Simulator</span>
              </div>

              {deadOrSlowStock.length === 0 ? (
                <p className="text-xs text-emerald-400">
                  ✓ Zero deadstock! All cloth items have healthy sell-through velocity.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {deadOrSlowStock.map((s: any) => (
                    <div
                      key={s.item_id}
                      className="bg-slate-950 border border-rose-500/40 rounded-xl p-3 space-y-2"
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <h3 className="text-sm font-bold capitalize text-white">
                              {s.name}
                            </h3>
                            <span className="text-[10px] font-extrabold px-2 py-0.5 rounded bg-rose-500/20 text-rose-300">
                              {s.age_days} Days Unsold
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            {s.stock_qty} {s.unit} sitting idle •{" "}
                            <strong className="text-rose-300">
                              {s.locked_share_pct}% of shop capital
                            </strong>
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-extrabold text-rose-400">
                            ₹{Number(s.stock_value).toLocaleString("en-IN")}
                          </p>
                          <p className="text-[10px] text-slate-400">Locked Capital</p>
                        </div>
                      </div>

                      <div className="bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-[11px] space-y-1">
                        <p className="text-slate-300">
                          • <strong className="text-emerald-300">Break-Even Clearance:</strong>{" "}
                          Sell at{" "}
                          <strong>
                            ₹{s.clearance_breakeven_rate}/{s.unit}
                          </strong>{" "}
                          to recover{" "}
                          <strong>₹{Number(s.stock_value).toLocaleString("en-IN")}</strong>.
                        </p>
                        <p className="text-slate-400">
                          • <strong className="text-amber-300">Fast 10% Markdown:</strong> Sell
                          at{" "}
                          <strong>
                            ₹{s.clearance_10pct_rate}/{s.unit}
                          </strong>{" "}
                          to immediately unlock{" "}
                          <strong>
                            ₹{Math.round(s.stock_qty * s.clearance_10pct_rate).toLocaleString("en-IN")}
                          </strong>{" "}
                          cash.
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Admin Settings Modal */}
      {isAdmin && showAdminModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
            <div className="flex justify-between items-start border-b border-slate-800 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                  ● Admin Session Active
                </span>
                <h3 className="text-base font-bold mt-1">Ravi — Shop Owner Controls</h3>
                <p className="text-xs text-slate-400">admin@mcpserver.com</p>
              </div>
              <button
                onClick={() => setShowAdminModal(false)}
                className="text-slate-400 hover:text-white text-sm px-2 py-1 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 block">
                Your Private Claude MCP Connector URL
              </label>
              <div className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs">
                <code className="text-emerald-400 truncate mr-2">/api/mcp?key=ravi123</code>
                <button
                  onClick={copyMcpUrl}
                  className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold px-2.5 py-1 rounded-lg text-[11px] shrink-0 cursor-pointer"
                >
                  {copiedMcp ? "✓ Copied!" : "Copy Full URL"}
                </button>
              </div>
            </div>

            <div className="border-t border-slate-800 pt-3">
              <button
                type="button"
                onClick={() => setShowDevTools(!showDevTools)}
                className="w-full flex items-center justify-between text-xs text-slate-400 hover:text-slate-200 font-medium cursor-pointer"
              >
                <span>{showDevTools ? "▾" : "▸"} Developer & Demo Utilities</span>
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
                Sign Out
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

      {/* Printable Invoice Modal */}
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
              {invoiceEntry.lines && invoiceEntry.lines.length > 0 && (
                <div className="space-y-1 pt-2 border-t border-slate-800">
                  {invoiceEntry.lines.map((l: any, i: number) => (
                    <div key={i} className="flex justify-between">
                      <span className="text-slate-300 capitalize">
                        {l.qty} {l.item?.unit || "m"} {l.item?.name} × ₹{l.rate}
                      </span>
                      <span className="font-semibold text-white">
                        ₹{(Number(l.qty) * Number(l.rate)).toLocaleString("en-IN")}
                      </span>
                    </div>
                  ))}
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

      {/* 4-Tab Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 bg-slate-900/95 backdrop-blur border-t border-slate-800 flex justify-center">
        <div className="w-full max-w-md grid grid-cols-4 py-2 px-3 gap-1.5">
          <button
            onClick={() => setTab("inbox")}
            className={\`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer \${
              tab === "inbox"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }\`}
          >
            Inbox ({drafts.length})
          </button>
          <button
            onClick={() => setTab("parties")}
            className={\`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer \${
              tab === "parties"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }\`}
          >
            Parties ({parties.length})
          </button>
          <button
            onClick={() => setTab("stock")}
            className={\`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer \${
              tab === "stock"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }\`}
          >
            Stock ({stock.length})
          </button>
          <button
            onClick={() => setTab("insights")}
            className={\`py-2.5 rounded-xl text-[11px] font-bold cursor-pointer \${
              tab === "insights"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }\`}
          >
            Insights 📊
          </button>
        </div>
      </nav>
    </div>
  );
}
`
);

console.log("COMPLETE RESTORATION & UNIVERSAL MCP FIX APPLIED!");