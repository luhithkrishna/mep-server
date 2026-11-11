import { NextRequest, NextResponse } from "next/server";
import { getSupabase, getShop, getOrCreateParty, getOrCreateItem, computeLedgerState } from "@/lib/ledger";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-Id",
};

const TOOLS = [
  {
    name: "create_purchase",
    description: "Record a vendor purchase bill with item name, quantity, rate, and upfront payment.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string", description: "Vendor name e.g. 'Sai Ram Textile'" },
        item_name: { type: "string", description: "Item name e.g. 'sarees'" },
        qty: { type: "number", description: "Quantity" },
        unit: { type: "string", description: "'pcs' or 'm'" },
        rate: { type: "number", description: "Rate per unit in INR" },
        paid_amount: { type: "number", description: "Amount paid upfront in INR" },
        bill_no: { type: "string" },
        due_days: { type: "number" }
      },
      required: ["party_name", "item_name", "qty", "rate"]
    }
  },
  {
    name: "create_sale",
    description: "Record a customer sale.",
    inputSchema: {
      type: "object",
      properties: {
        party_name: { type: "string" },
        item_name: { type: "string" },
        qty: { type: "number" },
        unit: { type: "string" },
        rate: { type: "number" },
        paid_amount: { type: "number" },
        due_days: { type: "number" }
      },
      required: ["party_name", "item_name", "qty", "rate"]
    }
  },
  {
    name: "create_payment",
    description: "Record a payment made to a vendor.",
    inputSchema: {
      type: "object",
      properties: { party_name: { type: "string" }, amount: { type: "number" }, method: { type: "string" } },
      required: ["party_name", "amount"]
    }
  },
  {
    name: "get_stock",
    description: "Get stock quantities.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_party_balance",
    description: "Get party balance.",
    inputSchema: { type: "object", properties: { party_name: { type: "string" } }, required: ["party_name"] }
  },
  {
    name: "list_outstanding",
    description: "List outstanding balances.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_business_insights",
    description: "Get business insights.",
    inputSchema: { type: "object", properties: {} }
  }
];

async function executeTool(name: string, args: any, reqUrl: string, mcpKey?: string | null) {
  const sb = getSupabase();
  const shop = await getShop(mcpKey);

  if (name === "create_purchase" || name === "create_sale") {
    const { party_name, item_name, qty, rate, unit = "pcs", paid_amount = 0, due_days, bill_no } = args || {};
    const defaultType = name === "create_sale" ? "customer" : "vendor";
    const party = await getOrCreateParty(shop.id, party_name, defaultType);
    const itemRec = await getOrCreateItem(shop.id, item_name || "cloth", unit);

    const { data: entry, error } = await sb.from("entries").insert({
      shop_id: shop.id,
      type: name === "create_sale" ? "sale" : "purchase",
      party_id: party.id,
      bill_no: bill_no ? String(bill_no) : null,
      date: new Date().toISOString(),
      due_date: due_days ? new Date(Date.now() + due_days * 86400000).toISOString() : null,
      status: "draft",
      paid_amount: Number(paid_amount) || 0,
    }).select("*").single();

    if (error) throw new Error(error.message);

    await sb.from("entry_lines").insert({
      entry_id: entry.id,
      item_id: itemRec.id,
      qty: Number(qty) || 1,
      rate: Number(rate) || 0,
    });

    return `Draft saved in Inbox for $.party.name}.`;
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
    return state.stock.map((s: any) => `• ${s.name}: ${s.stock_qty} ${s.unit} left (Avg Cost: ₹${s.avg_cost}/${s.unit})`).join("\n");
  }

  if (name === "get_party_balance") {
    const { party_name } = args || {};
    const state = await computeLedgerState(shop.id);
    const party = state.parties.find((p: any) => p.name.toLowerCase().includes(party_name.toLowerCase()));
    if (!party) return "Party not found.";
    return `${party.name}: Balance ₹${party.balance} | Statement: ${new URL(reqUrl).origin}/s/${party.statement_token}`;
  }

  if (name === "list_outstanding") {
    const state = await computeLedgerState(shop.id);
    return state.parties.filter((p: any) => p.balance !== 0).map((p: any) => `• ${p.name}: ₹${p.balance}`).join("\n");
  }

  if (name === "get_business_insights") {
    const state = await computeLedgerState(shop.id);
    return `Total Profit: +₹${state.kpis.total_profit} | Cash Collected: ₹${state.kpis.total_cash_collected}`;
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
