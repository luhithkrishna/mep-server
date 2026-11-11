import { NextRequest, NextResponse } from "next/server";
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
