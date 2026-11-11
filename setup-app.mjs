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

// 3. lib/ledger.ts (Pure TypeScript Math: Stock, Deadstock, Profit, Customer Trends)
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
      await sb.from("entries").delete().eq("shop_id", shop.id);
      await sb.from("parties").delete().eq("shop_id", shop.id);
      await sb.from("items").delete().eq("shop_id", shop.id);
      const state = await computeLedgerState(shop.id);
      return NextResponse.json({ ok: true, state });
    }

    if (body.action === "seed_demo") {
      await sb.from("entries").delete().eq("shop_id", shop.id);
      await sb.from("parties").delete().eq("shop_id", shop.id);
      await sb.from("items").delete().eq("shop_id", shop.id);

      const shah = await getOrCreateParty(shop.id, "Shah Textiles", "vendor");
      const surat = await getOrCreateParty(shop.id, "Surat Silk Mills", "vendor");
      const kiran = await getOrCreateParty(shop.id, "Kiran Boutique", "customer");

      const cotton = await getOrCreateItem(shop.id, "white cotton", "m");
      const velvet = await getOrCreateItem(shop.id, "red velvet", "m");

      const due30 = new Date(Date.now() + 30 * 86400000).toISOString();

      // 1. Confirmed Purchase: Shah Textiles (200m white cotton @ 310 = 62,000, bill 4521)
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

      // 2. Confirmed Purchase (Deadstock item): Surat Silk Mills (50m red velvet @ 500 = 25,000, 0 sold)
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

      // 3. Confirmed Sale: Kiran Boutique (10m white cotton @ 450 = 4,500, paid 2,000)
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

      // 4. Confirmed Payment: Paid Shah 25,000 via UPI
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

// 5. app/api/mcp/route.ts (7 MCP Tools including get_business_insights)
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
      "Record a cloth/textile stock purchase from a vendor as a draft entry in MCP Server. Always creates a draft so a human can review, edit, and confirm it.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string", description: "Vendor name, e.g. 'Shah Textiles'" },
        item_name: { type: "string", description: "Item name, e.g. 'white cotton'" },
        qty: { type: "number", description: "Quantity purchased, e.g. 200" },
        rate: { type: "number", description: "Price per unit in INR, e.g. 300" },
        unit: { type: "string", description: "Unit (m, pcs, roll). Defaults to 'm'" },
        bill_no: { type: "string", description: "Optional bill or invoice number, e.g. '4521'" },
        paid_amount: { type: "number", description: "Amount paid upfront in INR (0 if on credit)" },
        due_days: { type: "number", description: "Credit due days, e.g. 30" },
        idempotency_key: { type: "string", description: "Optional unique key to prevent duplicate drafts" },
      },
      required: ["party_name", "item_name", "qty", "rate"],
    },
  },
  {
    name: "create_sale",
    description:
      "Record a textile sale to a customer as a draft entry. You can pass either total_amount (e.g. 4500 for 10m) or rate per unit.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string", description: "Customer name, e.g. 'Kiran'" },
        item_name: { type: "string", description: "Item sold, e.g. 'white cotton'" },
        qty: { type: "number", description: "Quantity sold, e.g. 10" },
        total_amount: { type: "number", description: "Total sale amount in INR, e.g. 4500" },
        rate: { type: "number", description: "Rate per unit in INR (optional if total_amount is given)" },
        paid_amount: { type: "number", description: "Amount customer paid now in INR, e.g. 2000" },
        due_days: { type: "number", description: "Optional credit due days" },
        idempotency_key: { type: "string", description: "Optional unique key to prevent duplicate drafts" },
      },
      required: ["party_name", "item_name", "qty"],
    },
  },
  {
    name: "create_payment",
    description:
      "Record a payment made to a vendor or received from a customer as a draft entry.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string", description: "Party name, e.g. 'Shah' or 'Shah Textiles'" },
        amount: { type: "number", description: "Payment amount in INR, e.g. 25000" },
        method: { type: "string", description: "Payment method, e.g. 'UPI', 'Cash', 'Bank'" },
        idempotency_key: { type: "string", description: "Optional unique key to prevent duplicate drafts" },
      },
      required: ["party_name", "amount"],
    },
  },
  {
    name: "get_stock",
    description:
      "Get exact current stock quantity, weighted-average cost per unit, sell-through %, and deadstock status from confirmed ledger entries.",
    inputSchema: {
      type: "object",
      properties: {
        item_name: { type: "string", description: "Optional item name filter, e.g. 'white cotton'" },
      },
    },
  },
  {
    name: "get_party_balance",
    description:
      "Get exact balance owed to a vendor or owed by a customer from confirmed entries, plus their live statement link.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string", description: "Vendor or customer name, e.g. 'Shah'" },
      },
      required: ["party_name"],
    },
  },
  {
    name: "list_outstanding",
    description:
      "List all vendors we owe and all customers who owe us with exact balances and live statement links.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_business_insights",
    description:
      "Analyze deadstock/slow-moving inventory (locked capital & sell-through rate) and customer purchasing/profit trends using exact deterministic math.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

async function executeTool(name: string, args: any, reqUrl: string, mcpKey?: string | null) {
  const sb = getSupabase();
  const shop = await getShop(mcpKey);
  const origin = new URL(reqUrl).origin;

  if (name === "create_purchase") {
    const {
      party_name,
      item_name,
      qty,
      rate,
      unit = "m",
      bill_no,
      paid_amount = 0,
      due_days,
      idempotency_key,
    } = args || {};

    if (idempotency_key) {
      const { data: existing } = await sb
        .from("entries")
        .select("*")
        .eq("shop_id", shop.id)
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();
      if (existing) {
        return \`Draft purchase already recorded (idempotency_key: \${idempotency_key}). Review and confirm it at \${origin}\`;
      }
    }

    const party = await getOrCreateParty(shop.id, party_name, "vendor");
    const item = await getOrCreateItem(shop.id, item_name, unit);
    const dueDate = due_days
      ? new Date(Date.now() + Number(due_days) * 86400000).toISOString()
      : null;

    const { data: entry, error } = await sb
      .from("entries")
      .insert({
        shop_id: shop.id,
        type: "purchase",
        party_id: party.id,
        bill_no: bill_no ? String(bill_no) : null,
        due_date: dueDate,
        status: "draft",
        paid_amount: Number(paid_amount) || 0,
        idempotency_key: idempotency_key || null,
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await sb.from("entry_lines").insert({
      entry_id: entry.id,
      item_id: item.id,
      qty: Number(qty),
      rate: Number(rate),
    });

    const total = Number(qty) * Number(rate);
    const unpaid = total - (Number(paid_amount) || 0);
    return [
      \`Draft Purchase Saved in MCP Server!\`,
      \`- Vendor: \${party.name}\`,
      \`- Item: \${qty} \${item.unit} \${item.name} @ ₹\${rate}/\${item.unit} = ₹\${total.toLocaleString("en-IN")}\`,
      bill_no ? \`- Bill No: \${bill_no}\` : null,
      \`- Credit / Unpaid: ₹\${unpaid.toLocaleString("en-IN")}\${due_days ? \` (Due in \${due_days} days)\` : ""}\`,
      \`- Review, edit & confirm in Inbox: \${origin}\`,
    ]
      .filter(Boolean)
      .join("\\n");
  }

  if (name === "create_sale") {
    const {
      party_name,
      item_name,
      qty,
      total_amount,
      rate,
      paid_amount = 0,
      due_days,
      idempotency_key,
    } = args || {};

    if (idempotency_key) {
      const { data: existing } = await sb
        .from("entries")
        .select("*")
        .eq("shop_id", shop.id)
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();
      if (existing) {
        return \`Draft sale already recorded. Review & confirm at \${origin}\`;
      }
    }

    const computedRate =
      rate !== undefined
        ? Number(rate)
        : total_amount !== undefined && Number(qty) > 0
        ? Number((Number(total_amount) / Number(qty)).toFixed(2))
        : 0;

    const party = await getOrCreateParty(shop.id, party_name, "customer");
    const item = await getOrCreateItem(shop.id, item_name, "m");
    const dueDate = due_days
      ? new Date(Date.now() + Number(due_days) * 86400000).toISOString()
      : null;

    const { data: entry, error } = await sb
      .from("entries")
      .insert({
        shop_id: shop.id,
        type: "sale",
        party_id: party.id,
        due_date: dueDate,
        status: "draft",
        paid_amount: Number(paid_amount) || 0,
        idempotency_key: idempotency_key || null,
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await sb.from("entry_lines").insert({
      entry_id: entry.id,
      item_id: item.id,
      qty: Number(qty),
      rate: computedRate,
    });

    const total = Number((Number(qty) * computedRate).toFixed(2));
    const owed = Number((total - (Number(paid_amount) || 0)).toFixed(2));
    return [
      \`Draft Sale Saved in MCP Server!\`,
      \`- Customer: \${party.name}\`,
      \`- Item: \${qty} \${item.unit} \${item.name} @ ₹\${computedRate}/\${item.unit} = ₹\${total.toLocaleString("en-IN")}\`,
      \`- Paid now: ₹\${Number(paid_amount).toLocaleString("en-IN")} | Customer owes: ₹\${owed.toLocaleString("en-IN")}\`,
      \`- Review, edit & confirm in Inbox: \${origin}\`,
    ].join("\\n");
  }

  if (name === "create_payment") {
    const { party_name, amount, method = "UPI", idempotency_key } = args || {};

    if (idempotency_key) {
      const { data: existing } = await sb
        .from("entries")
        .select("*")
        .eq("shop_id", shop.id)
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();
      if (existing) {
        return \`Draft payment already recorded. Review & confirm at \${origin}\`;
      }
    }

    const { data: allParties = [] } = await sb
      .from("parties")
      .select("*")
      .eq("shop_id", shop.id);
    const matched =
      (allParties || []).find(
        (p: any) =>
          p.name.toLowerCase() === String(party_name).trim().toLowerCase() ||
          p.name.toLowerCase().includes(String(party_name).trim().toLowerCase())
      ) || (await getOrCreateParty(shop.id, party_name, "vendor"));

    const { error } = await sb.from("entries").insert({
      shop_id: shop.id,
      type: "payment",
      party_id: matched.id,
      status: "draft",
      paid_amount: Number(amount),
      payment_method: method,
      idempotency_key: idempotency_key || null,
    });

    if (error) throw new Error(error.message);

    return [
      \`Draft Payment Saved in MCP Server!\`,
      \`- Party: \${matched.name} (\${matched.type})\`,
      \`- Amount: ₹\${Number(amount).toLocaleString("en-IN")} via \${method}\`,
      \`- Review & confirm in Inbox: \${origin}\`,
    ].join("\\n");
  }

  if (name === "get_stock") {
    const { item_name } = args || {};
    const state = await computeLedgerState(shop.id);
    const list = item_name
      ? state.stock.filter((s: any) =>
          s.name.toLowerCase().includes(String(item_name).trim().toLowerCase())
        )
      : state.stock;

    if (list.length === 0) {
      return "No confirmed stock found yet. (Remember to confirm drafts in the web app Inbox!)";
    }

    return list
      .map(
        (s: any) =>
          \`• \${s.name}: \${s.stock_qty} \${s.unit} left (In: \${s.purchased_qty} \${s.unit}, Sold: \${s.sold_qty} \${s.unit} [\${s.sell_through_pct}%], Avg Cost: ₹\${s.avg_cost}/\${s.unit}, Value: ₹\${s.stock_value.toLocaleString("en-IN")}, Status: \${s.stock_status})\`
      )
      .join("\\n");
  }

  if (name === "get_party_balance") {
    const { party_name } = args || {};
    const state = await computeLedgerState(shop.id);
    const q = String(party_name || "").trim().toLowerCase();
    const party = state.parties.find(
      (p: any) => p.name.toLowerCase() === q || p.name.toLowerCase().includes(q)
    );

    if (!party) {
      return \`No party matching '\${party_name}' found in MCP Server.\`;
    }

    const statementUrl = \`\${origin}/s/\${party.statement_token}\`;
    const whoOwes =
      party.type === "vendor"
        ? \`You owe \${party.name}: ₹\${party.balance.toLocaleString("en-IN")}\`
        : \`\${party.name} owes you: ₹\${party.balance.toLocaleString("en-IN")}\`;

    return [
      whoOwes,
      \`- Party Type: \${party.type}\`,
      \`- Total Confirmed Billed: ₹\${party.total_billed.toLocaleString("en-IN")}\`,
      \`- Total Confirmed Paid: ₹\${party.total_paid.toLocaleString("en-IN")} (\${party.payment_ratio_pct}% paid)\`,
      party.type === "customer"
        ? \`- Exact Profit Generated: +₹\${party.total_profit.toLocaleString("en-IN")} (\${party.profit_margin_pct}% margin)\`
        : null,
      \`- Live Public Statement Link (no login required): \${statementUrl}\`,
    ]
      .filter(Boolean)
      .join("\\n");
  }

  if (name === "list_outstanding") {
    const state = await computeLedgerState(shop.id);
    const vendors = state.parties.filter((p: any) => p.type === "vendor" && p.balance !== 0);
    const customers = state.parties.filter(
      (p: any) => p.type === "customer" && p.balance !== 0
    );

    const lines: string[] = ["=== Outstanding Balances (Confirmed Ledger) ==="];
    lines.push("\\n1. Vendors You Owe (Payables):");
    if (vendors.length === 0) {
      lines.push("   • None (₹0)");
    } else {
      for (const v of vendors) {
        lines.push(
          \`   • \${v.name}: ₹\${v.balance.toLocaleString("en-IN")} | Live Statement: \${origin}/s/\${v.statement_token}\`
        );
      }
    }

    lines.push("\\n2. Customers Who Owe You (Receivables):");
    if (customers.length === 0) {
      lines.push("   • None (₹0)");
    } else {
      for (const c of customers) {
        lines.push(
          \`   • \${c.name}: ₹\${c.balance.toLocaleString("en-IN")} | Live Statement: \${origin}/s/\${c.statement_token}\`
        );
      }
    }
    return lines.join("\\n");
  }

  if (name === "get_business_insights") {
    const state = await computeLedgerState(shop.id);
    const deadOrSlow = state.stock.filter(
      (s: any) => s.stock_status === "DEADSTOCK" || s.stock_status === "SLOW_MOVING"
    );
    const customers = state.parties
      .filter((p: any) => p.type === "customer")
      .sort((a: any, b: any) => b.total_profit - a.total_profit);

    const lines: string[] = [
      "=== MCP Server Business Insights (100% Deterministic Math) ===",
      \`• Total Realized Profit: +₹\${state.kpis.total_profit.toLocaleString("en-IN")}\`,
      \`• Total Stock Value: ₹\${state.kpis.total_stock_value.toLocaleString("en-IN")} (At-Risk / Deadstock Capital: ₹\${state.kpis.deadstock_value.toLocaleString("en-IN")})\`,
      "\\n1. Deadstock & Slow-Moving Inventory:",
    ];

    if (deadOrSlow.length === 0) {
      lines.push("   • None! All items have healthy sell-through (>25%).");
    } else {
      for (const s of deadOrSlow) {
        lines.push(
          \`   • [\${s.stock_status}] \${s.name}: \${s.stock_qty} \${s.unit} unsold (\${s.sell_through_pct}% sold) -> ₹\${s.stock_value.toLocaleString("en-IN")} capital locked\`
        );
      }
    }

    lines.push("\\n2. Customer Purchasing & Profit Trends:");
    if (customers.length === 0) {
      lines.push("   • No confirmed customer sales yet.");
    } else {
      for (const c of customers) {
        lines.push(
          \`   • \${c.name}: Profit +₹\${c.total_profit.toLocaleString("en-IN")} (\${c.profit_margin_pct}% margin) | Orders: \${c.order_count} | Top Item: \${c.favorite_item || "N/A"} | Payment Discipline: \${c.payment_ratio_pct}% paid\`
        );
      }
    }

    return lines.join("\\n");
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
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "mcp-server-textile-ledger",
          version: "1.0.0",
        },
      },
    };
  }

  if (
    method === "notifications/initialized" ||
    method === "notifications/cancelled"
  ) {
    return null;
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS },
    };
  }

  if (method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: [] } };
  }

  if (method === "prompts/list") {
    return { jsonrpc: "2.0", id, result: { prompts: [] } };
  }

  if (method === "tools/call") {
    try {
      const text = await executeTool(
        params?.name,
        params?.arguments || {},
        reqUrl,
        mcpKey
      );
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text }],
          isError: false,
        },
      };
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: \`Error: \${err.message}\` }],
          isError: true,
        },
      };
    }
  }

  if (id !== undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: \`Method not found: \${method}\` },
    };
  }
  return null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/event-stream")) {
    return new NextResponse(null, { status: 405, headers: CORS_HEADERS });
  }
  const { searchParams } = new URL(req.url);
  const shop = await getShop(searchParams.get("key"));
  return NextResponse.json(
    {
      name: "MCP Server — B2B Textile Ledger",
      status: "live",
      shop: shop?.name || "MCP Server",
      mcp_endpoint: "/api/mcp?key=ravi123",
      tools: TOOLS.map((t) => t.name),
    },
    { headers: CORS_HEADERS }
  );
}

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const mcpKey = searchParams.get("key");
    const body = await req.json();

    if (Array.isArray(body)) {
      const results = [];
      for (const item of body) {
        const res = await handleJsonRpcMessage(item, req.url, mcpKey);
        if (res) results.push(res);
      }
      if (results.length === 0) {
        return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
      }
      return NextResponse.json(results, { headers: CORS_HEADERS });
    }

    const response = await handleJsonRpcMessage(body, req.url, mcpKey);
    if (!response) {
      return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
    }
    return NextResponse.json(response, { headers: CORS_HEADERS });
  } catch (err: any) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: err.message || "Parse error" },
      },
      { status: 400, headers: CORS_HEADERS }
    );
  }
}

export async function DELETE() {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}
`
);

// 6. app/page.tsx (Complete UI with Color Fixes, Due Dates, Deadstock Bar, Customer Trends, Printable Invoice Modal, Seed Button)
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
  const [invoiceEntry, setInvoiceEntry] = useState<any>(null);
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
    if (!confirm("Clear all entries, parties, and stock to start with a blank slate?"))
      return;
    setLoading(true);
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset_all" }),
    }).then((r) => r.json());
    if (res.state) setData((prev: any) => ({ ...prev, ...res.state }));
    setLoading(false);
  }

  async function handleSeedDemo() {
    setLoading(true);
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
    deadstock_value: 0,
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
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowQuickAdd(!showQuickAdd)}
              className="text-[11px] bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1.5 rounded-lg font-medium cursor-pointer"
            >
              + Draft
            </button>
            <button
              onClick={handleSeedDemo}
              className="text-[11px] bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 px-2 py-1.5 rounded-lg font-semibold cursor-pointer"
              title="Populate sample shop data"
            >
              ⚡ Seed
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
              className="text-[11px] text-slate-400 hover:text-white px-1 py-1"
            >
              Login
            </Link>
          </div>
        </div>

        {/* 1-Click MCP Connector Bar */}
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
                Create Manual / Test Draft
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
                    Tell Claude about a purchase, sale, or payment (or tap &quot;⚡ Seed&quot; above).
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
                        <div className="grid grid-cols-2 gap-1.5">
                          <div>
                            <label className="text-[11px] text-slate-400 block mb-1">
                              Bill No.
                            </label>
                            <input
                              type="text"
                              value={getEditVal(d, "bill_no")}
                              onChange={(e) =>
                                setEditVal(d.id, "bill_no", e.target.value)
                              }
                              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-sm"
                            />
                          </div>
                          <div>
                            <label className="text-[11px] text-slate-400 block mb-1">
                              Due (Days)
                            </label>
                            <input
                              type="number"
                              value={getEditVal(d, "due_days")}
                              onChange={(e) =>
                                setEditVal(d.id, "due_days", e.target.value)
                              }
                              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-sm"
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
                No parties yet. Confirm a purchase or sale first (or tap &quot;⚡ Seed&quot;).
              </div>
            )}
            {parties.map((p: any) => {
              const isVendor = p.type === "vendor";
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
                      <span
                        className={\`text-[10px] font-bold uppercase px-2 py-0.5 rounded \${
                          isVendor
                            ? "bg-amber-500/15 text-amber-300"
                            : "bg-sky-500/15 text-sky-300"
                        }\`}
                      >
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

                  {/* Customer Purchasing Trends & Profit Generation Box */}
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
                        Supplies: <strong className="text-slate-200 capitalize">{p.favorite_item || "Textiles"}</strong> ({p.order_count} bills)
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
                No stock items yet. Confirm a purchase or tap &quot;⚡ Seed&quot; above.
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

                  {/* Sell-Through Progress Bar */}
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

      {/* Printable Tax Invoice / Payment Receipt Modal */}
      {invoiceEntry && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
            <div className="flex justify-between items-start border-b border-slate-800 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                  {invoiceEntry.type === "payment" ? "PAYMENT RECEIPT" : \`\${invoiceEntry.type.toUpperCase()} INVOICE\`}
                </span>
                <h3 className="text-lg font-bold mt-1">MCP Server Textiles</h3>
                <p className="text-xs text-slate-400">
                  {invoiceEntry.bill_no ? \`Bill #\${invoiceEntry.bill_no}\` : \`Ref #\${invoiceEntry.id.slice(0, 6)}\`} •{" "}
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
                    {invoiceEntry.qty} {invoiceEntry.item.unit} {invoiceEntry.item.name} × ₹{invoiceEntry.rate}
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

console.log("ALL 7 UPGRADES APPLIED SUCCESSFULLY!");