"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "../../lib/api";
import Nav from "../../components/Nav";
import Widget from "../../components/Widget";
import Assistant from "../../components/Assistant";

const REPORTS = ["oee", "downtime", "quality", "performance"];

export default function Dashboard() {
  const [authed, setAuthed] = useState(true);
  const [catalog, setCatalog] = useState<any>(null);
  const [dashboards, setDashboards] = useState<any[]>([]);
  const [active, setActive] = useState<any>(null);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("oee");
  const [devices, setDevices] = useState<any[]>([]);
  const [kpiValues, setKpiValues] = useState<Record<string, any>>({});
  const [exporting, setExporting] = useState("");

  async function load() {
    try {
      const [cat, dash, devs] = await Promise.all([api.catalog(), api.dashboards(), api.devices()]);
      setCatalog(cat); setDashboards(dash); setDevices(devs);
      if (dash.length) setActive(dash[0]);
    } catch (e: any) { if (/401|token/i.test(e.message)) setAuthed(false); }
  }
  useEffect(() => { if (!getToken()) setAuthed(false); else load(); }, []);

  // Live values for KPI-bound AND raw-parameter-bound widgets; refreshes every 10s.
  useEffect(() => {
    const widgets = active?.layout?.widgets || [];
    const kpiIds: string[] = Array.from(new Set(widgets.map((w: any) => w.kpi_id).filter(Boolean)));
    const raws = widgets.filter((w: any) => !w.kpi_id && w.device_id && w.parameter);
    if (!kpiIds.length && !raws.length) { setKpiValues({}); return; }
    let cancelled = false;
    async function pull() {
      const out: Record<string, any> = {};
      await Promise.all(kpiIds.map(async (id) => {
        try { out[`kpi:${id}`] = await api.computeKpi(id, "?window_minutes=60"); } catch {}
      }));
      await Promise.all(raws.map(async (w: any) => {
        try { out[`raw:${w.device_id}:${w.parameter}:${w.agg || "last"}`] = await api.deviceValue(w.device_id, w.parameter, w.agg || "last", 1440); } catch {}
      }));
      if (!cancelled) setKpiValues(out);
    }
    pull();
    const t = setInterval(pull, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, [active]);

  async function create() {
    const d = await api.createDashboard({ name: name || `${template} dashboard`, template });
    setName(""); const dash = await api.dashboards(); setDashboards(dash);
    setActive(dash.find((x: any) => x.id === d.id) || d);
  }

  async function exportReport(type: string) {
    setExporting(type);
    try { await api.downloadReport(type, 1440); } catch (e: any) { alert(e.message); }
    finally { setExporting(""); }
  }

  if (!authed) return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div><p className="mb-4 text-slate-600">Please sign in to view dashboards.</p><a href="/login" className="btn">Sign in</a></div>
    </main>
  );

  const widgets = active?.layout?.widgets || [];

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Dashboards</h1>
            {catalog && <p className="mt-1 text-sm text-slate-500">
              Catalog: {catalog.counts.widget_types} widget types · {catalog.counts.industries} industries · {catalog.counts.machine_types} machine types · {catalog.counts.templates} templates · {devices.length} devices connected
            </p>}
          </div>
          <div className="flex items-end gap-2">
            <div><label className="label">New dashboard</label>
              <input className="input" placeholder="name" value={name} onChange={e => setName(e.target.value)} /></div>
            <select className="input w-auto" value={template} onChange={e => setTemplate(e.target.value)}>
              {catalog?.templates.map((t: any) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
            <button className="btn" onClick={create}>Create</button>
            <Link href="/builder" className="btn-ghost">Open builder</Link>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-500">Export Excel report:</span>
          {REPORTS.map(t => (
            <button key={t} onClick={() => exportReport(t)} disabled={!!exporting}
              className="btn-ghost text-sm capitalize">
              {exporting === t ? "Exporting…" : `${t} .xlsx`}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {dashboards.map(d => (
            <button key={d.id} onClick={() => setActive(d)}
              className={`rounded-lg px-3 py-1.5 text-sm ${active?.id === d.id ? "bg-brand text-white" : "card"}`}>{d.name}</button>
          ))}
          {active && <Link href={`/builder?id=${active.id}`} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100">✎ Edit “{active.name}”</Link>}
        </div>

        {active ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {widgets.map((w: any, i: number) => {
              const kv = w.kpi_id ? kpiValues[`kpi:${w.kpi_id}`]
                : (w.device_id && w.parameter ? kpiValues[`raw:${w.device_id}:${w.parameter}:${w.agg || "last"}`] : null);
              return <Widget key={i} type={w.type} title={w.title}
                value={kv ? kv.value : undefined} unit={kv ? kv.unit : undefined} />;
            })}
          </div>
        ) : (
          <div className="card mt-6 p-10 text-center text-slate-500">
            Create a dashboard from a template, or open the builder to drag widgets.
          </div>
        )}
      </main>
      <Assistant />
    </div>
  );
}
