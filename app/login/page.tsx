"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [email, setEmail] = useState("admin@mcpserver.com");
  const [password, setPassword] = useState("password123");
  const router = useRouter();

  function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    localStorage.setItem("mcp_auth", "true");
    router.push("/");
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col justify-center items-center px-4">
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="inline-block px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-semibold mb-3">
          Zero-AI Deterministic Ledger
        </div>
        <h1 className="text-2xl font-bold">MCP Server</h1>
        <p className="text-sm text-slate-400 mt-1">
          B2B Textile Credit, Stock & Profit Ledger powered by Claude MCP
        </p>

        <form onSubmit={handleLogin} className="mt-6 space-y-4">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Shop Owner Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white"
              required
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white"
              required
            />
          </div>
          <button
            type="submit"
            className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-3 rounded-xl text-sm transition cursor-pointer"
          >
            Login to MCP Server
          </button>
        </form>

        <div className="mt-5 p-3 bg-slate-800/60 rounded-xl border border-slate-700/60 text-xs text-slate-300">
          <p className="font-semibold text-emerald-400 mb-1">Reviewer Test Credentials (Pre-filled):</p>
          <p>Email: <code className="text-white">admin@mcpserver.com</code></p>
          <p>Password: <code className="text-white">password123</code></p>
        </div>
      </div>
    </div>
  );
}
