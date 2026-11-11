import { NextRequest, NextResponse } from "next/server";
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
