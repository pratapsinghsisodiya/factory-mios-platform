"use client";
import { useEffect, useState } from "react";
import { api, getToken } from "../../lib/api";
import Nav from "../../components/Nav";

export default function Clients() {
  const [links, setLinks] = useState<any[]>([]);
  const [label, setLabel] = useState("");
  const [industry, setIndustry] = useState("");
  const [err, setErr] = useState("");
  const [authed, setAuthed] = useState(true);

  async function load() {
    try { setLinks(await api.listLinks()); }
    catch (e: any) { if (/401|token|permission/i.test(e.message)) setAuthed(false); else setErr(e.message); }
  }
  useEffect(() => { if (!getToken()) setAuthed(false); else load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try { await api.createLink({ label, intended_industry: industry, expires_in_days: 14 }); setLabel(""); setIndustry(""); load(); }
    catch (e: any) { setErr(e.message); }
  }

  function fullUrl(path: string) {
    if (typeof window === "undefined") return path;
    return `${window.location.origin}${path}`;
  }

  if (!authed) return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div><p className="mb-4 text-slate-600">Sign in as an admin to create onboarding links.</p>
        <a href="/login" className="btn">Sign in</a></div>
    </main>
  );

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="text-2xl font-bold">Client onboarding links</h1>
        <p className="mt-1 text-slate-600">Generate a unique link to send to a prospective client.</p>

        <form onSubmit={create} className="card mt-6 flex flex-wrap items-end gap-4 p-5">
          <div className="flex-1 min-w-[180px]">
            <label className="label">Label</label>
            <input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="ACME Plant — Pune" />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="label">Industry (optional)</label>
            <input className="input" value={industry} onChange={e => setIndustry(e.target.value)} placeholder="automotive" />
          </div>
          <button className="btn">Generate link</button>
        </form>
        {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

        <div className="mt-8 space-y-3">
          {links.map(l => (
            <div key={l.id} className="card flex items-center justify-between gap-4 p-4">
              <div>
                <div className="font-medium">{l.label || "Untitled"}{l.is_used && <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">used</span>}</div>
                <code className="text-xs text-slate-500">{fullUrl(l.url_path)}</code>
              </div>
              <button className="btn-ghost text-sm" onClick={() => navigator.clipboard.writeText(fullUrl(l.url_path))}>Copy</button>
            </div>
          ))}
          {!links.length && <p className="text-slate-500">No links yet.</p>}
        </div>
      </main>
    </div>
  );
}
