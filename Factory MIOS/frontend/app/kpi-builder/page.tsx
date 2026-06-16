"use client";
import { useEffect, useState } from "react";
import { api, getToken } from "../../lib/api";
import Nav from "../../components/Nav";
import Assistant from "../../components/Assistant";

type Input = { var: string; source: string; parameter?: string; dataset?: string; key?: string; field?: string; agg?: string; value?: number };

export default function KpiBuilder() {
  const [authed, setAuthed] = useState(true);
  const [kpis, setKpis] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("%");
  const [expr, setExpr] = useState("good / total * 100");
  const [inputs, setInputs] = useState<Input[]>([
    { var: "good", source: "telemetry", parameter: "good_count", agg: "last" },
    { var: "total", source: "telemetry", parameter: "total_count", agg: "last" },
  ]);
  const [err, setErr] = useState(""); const [ok, setOk] = useState("");

  async function load() {
    try { setKpis(await api.kpis()); } catch (e: any) { if (/401|token/i.test(e.message)) setAuthed(false); }
  }
  useEffect(() => { if (!getToken()) setAuthed(false); else load(); }, []);

  function setInput(i: number, k: string, v: any) {
    const copy = [...inputs]; (copy[i] as any)[k] = v; setInputs(copy);
  }
  function addInput() { setInputs([...inputs, { var: `x${inputs.length}`, source: "telemetry", parameter: "", agg: "last" }]); }

  async function save() {
    setErr(""); setOk("");
    const inputsMap: any = {};
    for (const i of inputs) {
      const { var: v, ...rest } = i;
      inputsMap[v] = rest;
    }
    try { await api.createKpi({ name, unit, expression: expr, inputs: inputsMap }); setOk("KPI saved."); load(); }
    catch (e: any) { setErr(e.message); }
  }

  if (!authed) return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div><p className="mb-4 text-slate-600">Please sign in to build KPIs.</p><a href="/login" className="btn">Sign in</a></div>
    </main>
  );

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-bold">No-code KPI builder</h1>
        <p className="mt-1 text-slate-600">Wire parameters, master data and constants into a formula — like connecting wires with a math operator.</p>

        <div className="card mt-6 space-y-4 p-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div><label className="label">Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Quality Rate" /></div>
            <div><label className="label">Unit</label><input className="input" value={unit} onChange={e => setUnit(e.target.value)} /></div>
            <div><label className="label">Expression</label><input className="input font-mono" value={expr} onChange={e => setExpr(e.target.value)} /></div>
          </div>

          <div>
            <label className="label">Inputs (variables used in the expression)</label>
            <div className="space-y-2">
              {inputs.map((inp, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <input className="input w-24" value={inp.var} onChange={e => setInput(i, "var", e.target.value)} placeholder="var" />
                  <select className="input w-36" value={inp.source} onChange={e => setInput(i, "source", e.target.value)}>
                    <option value="telemetry">telemetry</option><option value="master">master data</option><option value="const">constant</option>
                  </select>
                  {inp.source === "telemetry" && (<>
                    <input className="input w-44" value={inp.parameter || ""} onChange={e => setInput(i, "parameter", e.target.value)} placeholder="parameter" />
                    <select className="input w-28" value={inp.agg} onChange={e => setInput(i, "agg", e.target.value)}>
                      {["last", "first", "sum", "avg", "min", "max", "count", "delta"].map(a => <option key={a}>{a}</option>)}
                    </select>
                  </>)}
                  {inp.source === "master" && (<>
                    <input className="input w-28" value={inp.dataset || ""} onChange={e => setInput(i, "dataset", e.target.value)} placeholder="dataset" />
                    <input className="input w-28" value={inp.key || ""} onChange={e => setInput(i, "key", e.target.value)} placeholder="key" />
                    <input className="input w-36" value={inp.field || ""} onChange={e => setInput(i, "field", e.target.value)} placeholder="field" />
                  </>)}
                  {inp.source === "const" && (
                    <input className="input w-32" type="number" value={inp.value ?? ""} onChange={e => setInput(i, "value", parseFloat(e.target.value))} placeholder="value" />
                  )}
                </div>
              ))}
            </div>
            <button className="btn-ghost mt-3 text-sm" onClick={addInput}>+ Add input</button>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          {ok && <p className="text-sm text-green-600">{ok}</p>}
          <button className="btn" onClick={save}>Save KPI</button>
        </div>

        <h2 className="mt-10 text-lg font-semibold">Existing KPIs</h2>
        <div className="mt-3 space-y-2">
          {kpis.map(k => (
            <div key={k.id} className="card flex items-center justify-between p-4">
              <div><div className="font-medium">{k.name} <span className="text-slate-400">({k.unit})</span></div>
                <code className="text-xs text-slate-500">{k.expression}</code></div>
            </div>
          ))}
          {!kpis.length && <p className="text-slate-500">No KPIs yet.</p>}
        </div>
      </main>
      <Assistant />
    </div>
  );
}
