import { createClient } from "@supabase/supabase-js";

const globalAny = globalThis as any;
if (!globalAny.__partyAcks) {
  globalAny.__partyAcks = new Map<string, { status: "verified" | "disputed"; time: string }>();
}
export const partyAcks: Map<string, { status: "verified" | "disputed"; time: string }> = globalAny.__partyAcks;

export function getSupabase() {
  const rawUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "");
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
  const { data: created } = await sb.from("shops").insert({ name: "MCP Server", mcp_key: "ravi123" }).select("*").single();
  return created;
}

export async function getOrCreateParty(shopId: string, name: string, defaultType: "vendor" | "customer") {
  const sb = getSupabase();
  const cleanName = name.trim();
  const { data: existing } = await sb.from("parties").select("*").eq("shop_id", shopId).ilike("name", cleanName).maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await sb.from("parties").insert({ shop_id: shopId, name: cleanName, type: defaultType }).select("*").single();
  if (error) throw new Error(error.message);
  return created;
}

export async function getOrCreateItem(shopId: string, name: string, unit = "m") {
  const sb = getSupabase();
  const cleanName = name.trim().toLowerCase();
  const { data: existing } = await sb.from("items").select("*").eq("shop_id", shopId).ilike("name", cleanName).maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await sb.from("items").insert({ shop_id: shopId, name: cleanName, unit: unit || "m" }).select("*").single();
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

  const stockMap = new Map<string, any>();
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
          const qty = Number(l.qty) || 0;
          const rate = Number(l.rate) || 0;
          st.sold_qty += qty;
          st.sales_revenue += qty * rate;
        }
      }
    }
  }

  let totalShopStockValue = 0;
  for (const st of stockMap.values()) {
    st.avg_cost = st.purchased_qty > 0 ? Number((st.purchase_cost / st.purchased_qty).toFixed(2)) : 0;
    st.stock_qty = Number((st.purchased_qty - st.sold_qty).toFixed(2));
    st.stock_value = Number((Math.max(0, st.stock_qty) * st.avg_cost).toFixed(2));
    totalShopStockValue += st.stock_value;
    st.sell_through_pct = st.purchased_qty > 0 ? Number(Math.min(100, (st.sold_qty / st.purchased_qty) * 100).toFixed(1)) : 0;
    st.stock_status = st.stock_qty <= 0 && st.purchased_qty > 0 ? "OUT_OF_STOCK" : st.sold_qty === 0 ? "DEADSTOCK" : st.sell_through_pct < 25 ? "SLOW_MOVING" : "FAST_MOVING";
  }

  const enrichedEntries = (entries || []).map((entry: any) => {
    const eLines = linesByEntry.get(entry.id) || [];
    const lineTotal = eLines.reduce((acc: number, l: any) => acc + Number(l.qty) * Number(l.rate), 0);
    const paidAmount = Number(entry.paid_amount) || 0;
    const totalAmount = entry.type === "payment" ? paidAmount : Number(lineTotal.toFixed(2));

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

    return {
      ...entry,
      party: partyMap.get(entry.party_id) || null,
      lines: eLines,
      total_amount: totalAmount,
      paid_amount: paidAmount,
      cost,
      profit,
      unpaid_amount: entry.type === "payment" ? 0 : Number((totalAmount - paidAmount).toFixed(2)),
    };
  });

  const partyBalances = (parties || []).map((party: any) => {
    const pEntries = enrichedEntries.filter((e: any) => e.party_id === party.id && e.status === "confirmed");
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
        if (e.type === "sale") totalProfit += e.profit;
        for (const l of e.lines || []) {
          if (l.item?.name) itemCounts[l.item.name] = (itemCounts[l.item.name] || 0) + Number(l.qty || 0);
        }
      } else if (e.type === "payment") {
        totalPaid += e.paid_amount;
      }
    }

    const topItem = Object.entries(itemCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const balance = Number((totalBilled - totalPaid).toFixed(2));
    const paymentRatioPct = totalBilled > 0 ? Math.min(100, Math.round((totalPaid / totalBilled) * 100)) : 100;
    const profitMarginPct = totalBilled > 0 ? Number(((totalProfit / totalBilled) * 100).toFixed(1)) : 0;
    const aov = orderCount > 0 ? Math.round(totalBilled / orderCount) : 0;

    let customerTier = "New";
    if (party.type === "customer" && orderCount > 0) {
      customerTier = paymentRatioPct >= 75 ? "VIP Cash Buyer" : paymentRatioPct >= 40 ? "High-Margin Credit" : "Credit Risk";
    }

    return {
      ...party,
      total_billed: Number(totalBilled.toFixed(2)),
      total_paid: Number(totalPaid.toFixed(2)),
      balance,
      order_count: orderCount,
      aov,
      total_profit: Number(totalProfit.toFixed(2)),
      profit_margin_pct: profitMarginPct,
      payment_ratio_pct: paymentRatioPct,
      favorite_item: topItem,
      customer_tier: customerTier,
      ack: partyAcks.get(party.statement_token) || null,
      entries: pEntries,
    };
  });

  const stockList = Array.from(stockMap.values());
  const confirmedList = enrichedEntries.filter((e: any) => e.status === "confirmed").reverse();

  const totalPayables = partyBalances.filter((p: any) => p.type === "vendor" && p.balance > 0).reduce((acc: number, p: any) => acc + p.balance, 0);
  const totalReceivables = partyBalances.filter((p: any) => p.type === "customer" && p.balance > 0).reduce((acc: number, p: any) => acc + p.balance, 0);
  const totalBookedProfit = confirmedList.filter((e: any) => e.type === "sale").reduce((acc: number, e: any) => acc + e.profit, 0);
  const totalCashCollected = partyBalances.filter((p: any) => p.type === "customer").reduce((acc: number, p: any) => acc + p.total_paid, 0);
  const deadstockValue = stockList.filter((s: any) => s.stock_status === "DEADSTOCK" || s.stock_status === "SLOW_MOVING").reduce((acc: number, s: any) => acc + s.stock_value, 0);

  return {
    kpis: {
      total_payables: totalPayables,
      total_receivables: totalReceivables,
      total_stock_value: totalShopStockValue,
      total_profit: totalBookedProfit,
      total_cash_collected: totalCashCollected,
      deadstock_value: deadstockValue,
    },
    stock: stockList,
    parties: partyBalances,
    entries: enrichedEntries.slice().reverse(),
    drafts: enrichedEntries.filter((e: any) => e.status === "draft").reverse(),
    confirmed: confirmedList,
  };
}
