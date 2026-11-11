"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

export default function PublicStatementPage() {
  const params = useParams();
  const token = params?.token as string;
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [ackStatus, setAckStatus] = useState<"none" | "verified" | "disputed">("none");
  const [ackTime, setAckTime] = useState<string>("");

  useEffect(() => {
    if (!token) return;
    const saved =
      typeof window !== "undefined"
        ? localStorage.getItem(`mcp_ack_${token}`)
        : null;
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setAckStatus(parsed.status);
        setAckTime(parsed.time);
      } catch {}
    }

    fetch(`/api/ledger?statement_token=${token}`)
      .then((r) => r.json())
      .then((res) => {
        setData(res);
        if (res?.party?.ack) {
          setAckStatus(res.party.ack.status);
          setAckTime(res.party.ack.time);
        }
        setLoading(false);
      });
  }, [token]);

  async function handleAck(status: "verified" | "disputed") {
    const now = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    setAckStatus(status);
    setAckTime(now);
    if (typeof window !== "undefined") {
      localStorage.setItem(
        `mcp_ack_${token}`,
        JSON.stringify({ status, time: now })
      );
    }
    await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "ack_statement",
        statement_token: token,
        status,
      }),
    });
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <p className="text-slate-400 text-sm">Loading verified statement...</p>
      </div>
    );
  }

  if (!data || data.error || !data.party) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-sm w-full text-center">
          <h1 className="text-lg font-bold text-rose-400">Statement Link Expired or Invalid</h1>
          <p className="text-xs text-slate-400 mt-2">
            This capability token does not match an active party record.
          </p>
        </div>
      </div>
    );
  }

  const { party, shop } = data;
  const isVendor = party.type === "vendor";

  return (
    <div className="min-h-screen bg-slate-950 text-white py-6 px-4 flex justify-center">
      <div className="w-full max-w-md space-y-4">
        {/* Security & Data Isolation Banner */}
        <div className="bg-slate-900/90 border border-emerald-500/30 rounded-xl px-3.5 py-2 flex items-center justify-between text-[11px]">
          <span className="text-emerald-300 font-semibold">
            🔒 Capability-Scoped Read-Only Ledger
          </span>
          <span className="text-slate-400">No Login Required</span>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
          <div className="flex items-center justify-between">
            <span
              className={`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full font-bold ${
                isVendor
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-sky-500/15 text-sky-300"
              }`}
            >
              ● {party.type} Statement
            </span>
            <button
              onClick={() => window.print()}
              className="text-xs bg-slate-800 hover:bg-slate-700 px-3 py-1 rounded-lg text-slate-300 cursor-pointer"
            >
              🖨️ Print / Save PDF
            </button>
          </div>

          <h1 className="text-xl font-bold mt-3">{party.name}</h1>
          <p className="text-xs text-slate-400">
            Verified account with{" "}
            <span className="text-slate-200 font-semibold">
              {shop?.name || "MCP Server"}
            </span>{" "}
            • Isolated strictly to {party.name}&apos;s bills
          </p>

          <div className="mt-4 p-4 rounded-xl bg-slate-950 border border-slate-800 flex justify-between items-center">
            <div>
              <p className="text-xs text-slate-400">
                {isVendor
                  ? "Net Balance Payable to You"
                  : "Net Balance Due from You"}
              </p>
              <p
                className={`text-2xl font-extrabold mt-0.5 ${
                  party.balance === 0
                    ? "text-emerald-400"
                    : isVendor
                    ? "text-amber-400"
                    : "text-sky-400"
                }`}
              >
                ₹{Number(party.balance).toLocaleString("en-IN")}
              </p>
            </div>
            <div className="text-right text-xs text-slate-400 space-y-1">
              <p>
                Total Billed:{" "}
                <span className="text-white font-semibold">
                  ₹{Number(party.total_billed).toLocaleString("en-IN")}
                </span>
              </p>
              <p>
                Total Paid:{" "}
                <span className="text-emerald-400 font-semibold">
                  ₹{Number(party.total_paid).toLocaleString("en-IN")}
                </span>
              </p>
            </div>
          </div>

          {/* Two-Way Counterparty Verification */}
          <div className="mt-4 pt-3 border-t border-slate-800">
            {ackStatus === "none" ? (
              <div className="space-y-1.5">
                <p className="text-[11px] text-slate-400">
                  Do you agree with this running balance?
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAck("verified")}
                    className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-2.5 rounded-xl text-xs cursor-pointer"
                  >
                    ✓ Verify Balance (₹{Number(party.balance).toLocaleString("en-IN")})
                  </button>
                  <button
                    onClick={() => handleAck("disputed")}
                    className="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-300 hover:text-rose-300 text-xs font-semibold cursor-pointer"
                  >
                    Flag Dispute
                  </button>
                </div>
              </div>
            ) : ackStatus === "verified" ? (
              <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-between text-xs text-emerald-300 font-semibold">
                <span>
                  ✓ Verified by {party.name} {ackTime ? `at ${ackTime}` : ""}
                </span>
                <button
                  onClick={() => setAckStatus("none")}
                  className="text-[10px] underline text-slate-400 hover:text-white cursor-pointer"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/40 flex items-center justify-between text-xs text-rose-300 font-semibold">
                <span>⚠ Dispute flagged for Shop Admin review</span>
                <button
                  onClick={() => setAckStatus("none")}
                  className="text-[10px] underline text-slate-400 hover:text-white cursor-pointer"
                >
                  Change
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-300 px-1">
            Confirmed Bills & Payments ({party.entries?.length || 0})
          </h2>

          {(!party.entries || party.entries.length === 0) && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-400">
              No confirmed transactions posted yet.
            </div>
          )}

          {(party.entries || []).map((e: any) => (
            <div
              key={e.id}
              className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2"
            >
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs font-bold uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-200">
                    {e.type}
                  </span>
                  {e.bill_no && (
                    <span className="ml-2 text-xs text-slate-400">
                      Bill #{e.bill_no}
                    </span>
                  )}
                  <p className="text-xs text-slate-400 mt-1">
                    {new Date(e.date).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                    {e.due_date &&
                      ` • Due: ${new Date(e.due_date).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                      })}`}
                  </p>
                </div>
                <div className="text-right">
                  {e.type === "payment" ? (
                    <p className="text-base font-bold text-emerald-400">
                      -₹{Number(e.paid_amount).toLocaleString("en-IN")}
                    </p>
                  ) : (
                    <p className="text-base font-bold text-white">
                      ₹{Number(e.total_amount).toLocaleString("en-IN")}
                    </p>
                  )}
                  {e.type !== "payment" && e.paid_amount > 0 && (
                    <p className="text-xs text-emerald-400">
                      Paid: ₹{Number(e.paid_amount).toLocaleString("en-IN")}
                    </p>
                  )}
                  {e.payment_method && (
                    <p className="text-xs text-slate-400">via {e.payment_method}</p>
                  )}
                </div>
              </div>

              {e.item && (
                <div className="text-xs text-slate-300 bg-slate-950/70 px-3 py-2 rounded-lg border border-slate-800/80">
                  {e.qty} {e.item.unit} {e.item.name} × ₹{e.rate}/{e.item.unit}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
