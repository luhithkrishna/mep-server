import { NextRequest, NextResponse } from "next/server";
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
      summaryParts.push(`${q} ${itemRec.unit} ${itemRec.name} @ ₹${computedRate}/${itemRec.unit} = ₹${lineAmt}`);
    }

    const unpaid = Number((grandTotal - (Number(paid_amount) || 0)).toFixed(2));
    return `[${shop.name}] Draft ${name === "create_sale" ? "Sale" : "Purchase"} saved in Inbox for ${party.name}: ${summaryParts.join(", ")} | Total: ₹${grandTotal} | Paid: ₹${paid_amount || 0} | Balance Due: ₹${unpaid}`;
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
    return `[${shop.name}] Draft Payment of ₹${amount} (${method}) saved in Inbox for ${matched.name}.`;
  }

  if (name === "get_stock") {
    const state = await computeLedgerState(shop.id);
    if (state.stock.length === 0) return `[${shop.name}] No confirmed stock items yet.`;
    return state.stock
      .map(
        (s: any) =>
          `• ${s.name}: ${s.stock_qty} ${s.unit} in stock (In: ${s.purchased_qty}, Sold: ${s.sold_qty}, Weighted-Avg Cost: ₹${s.avg_cost}/${s.unit}, Locked Value: ₹${s.stock_value}, Status: ${s.stock_status})`
      )
      .join("\n");
  }

  if (name === "get_party_balance") {
    const { party_name } = args || {};
    const state = await computeLedgerState(shop.id);
    const party = state.parties.find((p: any) =>
      p.name.toLowerCase().includes(String(party_name).toLowerCase())
    );
    if (!party) return `Party "${party_name}" not found in ${shop.name}.`;
    return `[${shop.name}] ${party.name} (${party.type.toUpperCase()}): Total Billed ₹${party.total_billed} | Total Paid ₹${party.total_paid} | Outstanding Balance: ₹${party.balance} | Live Statement: ${origin}/s/${party.statement_token}`;
  }

  if (name === "list_outstanding") {
    const state = await computeLedgerState(shop.id);
    const vendors = state.parties.filter((p: any) => p.type === "vendor");
    const customers = state.parties.filter((p: any) => p.type === "customer");
    const vText =
      vendors.length > 0
        ? vendors.map((p: any) => `• ${p.name}: You Owe ₹${p.balance} (${origin}/s/${p.statement_token})`).join("\n")
        : "None";
    const cText =
      customers.length > 0
        ? customers.map((p: any) => `• ${p.name} [${p.customer_tier}]: Owes You ₹${p.balance} (${origin}/s/${p.statement_token})`).join("\n")
        : "None";
    return `=== [${shop.name}] Vendors You Owe (Total: ₹${state.kpis.total_payables}) ===\n${vText}\n\n=== Customers Who Owe You (Total: ₹${state.kpis.total_receivables}) ===\n${cText}`;
  }

  if (name === "get_business_insights") {
    const state = await computeLedgerState(shop.id);
    const totalSales = state.parties
      .filter((p: any) => p.type === "customer")
      .reduce((acc: number, c: any) => acc + c.total_billed, 0);
    return `=== ${shop.name} Business Insights ===\n• Total Sales Revenue: ₹${totalSales}\n• Total Booked Profit: +₹${state.kpis.total_profit}\n• Cash Collected in Hand/Bank: ₹${state.kpis.total_cash_collected}\n• Pending Customer Udhaar: ₹${state.kpis.total_receivables}\n• Vendor Payables Due: ₹${state.kpis.total_payables}\n• Active Stock Value: ₹${state.kpis.total_stock_value} (At-Risk Deadstock: ₹${state.kpis.deadstock_value})`;
  }

  throw new Error(`Unknown tool: ${name}`);
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
        serverInfo: { name: "mcp-server", version: "2.1.0" },
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
        result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
      };
    }
  }
  return null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const shop = await getShop(searchParams.get("key"));
    return NextResponse.json(
      { name: "MCP Server", status: "live", shop: shop?.name, mcp_key: shop?.mcp_key },
      { headers: CORS_HEADERS }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 404, headers: CORS_HEADERS });
  }
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
