"use client";
import { useEffect, useState } from "react";
import { api, getToken } from "../../lib/api";
import Nav from "../../components/Nav";
import Assistant from "../../components/Assistant";

const ROLES = ["Operator", "Supervisor", "Manager", "Top Management"];

const ROLE_CONTENT: Record<string, { title: string; cards: string[] }> = {
  Operator: { title: "Operator View", cards: ["Current machine status", "Current job / target vs actual", "Log downtime", "Log quality", "Shift production"] },
  Supervisor: { title: "Supervisor View", cards: ["Line performance", "Shift production", "Downtime approval", "Quality issues", "Operator performance"] },
  Manager: { title: "Manager View", cards: ["Plant OEE", "Production loss", "Rejection trend", "Top downtime reasons", "Machine comparison", "Shift comparison"] },
  "Top Management": { title: "Top Management View", cards: ["Multi-plant summary", "Overall OEE trend", "Major losses", "Quality trend", "Energy performance", "Executive summary"] },
};

export default function Views() {
  const [authed, setAuthed] = useState(true);
  const [role, setRole] = useState("Operator");
  const [kpis, setKpis] = useState<Record<string, any>>({});
  const [devices, setDevices] = useState<any[]>([]);
  const [downtime, setDowntime] = useState<any[]>([]);
  const [quality, setQuality] = useState<any>(null);

  async function load() {
    try {
      const [dv, dt, ql] = await Promise.all([api.devices(), api.downtimePareto(7), api.qualitySummary(7)]);
      setDevices(dv); setDowntime(dt); setQuality(ql);
      const ks = await api.kpis();
      const vals: Record<string, any> = {};
      await Promise.all(ks.slice(0, 4).map(async (k: any) => { try { vals[k.name] = await api.computeKpi(k.id, "?window_minutes=1440"); } catch {} }));
      setKpis(vals);
    } catch (e: any) { if (/401|token/i.test(e.message)) setAuthed(false); }
  }
  useEffect(() => { if (!getToken()) setAuthed(false); else load(); }, []);

  if (!authed) return <main className="grid min-h-screen place-items-center"><a className="btn" href="/login">Sign in</a></main>;

  const content = ROLE_CONTENT[role];
  const online = devices.filter(d => d.status === "online").length;

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">{content.title}</h1>
          <div className="flex gap-2">
            {ROLES.map(r => (
              <button key={r} onClick={() => setRole(r)}
                className={`rounded-lg px-3 py-1.5 text-sm ${role === r ? "bg-brand text-white" : "card"}`}>{r}</button>
            ))}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Kpi label="Machines online" value={`${online}/${devices.length}`} />
          {quality && <Kpi label="Reject rate (7d)" value={`${quality.reject_rate_pct}%`} />}
          {quality && <Kpi label="Good (7d)" value={quality.good} />}
          <Kpi label="Top downtime" value={downtime[0]?.reason || "—"} />
          {Object.entries(kpis).map(([n, v]: any) => (
            <Kpi key={n} label={n} value={v?.value != null ? `${Math.round(v.value * 10) / 10}${v.unit || ""}` : "—"} />
          ))}
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {content.cards.map(c => (
            <div key={c} className="card flex h-28 flex-col justify-center p-4">
              <div className="font-medium">{c}</div>
              <div className="text-xs text-slate-400">role-scoped panel</div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-slate-500">Each role sees a tailored set of panels. Operators get input + status; management gets aggregated trends.</p>
      </main>
      <Assistant />
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: any }) {
  return <div className="card p-4"><div className="text-2xl font-bold text-brand-dark">{value}</div><div className="text-xs text-slate-500">{label}</div></div>;
}
