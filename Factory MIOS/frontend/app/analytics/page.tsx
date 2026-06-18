"use client";
import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from "recharts";
import { api, getToken } from "../../lib/api";
import Nav from "../../components/Nav";
import Assistant from "../../components/Assistant";

const COLORS = ["#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6"];

export default function Analytics() {
  const [authed, setAuthed] = useState(true);
  const [params, setParams] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [hours, setHours] = useState(24);
  const [agg, setAgg] = useState<any[]>([]);
  const [series, setSeries] = useState<any>({});

  async function load() {
    try { const p = await api.analyticsParams(); setParams(p); setSelected(p.slice(0, 2)); }
    catch (e: any) { if (/401|token/i.test(e.message)) setAuthed(false); }
  }
  useEffect(() => { if (!getToken()) setAuthed(false); else load(); }, []);

  async function run() {
    if (!selected.length) return;
    const body = { parameters: selected, hours, bucket_minutes: hours <= 24 ? 60 : 240 };
    const [a, t] = await Promise.all([api.aggregate(body), api.trend(body)]);
    setAgg(a); setSeries(t);
  }
  useEffect(() => { if (selected.length) run(); }, [selected, hours]);

  function toggle(p: string) {
    setSelected(s => s.includes(p) ? s.filter(x => x !== p) : [...s, p]);
  }

  // merge series into one dataset keyed by time
  const times = Array.from(new Set(Object.values(series).flatMap((arr: any) => arr.map((d: any) => d.t)))).sort();
  const chartData = times.map(t => {
    const row: any = { t: String(t).slice(11, 16) };
    for (const p of Object.keys(series)) { const pt = series[p].find((d: any) => d.t === t); row[p] = pt ? pt.v : null; }
    return row;
  });

  if (!authed) return <main className="grid min-h-screen place-items-center"><a className="btn" href="/login">Sign in</a></main>;

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="text-2xl font-bold">AI analytics</h1>
        <p className="mt-1 text-slate-600">Pick parameters, compare, and see avg / min / max / trend.</p>

        <div className="card mt-6 p-5">
          <div className="flex flex-wrap items-center gap-2">
            {params.map(p => (
              <button key={p} onClick={() => toggle(p)}
                className={`rounded-full px-3 py-1 text-sm ${selected.includes(p) ? "bg-brand text-white" : "border border-slate-300 text-slate-600"}`}>{p}</button>
            ))}
            {!params.length && <span className="text-slate-400">No telemetry yet — start the demo simulator.</span>}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <label className="text-sm text-slate-500">Window:</label>
            <select className="input w-auto" value={hours} onChange={e => setHours(+e.target.value)}>
              <option value={6}>6 h</option><option value={24}>24 h</option><option value={168}>7 days</option><option value={720}>30 days</option>
            </select>
          </div>
        </div>

        {agg.length > 0 && (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agg.map(a => (
              <div key={a.parameter} className="card p-4">
                <div className="text-sm font-semibold">{a.parameter}</div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center text-sm">
                  <div><div className="text-lg font-bold text-brand-dark">{a.avg ?? "—"}</div><div className="text-xs text-slate-500">avg</div></div>
                  <div><div className="text-lg font-bold">{a.min ?? "—"}</div><div className="text-xs text-slate-500">min</div></div>
                  <div><div className="text-lg font-bold">{a.max ?? "—"}</div><div className="text-xs text-slate-500">max</div></div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="card mt-6 p-5">
          <h2 className="mb-3 font-semibold">Trend comparison</h2>
          <div className="h-80">
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="t" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} />
                <Tooltip /><Legend />
                {selected.map((p, i) => <Line key={p} dataKey={p} stroke={COLORS[i % COLORS.length]} dot={false} strokeWidth={2} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </main>
      <Assistant />
    </div>
  );
}
