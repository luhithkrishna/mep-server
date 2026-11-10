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
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-Id",
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
      "Get exact current stock quantity and weighted-average cost per unit from confirmed ledger entries.",
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
        return `Draft purchase already recorded (idempotency_key: ${idempotency_key}). Review and confirm it at ${origin}`;
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
      `Draft Purchase Saved in MCP Server!`,
      `- Vendor: ${party.name}`,
      `- Item: ${qty} ${item.unit} ${item.name} @ ₹${rate}/${item.unit} = ₹${total.toLocaleString("en-IN")}`,
      bill_no ? `- Bill No: ${bill_no}` : null,
      `- Credit / Unpaid: ₹${unpaid.toLocaleString("en-IN")}${due_days ? ` (Due in ${due_days} days)` : ""}`,
      `- Review, edit & confirm in Inbox: ${origin}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (name === "create_sale") {
    const {
      party_name,
      item_name,
      qty,
      total_amount,
      rate,
      paid_amount = 0,
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
        return `Draft sale already recorded. Review & confirm at ${origin}`;
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

    const { data: entry, error } = await sb
      .from("entries")
      .insert({
        shop_id: shop.id,
        type: "sale",
        party_id: party.id,
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
      `Draft Sale Saved in MCP Server!`,
      `- Customer: ${party.name}`,
      `- Item: ${qty} ${item.unit} ${item.name} @ ₹${computedRate}/${item.unit} = ₹${total.toLocaleString("en-IN")}`,
      `- Paid now: ₹${Number(paid_amount).toLocaleString("en-IN")} | Customer owes: ₹${owed.toLocaleString("en-IN")}`,
      `- Review, edit & confirm in Inbox: ${origin}`,
    ].join("\n");
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
        return `Draft payment already recorded. Review & confirm at ${origin}`;
      }
    }

    const { data: allParties = [] } = await sb.from("parties").select("*").eq("shop_id", shop.id);
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
      `Draft Payment Saved in MCP Server!`,
      `- Party: ${matched.name} (${matched.type})`,
      `- Amount: ₹${Number(amount).toLocaleString("en-IN")} via ${method}`,
      `- Review & confirm in Inbox: ${origin}`,
    ].join("\n");
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
          `• ${s.name}: ${s.stock_qty} ${s.unit} in stock (Purchased: ${s.purchased_qty} ${s.unit}, Sold: ${s.sold_qty} ${s.unit}, Weighted-Avg Cost: ₹${s.avg_cost}/${s.unit})`
      )
      .join("\n");
  }

  if (name === "get_party_balance") {
    const { party_name } = args || {};
    const state = await computeLedgerState(shop.id);
    const q = String(party_name || "").trim().toLowerCase();
    const party = state.parties.find(
      (p: any) => p.name.toLowerCase() === q || p.name.toLowerCase().includes(q)
    );

    if (!party) {
      return `No party matching '${party_name}' found in MCP Server.`;
    }

    const statementUrl = `${origin}/s/${party.statement_token}`;
    const whoOwes =
      party.type === "vendor"
        ? `You owe ${party.name}: ₹${party.balance.toLocaleString("en-IN")}`
        : `${party.name} owes you: ₹${party.balance.toLocaleString("en-IN")}`;

    return [
      whoOwes,
      `- Party Type: ${party.type}`,
      `- Total Confirmed Billed: ₹${party.total_billed.toLocaleString("en-IN")}`,
      `- Total Confirmed Paid: ₹${party.total_paid.toLocaleString("en-IN")}`,
      `- Live Public Statement Link (no login required): ${statementUrl}`,
    ].join("\n");
  }

  if (name === "list_outstanding") {
    const state = await computeLedgerState(shop.id);
    const vendors = state.parties.filter((p: any) => p.type === "vendor" && p.balance !== 0);
    const customers = state.parties.filter((p: any) => p.type === "customer" && p.balance !== 0);

    const lines: string[] = ["=== Outstanding Balances (Confirmed Ledger) ==="];
    lines.push("\n1. Vendors You Owe (Payables):");
    if (vendors.length === 0) {
      lines.push("   • None (₹0)");
    } else {
      for (const v of vendors) {
        lines.push(
          `   • ${v.name}: ₹${v.balance.toLocaleString("en-IN")} | Live Statement: ${origin}/s/${v.statement_token}`
        );
      }
    }

    lines.push("\n2. Customers Who Owe You (Receivables):");
    if (customers.length === 0) {
      lines.push("   • None (₹0)");
    } else {
      for (const c of customers) {
        lines.push(
          `   • ${c.name}: ₹${c.balance.toLocaleString("en-IN")} | Live Statement: ${origin}/s/${c.statement_token}`
        );
      }
    }
    return lines.join("\n");
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
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "mcp-server-textile-ledger",
          version: "1.0.0",
        },
      },
    };
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
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
      const text = await executeTool(params?.name, params?.arguments || {}, reqUrl, mcpKey);
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
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        },
      };
    }
  }

  if (id !== undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
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
