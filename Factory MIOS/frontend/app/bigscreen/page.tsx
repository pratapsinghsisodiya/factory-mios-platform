"use client";
import { useEffect, useState } from "react";
import { api, getToken } from "../../lib/api";

export default function BigScreen() {
  const [devices, setDevices] = useState<any[]>([]);
  const [quality, setQuality] = useState<any>(null);
  const [downtime, setDowntime] = useState<any[]>([]);
  const [oee, setOee] = useState<any>(null);
  const [clock, setClock] = useState("");

  async function load() {
    try {
      const [dv, ql, dt] = await Promise.all([api.devices(), api.qualitySummary(1), api.downtimePareto(1)]);
      setDevices(dv); setQuality(ql); setDowntime(dt);
      try { const r = await api.factobot("today's oee"); setOee(r.data?.oee ?? null); } catch {}
    } catch {}
  }
  useEffect(() => {
    if (!getToken()) { location.href = "/login"; return; }
    load();
    const t = setInterval(load, 10000);
    const c = setInterval(() => setClock(new Date().toLocaleTimeString()), 1000);
    return () => { clearInterval(t); clearInterval(c); };
  }, []);

  const online = devices.filter(d => d.status === "online").length;

  return (
    <div className="min-h-screen bg-slate-950 p-6 text-white">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-extrabold">Factory MIOS — Live Floor</h1>
        <div className="text-2xl font-mono text-slate-300">{clock}</div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-6 lg:grid-cols-4">
        <Tile label="OEE (today)" value={oee != null ? `${oee}%` : "—"} accent="text-sky-400" />
        <Tile label="Machines online" value={`${online}/${devices.length}`} accent="text-emerald-400" />
        <Tile label="Good (today)" value={quality ? quality.good : "—"} accent="text-emerald-400" />
        <Tile label="Reject rate" value={quality ? `${quality.reject_rate_pct}%` : "—"} accent="text-rose-400" />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl bg-slate-900 p-6">
          <h2 className="mb-4 text-xl font-bold text-slate-300">Machine status</h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {devices.map(d => (
              <div key={d.id} className={`rounded-xl p-4 text-center ${d.status === "online" ? "bg-emerald-600" : "bg-slate-700"}`}>
                <div className="text-sm font-semibold">{d.name}</div>
                <div className="text-xs opacity-80">{d.status}</div>
              </div>
            ))}
            {!devices.length && <div className="text-slate-500">No machines</div>}
          </div>
        </div>
        <div className="rounded-2xl bg-slate-900 p-6">
          <h2 className="mb-4 text-xl font-bold text-slate-300">Top downtime (today)</h2>
          {downtime.length ? downtime.slice(0, 6).map(p => (
            <div key={p.reason} className="mb-3">
              <div className="flex justify-between text-sm"><span>{p.reason}</span><span>{p.total_minutes.toFixed(0)} min</span></div>
              <div className="h-3 rounded bg-slate-800"><div className="h-3 rounded bg-rose-500" style={{ width: `${Math.min(100, p.total_minutes / (downtime[0].total_minutes || 1) * 100)}%` }} /></div>
            </div>
          )) : <div className="text-slate-500">No downtime logged today</div>}
        </div>
      </div>
      <a href="/dashboard" className="mt-6 inline-block text-sm text-slate-500 hover:text-slate-300">← back to app</a>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: any; accent: string }) {
  return (
    <div className="rounded-2xl bg-slate-900 p-6 text-center">
      <div className={`text-5xl font-extrabold ${accent}`}>{value}</div>
      <div className="mt-2 text-sm uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  );
}
