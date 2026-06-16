"use client";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { api, getToken } from "../../lib/api";
import Nav from "../../components/Nav";
import Widget from "../../components/Widget";

type W = { id: string; type: string; title: string; kpi_id?: string };

function uid() { return Math.random().toString(36).slice(2, 9); }

function Builder() {
  const params = useSearchParams();
  const router = useRouter();
  const dashId = params.get("id");
  const [authed, setAuthed] = useState(true);
  const [catalog, setCatalog] = useState<any>(null);
  const [kpis, setKpis] = useState<any[]>([]);
  const [name, setName] = useState("New dashboard");
  const [widgets, setWidgets] = useState<W[]>([]);
  const [dragType, setDragType] = useState<string | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!getToken()) { setAuthed(false); return; }
    (async () => {
      try {
        const [cat, kp] = await Promise.all([api.catalog(), api.kpis()]);
        setCatalog(cat); setKpis(kp);
        if (dashId) {
          const d = await api.getDashboard(dashId);
          setName(d.name);
          setWidgets((d.layout?.widgets || []).map((w: any) => ({ id: uid(), type: w.type, title: w.title || w.type, kpi_id: w.kpi_id })));
        }
      } catch (e: any) { if (/401|token/i.test(e.message)) setAuthed(false); }
    })();
  }, [dashId]);

  function addWidget(type: string) {
    setWidgets(w => [...w, { id: uid(), type, title: prettyName(type) }]);
  }
  function onDropPalette(e: React.DragEvent) {
    e.preventDefault();
    if (dragType) addWidget(dragType);
    setDragType(null);
  }
  function reorder(from: number, to: number) {
    setWidgets(w => { const c = [...w]; const [m] = c.splice(from, 1); c.splice(to, 0, m); return c; });
  }
  function update(id: string, patch: Partial<W>) {
    setWidgets(w => w.map(x => x.id === id ? { ...x, ...patch } : x));
  }
  function remove(id: string) { setWidgets(w => w.filter(x => x.id !== id)); }

  function prettyName(type: string) {
    return catalog?.widget_types.find((t: any) => t.type === type)?.name || type;
  }

  async function save() {
    setMsg("");
    const layout = { widgets: widgets.map((w, i) => ({ type: w.type, title: w.title, kpi_id: w.kpi_id, x: i % 3, y: Math.floor(i / 3) })) };
    try {
      if (dashId) { await api.updateDashboard(dashId, { name, template: "custom", layout }); setMsg("Saved."); }
      else { const d = await api.createDashboard({ name, template: "custom", layout }); router.replace(`/builder?id=${d.id}`); setMsg("Created & saved."); }
    } catch (e: any) { setMsg("Error: " + e.message); }
  }

  if (!authed) return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div><p className="mb-4 text-slate-600">Please sign in to use the builder.</p><a href="/login" className="btn">Sign in</a></div>
    </main>
  );

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <input className="input max-w-xs text-lg font-semibold" value={name} onChange={e => setName(e.target.value)} />
          <div className="flex items-center gap-2">
            {msg && <span className="text-sm text-slate-500">{msg}</span>}
            <button className="btn-ghost" onClick={() => router.push("/dashboard")}>Open in viewer</button>
            <button className="btn" onClick={save}>Save dashboard</button>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[220px_1fr]">
          {/* Palette */}
          <aside className="card h-fit p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Widgets — drag onto canvas</h3>
            <div className="space-y-2">
              {catalog?.widget_types.map((t: any) => (
                <div key={t.type} draggable
                  onDragStart={() => setDragType(t.type)}
                  onClick={() => addWidget(t.type)}
                  className="cursor-grab rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm hover:border-brand hover:bg-brand/5">
                  <span className="font-medium">{t.name}</span>
                  <span className="ml-1 text-xs text-slate-400">{t.category}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-400">Tip: drag to add, or click. Reorder by dragging cards on the canvas.</p>
          </aside>

          {/* Canvas */}
          <section
            onDragOver={e => e.preventDefault()}
            onDrop={onDropPalette}
            className="min-h-[300px] rounded-2xl border-2 border-dashed border-slate-300 p-4">
            {widgets.length === 0 && (
              <div className="grid h-64 place-items-center text-slate-400">Drop widgets here to build your dashboard</div>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {widgets.map((w, i) => (
                <div key={w.id}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); e.stopPropagation(); if (dragIdx !== null && dragIdx !== i) reorder(dragIdx, i); setDragIdx(null); }}
                  className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
                  <div className="mb-1 flex items-center gap-1">
                    <span className="cursor-grab select-none text-slate-300">⠿</span>
                    <input className="w-full rounded px-1 text-sm font-medium outline-none focus:bg-slate-50"
                      value={w.title} onChange={e => update(w.id, { title: e.target.value })} />
                    <button onClick={() => remove(w.id)} className="text-slate-400 hover:text-red-500">✕</button>
                  </div>
                  <Widget type={w.type} title="" />
                  <select className="input mt-2 text-xs" value={w.kpi_id || ""} onChange={e => update(w.id, { kpi_id: e.target.value || undefined })}>
                    <option value="">— bind a KPI (optional) —</option>
                    {kpis.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

export default function BuilderPage() {
  return <Suspense fallback={<div className="p-10 text-slate-500">Loading builder…</div>}><Builder /></Suspense>;
}
