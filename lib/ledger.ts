import { createClient } from "@supabase/supabase-js";

const globalAny = globalThis as any;
if (!globalAny.__partyAcks) {
  globalAny.__partyAcks = new Map<string, { status: "verified" | "disputed"; time: string }>();
}
export const partyAcks: Map<string, { status: "verified" | "disputed"; time: string }> =
  globalAny.__partyAcks;

export function getSupabase() {
  const rawUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "")
    .trim()
    .replace(/\/rest\/v1\/?$/, "");
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
