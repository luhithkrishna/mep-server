"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [shopName, setShopName] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [existingKey, setExistingKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function suggestKey(name: string) {
    setShopName(name);
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 12);
    if (slug) {
      setCustomKey(`${slug}-101`);
    } else {
      setCustomKey("");
    }
  }

  async function handleCreateShop(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_shop",
          shop_name: shopName,
          mcp_key: customKey,
        }),
      }).then((r) => r.json());

      if (res.error) {
        setError(res.error);
        setLoading(false);
        return;
      }

      if (typeof window !== "undefined") {
        localStorage.setItem("mcp_admin_auth", "true");
        localStorage.setItem("mcp_shop_key", res.shop.mcp_key);
        localStorage.setItem("mcp_shop_name", res.shop.name);
      }
      router.push("/");
    } catch (err: any) {
      setError(err.message || "Failed to create shop");
      setLoading(false);
    }
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const clean = existingKey.trim().toLowerCase();
    const resolvedKey =
      clean === "admin@mcpserver.com" || clean === "admin123" || clean === ""
        ? "ravi123"
        : clean;

    try {
      const res = await fetch("/api/ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "login_shop",
          mcp_key: resolvedKey,
        }),
      }).then((r) => r.json());

      if (res.error) {
        setError(res.error);
        setLoading(false);
        return;
      }

      if (typeof window !== "undefined") {
        localStorage.setItem("mcp_admin_auth", "true");
        localStorage.setItem("mcp_shop_key", res.shop.mcp_key);
        localStorage.setItem("mcp_shop_name", res.shop.name);
      }
      router.push("/");
    } catch (err: any) {
      setError(err.message || "Login failed");
      setLoading(false);
    }
  }

  async function loginDemoShop() {
    setExistingKey("ravi123");
    if (typeof window !== "undefined") {
      localStorage.setItem("mcp_admin_auth", "true");
      localStorage.setItem("mcp_shop_key", "ravi123");
      localStorage.setItem("mcp_shop_name", "MCP Server");
    }
    router.push("/");
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5 shadow-2xl">
        <div className="space-y-1 text-center">
          <span className="text-[10px] font-bold uppercase px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            100% Free Multi-Shop MCP Ledger
          </span>
          <h1 className="text-xl font-extrabold pt-1">Connect Your Shop to Claude</h1>
          <p className="text-xs text-slate-400">
            Create an isolated textile ledger & get your personal Claude MCP link in 5 seconds.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-1.5 bg-slate-950 p-1.5 rounded-xl border border-slate-800">
          <button
            type="button"
            onClick={() => {
              setMode("signup");
              setError("");
            }}
            className={`py-2 rounded-lg text-xs font-bold cursor-pointer ${
              mode === "signup"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }`}
          >
            ✨ Create Free Shop
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("signin");
              setError("");
            }}
            className={`py-2 rounded-lg text-xs font-bold cursor-pointer ${
              mode === "signin"
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-400 hover:text-white"
            }`}
          >
            🔑 Open Existing Shop
          </button>
        </div>

        {error && (
          <div className="bg-rose-950/70 border border-rose-700 text-rose-200 rounded-xl p-3 text-xs font-medium">
            {error}
          </div>
        )}

        {mode === "signup" ? (
          <form onSubmit={handleCreateShop} className="space-y-3.5">
            <div>
              <label className="text-xs text-slate-300 font-semibold block mb-1">
                Your Shop / Business Name
              </label>
              <input
                required
                placeholder="e.g. Lakshmi Silk House"
                value={shopName}
                onChange={(e) => suggestKey(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white font-semibold"
              />
            </div>

            <div>
              <label className="text-xs text-slate-300 font-semibold block mb-1">
                Choose Your Secret Shop Key (Used for Login & Claude MCP)
              </label>
              <input
                required
                placeholder="e.g. lakshmi-101"
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
                className="w-full bg-slate-950 border border-emerald-500/50 rounded-xl px-3.5 py-2.5 text-sm text-emerald-300 font-mono"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Your Claude MCP URL will end with{" "}
                <code className="text-emerald-400">?key={customKey || "your-key"}</code>
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold py-3 rounded-xl text-sm transition cursor-pointer"
            >
              {loading ? "Creating Your Shop..." : "🚀 Create Free Shop & Get MCP Link"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSignIn} className="space-y-3.5">
            <div>
              <label className="text-xs text-slate-300 font-semibold block mb-1">
                Enter Your Secret Shop Key
              </label>
              <input
                required
                placeholder="e.g. lakshmi-101 or ravi123"
                value={existingKey}
                onChange={(e) => setExistingKey(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold py-3 rounded-xl text-sm transition cursor-pointer"
            >
              {loading ? "Opening Shop..." : "🔓 Sign In to My Shop"}
            </button>
          </form>
        )}

        <div className="border-t border-slate-800 pt-3 space-y-2">
          <button
            type="button"
            onClick={loginDemoShop}
            className="w-full bg-slate-800 hover:bg-slate-700 border border-slate-700 text-amber-300 font-bold py-2.5 rounded-xl text-xs cursor-pointer"
          >
            ⚡ One-Click Demo Shop (Key: ravi123)
          </button>
          <Link
            href="/"
            className="block text-center text-xs text-slate-400 hover:text-white pt-1"
          >
            ← Back to Ledger
          </Link>
        </div>
      </div>
    </div>
  );
}
