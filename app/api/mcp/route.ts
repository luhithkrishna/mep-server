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
    description: "Record a cloth stock purchase from a vendor as a draft entry.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string" },
        item_name: { type: "string" },
        qty: { type: "number" },
        rate: { type: "number" },
        unit: { type: "string" },
        bill_no: { type: "string" },
        paid_amount: { type: "number" },
        due_days: { type: "number" },
        days_ago: { type: "number" },
      },
      required: ["party_name", "item_name", "qty", "rate"],
    },
  },
  {
    name: "create_sale",
    description: "Record a textile sale to a customer as a draft entry.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string" },
        item_name: { type: "string" },
        qty: { type: "number" },
        total_amount: { type: "number" },
        rate: { type: "number" },
        paid_amount: { type: "number" },
        due_days: { type: "number" },
        days_ago: { type: "number" },
      },
      required: ["party_name", "item_name", "qty"],
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
      },
      required: ["party_name", "amount"],
    },
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
  const origin = new URL(reqUrl).origin;

  if (name === "create_purchase") {
    const { party_name, item_name, qty, rate, unit = "m", bill_no, paid_amount = 0, due_days, days_ago } = args || {};
    const party = await getOrCreateParty(shop.id, party_name, "vendor");
    const item = await getOrCreateItem(shop.id, item_name, unit);
    const entryDate = days_ago ? new Date(Date.now() - days_ago * 86400000).toISOString() : new Date().toISOString();
    const dueDate = due_days ? new Date(new Date(entryDate).getTime() + due_days * 86400000).toISOString() : null;

    const { data: entry, error } = await sb.from("entries").insert({
      shop_id: shop.id, type: "purchase", party_id: party.id, bill_no: bill_no ? String(bill_no) : null,
      date: entryDate, due_date: dueDate, status: "draft", paid_amount: Number(paid_amount) || 0,
    }).select("*").single();
    if (error) throw new Error(error.message);

    await sb.from("entry_lines").insert({ entry_id: entry.id, item_id: item.id, qty: Number(qty), rate: Number(rate) });
    return `Draft Purchase saved in Inbox for ${party.name}.`;
  }

  if (name === "create_sale") {
    const { party_name, item_name, qty, total_amount, rate, paid_amount = 0, due_days, days_ago } = args || {};
    const computedRate = rate !== undefined ? Number(rate) : total_amount !== undefined && qty > 0 ? Number((total_amount / qty).toFixed(2)) : 0;
    const party = await getOrCreateParty(shop.id, party_name, "customer");
    const item = await getOrCreateItem(shop.id, item_name, "m");
    const entryDate = days_ago ? new Date(Date.now() - days_ago * 86400000).toISOString() : new Date().toISOString();
    const dueDate = due_days ? new Date(new Date(entryDate).getTime() + due_days * 86400000).toISOString() : null;

    const { data: entry, error } = await sb.from("entries").insert({
      shop_id: shop.id, type: "sale", party_id: party.id, date: entryDate, due_date: dueDate,
      status: "draft", paid_amount: Number(paid_amount) || 0,
    }).select("*").single();
    if (error) throw new Error(error.message);

    await sb.from("entry_lines").insert({ entry_id: entry.id, item_id: item.id, qty: Number(qty), rate: computedRate });
    return `Draft Sale saved in Inbox for ${party.name}.`;
  }

  if (name === "create_payment") {
    const { party_name, amount, method = "UPI" } = args || {};
    const { data: allParties = [] } = await sb.from("parties").select("*").eq("shop_id", shop.id);
    const matched = allParties.find((p: any) => p.name.toLowerCase().includes(String(party_name).toLowerCase())) || await getOrCreateParty(shop.id, party_name, "vendor");

    await sb.from("entries").insert({
      shop_id: shop.id, type: "payment", party_id: matched.id, status: "draft", paid_amount: Number(amount), payment_method: method,
    });
    return `Draft Payment saved in Inbox for ${matched.name}.`;
  }

  if (name === "get_stock") {
    const state = await computeLedgerState(shop.id);
    return state.stock.map((s: any) => `• ${s.name}: ${s.stock_qty} ${s.unit} left (Avg Cost: ₹${s.avg_cost}/${s.unit}, Status: ${s.stock_status})`).join("\n");
  }

  if (name === "get_party_balance") {
    const { party_name } = args || {};
    const state = await computeLedgerState(shop.id);
    const party = state.parties.find((p: any) => p.name.toLowerCase().includes(party_name.toLowerCase()));
    if (!party) return `Party not found.`;
    return `${party.name} (${party.type}): Balance ₹${party.balance} | Statement: ${origin}/s/${party.statement_token}`;
  }

  if (name === "list_outstanding") {
    const state = await computeLedgerState(shop.id);
    return state.parties.filter((p: any) => p.balance !== 0).map((p: any) => `• ${p.name} (${p.type}): ₹${p.balance}`).join("\n");
  }

  if (name === "get_business_insights") {
    const state = await computeLedgerState(shop.id);
    return `=== Business Insights ===\n• Total Sales Revenue: ₹${state.parties.filter((p: any) => p.type === "customer").reduce((a, c) => a + c.total_billed, 0)}\n• Total Booked Profit: +₹${state.kpis.total_profit}\n• Total Cash Collected: ₹${state.kpis.total_cash_collected}\n• Pending Customer Udhaar: ₹${state.kpis.total_receivables}`;
  }

  throw new Error(`Unknown tool: ${name}`);
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
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } };
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
