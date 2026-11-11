"use client";
import { useState } from "react";
import Link from "next/link";

export default function LoginPage() {
  const [email, setEmail] = useState("admin@mcpserver.com");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (
      email.trim().toLowerCase() === "admin@mcpserver.com" &&
      password === "password123"
    ) {
      if (typeof window !== "undefined") {
        localStorage.setItem("mcp_admin_auth", "true");
        window.location.href = "/";
      }
    } else {
      setError("Invalid credentials. Use admin@mcpserver.com / password123");
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-sm w-full space-y-5 shadow-2xl">
        <div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              🔒 Shop Owner Access
            </span>
            <Link
              href="/"
              className="text-xs text-slate-400 hover:text-white"
            >
              ← Read-Only View
            </Link>
          </div>
          <h1 className="text-xl font-bold mt-3">MCP Server Admin Login</h1>
          <p className="text-xs text-slate-400 mt-1">
            Sign in to confirm Claude MCP drafts, edit rates, or manage shop keys.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Admin Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white"
              required
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white"
              required
            />
          </div>

          {error && (
            <p className="text-xs text-rose-400 bg-rose-950/50 border border-rose-800 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold py-3 rounded-xl text-sm transition cursor-pointer"
          >
            Sign In as Ravi (Shop Admin)
          </button>
        </form>

        <div className="pt-3 border-t border-slate-800 space-y-2 text-[11px] text-slate-400">
          <div className="flex items-center justify-between">
            <span>Reviewer Test Credentials:</span>
            <button
              type="button"
              onClick={() => {
                setEmail("admin@mcpserver.com");
                setPassword("password123");
              }}
              className="text-emerald-400 hover:underline font-semibold cursor-pointer"
            >
              Auto-Fill
            </button>
          </div>
          <p className="font-mono text-slate-300 bg-slate-950 px-3 py-2 rounded-lg border border-slate-800">
            Email: admin@mcpserver.com
            <br />
            Pass: password123
          </p>
          <p className="text-[10px] text-slate-500">
            Note: External vendors & customers do not log in here—they use their capability-scoped statement link (/s/[token]).
          </p>
        </div>
      </div>
    </div>
  );
}
