"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, setToken } from "../../lib/api";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("demo@factory-mios.local");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const t = await api.login(email, password);
      setToken(t.access_token);
      router.push("/dashboard");
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <main className="grid min-h-screen place-items-center px-6">
      <form onSubmit={submit} className="card w-full max-w-sm p-8">
        <Link href="/" className="mb-6 block text-center font-bold text-lg">Factory MIOS</Link>
        <h1 className="mb-6 text-xl font-semibold">Sign in</h1>
        <label className="label">Email</label>
        <input className="input mb-4" value={email} onChange={e => setEmail(e.target.value)} type="email" required />
        <label className="label">Password</label>
        <input className="input mb-6" value={password} onChange={e => setPassword(e.target.value)} type="password" required />
        {err && <p className="mb-4 text-sm text-red-600">{err}</p>}
        <button className="btn w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="mt-4 text-center text-xs text-slate-500">Demo password: Demo!2026</p>
      </form>
    </main>
  );
}
