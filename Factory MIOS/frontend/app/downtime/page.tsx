"use client";
import { useEffect, useState } from "react";
import { api, getToken } from "../../lib/api";
import Nav from "../../components/Nav";
import Assistant from "../../components/Assistant";

export default function Downtime() {
  const [authed, setAuthed] = useState(true);
  const [logs, setLogs] = useState<any[]>([]);
  const [pareto, setPareto] = useState<any[]>([]);
  const [devices, setDevices] = useState<any[]>([]);
  const [reasons, setReasons] = useState<any[]>([]);
  const [form, setForm] = useState({ device_id: "", reason: "", category: "unplanned", operator: "", remarks: "" });
  const [msg, setMsg] = useState("");

  async function load() {
    try {
      const [lg, pa, dv, rs] = await Promise.all([
        api.downtimeLogs(7), api.downtimePareto(7), api.devices(), api.masterData("downtime_reasons"),
      ]);
      setLogs(lg); setPareto(pa); setDevices(dv); setReasons(rs);
      if (dv.length && !form.device_id) setForm(f => ({ ...f, device_id: dv[0].id }));
    } catch (e: any) { if (/401|token/i.test(e.message)) setAuthed(false); }
  }
  useEffect(() => { if (!getToken()) setAuthed(false); else load(); }, []);

  async function logDowntime(closeNow: boolean) {
    setMsg("");
    try {
      const body: any = { ...form };
      if (closeNow) body.end_time = new Date().toISOString();
      await api.createDowntime(body);
      setMsg(closeNow ? "Downtime logged (closed)." : "Downtime started (open).");
      load();
    } catch (e: any) { setMsg("Error: " + e.message); }
  }

  if (!authed) return <Guard />;

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="text-2xl font-bold">Downtime logging</h1>
        <p className="mt-1 text-slate-600">Log a stoppage, pick a reason from master data, add remarks.</p>

        <div className="card mt-6 grid gap-4 p-5 sm:grid-cols-5">
          <div><label className="label">Machine</label>
            <select className="input" value={form.device_id} onChange={e => setForm({ ...form, device_id: e.target.value })}>
              {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></div>
          <div><label className="label">Reason</label>
            <select className="input" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}>
              <option value="">— select —</option>
              {reasons.map(r => <option key={r.id} value={r.key}>{r.key}</option>)}
            </select></div>
          <div><label className="label">Category</label>
            <select className="input" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
              <option value="unplanned">unplanned</option><option value="planned">planned</option>
            </select></div>
          <div><label className="label">Operator</label>
            <input className="input" value={form.operator} onChange={e => setForm({ ...form, operator: e.target.value })} /></div>
          <div><label className="label">Remarks</label>
            <input className="input" value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} /></div>
          <div className="sm:col-span-5 flex gap-2">
            <button className="btn" onClick={() => logDowntime(false)}>Start (open)</button>
            <button className="btn-ghost" onClick={() => logDowntime(true)}>Log closed event</button>
            {msg && <span className="self-center text-sm text-slate-500">{msg}</span>}
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="card p-5">
            <h2 className="mb-3 font-semibold">Top downtime reasons (7 days)</h2>
            {pareto.length ? pareto.map(p => (
              <div key={p.reason} className="mb-2">
                <div className="flex justify-between text-sm"><span>{p.reason}</span><span>{p.total_minutes.toFixed(0)} min · {p.occurrences}×</span></div>
                <div className="h-2 rounded bg-slate-100"><div className="h-2 rounded bg-brand" style={{ width: `${Math.min(100, p.total_minutes / (pareto[0].total_minutes || 1) * 100)}%` }} /></div>
              </div>
            )) : <p className="text-slate-500">No downtime logged yet.</p>}
          </div>
          <div className="card p-5">
            <h2 className="mb-3 font-semibold">Recent downtime</h2>
            <div className="max-h-80 overflow-auto text-sm">
              <table className="w-full">
                <thead><tr className="text-left text-slate-500"><th>Reason</th><th>Cat</th><th>Min</th><th>Status</th></tr></thead>
                <tbody>{logs.map(l => (
                  <tr key={l.id} className="border-t"><td>{l.reason || "—"}</td><td>{l.category}</td><td>{l.duration_min ?? "—"}</td><td>{l.status}</td></tr>
                ))}</tbody>
              </table>
              {!logs.length && <p className="text-slate-500">No records.</p>}
            </div>
          </div>
        </div>
      </main>
      <Assistant />
    </div>
  );
}

function Guard() {
  return <main className="grid min-h-screen place-items-center px-6 text-center">
    <div><p className="mb-4 text-slate-600">Please sign in.</p><a href="/login" className="btn">Sign in</a></div>
  </main>;
}
