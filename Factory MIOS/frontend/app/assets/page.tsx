"use client";
import { useEffect, useState } from "react";
import { api, getToken } from "../../lib/api";
import Nav from "../../components/Nav";
import Assistant from "../../components/Assistant";

export default function Assets() {
  const [authed, setAuthed] = useState(true);
  const [tree, setTree] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [nodeKind, setNodeKind] = useState("locations");
  const [nodeName, setNodeName] = useState("");
  const [nodeParent, setNodeParent] = useState("");
  const [dev, setDev] = useState({ name: "", machine_type: "", connection_type: "mqtt" });
  const [selDevice, setSelDevice] = useState("");
  const [defs, setDefs] = useState<any[]>([]);
  const [test, setTest] = useState<any>(null);
  const [mapForm, setMapForm] = useState<any>({ raw_name: "", display_name: "", data_type: "numeric", unit: "", aggregation: "last", kpi_type: "raw", is_static: false, static_value: "", alarm_min: "", alarm_max: "" });
  const [dparams, setDparams] = useState<any>({ mapped: [], seen: [], unmapped: [] });
  const [dkpis, setDkpis] = useState<any[]>([]);
  const [dkpiVals, setDkpiVals] = useState<Record<string, any>>({});
  const [shiftForm, setShiftForm] = useState<any>({ name: "", start_time: "06:00", end_time: "14:00", target_production: "" });
  const [dshifts, setDshifts] = useState<any[]>([]);
  const [mdForm, setMdForm] = useState<any>({ dataset: "programs", key: "", f1: "cycle_time", v1: "", f2: "target", v2: "" });
  const [preset, setPreset] = useState("quality");
  const [kpiSel, setKpiSel] = useState<any>({ name: "", p: "", good: "good_count", total: "total_count", running: "running", cycle: "cycle_time", target_ct: "30" });
  const [hubMsg, setHubMsg] = useState("");

  async function load() {
    try {
      const t = await api.tree(); setTree(t);
      if (t.devices.length && !selDevice) setSelDevice(t.devices[0].id);
    } catch (e: any) { if (/401|token/i.test(e.message)) setAuthed(false); }
  }
  useEffect(() => { if (!getToken()) setAuthed(false); else load(); }, []);
  useEffect(() => { if (selDevice) { api.telemetryDefs(selDevice).then(setDefs).catch(() => {}); } }, [selDevice]);
  useEffect(() => {
    if (!selDevice) return;
    api.deviceParameters(selDevice).then(setDparams).catch(() => {});
    api.shiftsFor(selDevice).then(setDshifts).catch(() => {});
    refreshKpis();
  }, [selDevice]);

  async function refreshKpis() {
    if (!selDevice) return;
    try {
      const ks = await api.kpisFor(selDevice);
      setDkpis(ks);
      const vals: Record<string, any> = {};
      await Promise.all(ks.map(async (k: any) => { try { vals[k.id] = await api.computeKpi(k.id, `?device_id=${selDevice}&window_minutes=1440`); } catch {} }));
      setDkpiVals(vals);
    } catch {}
  }

  const paramOpts: string[] = Array.from(new Set([
    ...((dparams.mapped || []).map((m: any) => m.raw_name)),
    ...((dparams.seen || [])),
  ]));

  async function saveShift() {
    setHubMsg("");
    try {
      await api.createShift({ device_id: selDevice, name: shiftForm.name || "Shift",
        start_time: shiftForm.start_time, end_time: shiftForm.end_time,
        target_production: shiftForm.target_production === "" ? null : Number(shiftForm.target_production) });
      setShiftForm({ ...shiftForm, name: "" });
      api.shiftsFor(selDevice).then(setDshifts);
      setHubMsg("Shift saved for this device.");
    } catch (e: any) { setHubMsg("Error: " + e.message); }
  }

  async function addDeviceMaster() {
    setHubMsg("");
    try {
      const attrs: any = {};
      if (mdForm.f1 && mdForm.v1 !== "") attrs[mdForm.f1] = isNaN(Number(mdForm.v1)) ? mdForm.v1 : Number(mdForm.v1);
      if (mdForm.f2 && mdForm.v2 !== "") attrs[mdForm.f2] = isNaN(Number(mdForm.v2)) ? mdForm.v2 : Number(mdForm.v2);
      await api.upsertMaster({ dataset: mdForm.dataset, key: mdForm.key, attributes: attrs });
      setMdForm({ ...mdForm, key: "", v1: "", v2: "" });
      setHubMsg("Master/user-input row saved.");
    } catch (e: any) { setHubMsg("Error: " + e.message); }
  }

  async function buildKpi() {
    setHubMsg("");
    let expression = "", unit = "", inputs: any = {}, defName = "";
    const tele = (param: string, agg: string) => ({ source: "telemetry", parameter: param, agg });
    if (["average", "min", "max", "sum", "delta", "last"].includes(preset)) {
      const aggMap: any = { average: "avg", min: "min", max: "max", sum: "sum", delta: "delta", last: "last" };
      expression = "x"; inputs = { x: tele(kpiSel.p, aggMap[preset]) };
      defName = `${kpiSel.p} ${preset}`;
    } else if (preset === "quality") {
      expression = "good / total * 100"; unit = "%";
      inputs = { good: tele(kpiSel.good, "last"), total: tele(kpiSel.total, "last") };
      defName = "Quality %";
    } else if (preset === "availability") {
      expression = "running * 100"; unit = "%";
      inputs = { running: tele(kpiSel.running, "avg") };
      defName = "Availability %";
    } else if (preset === "oee") {
      expression = "running * (target_ct / cycle) * (good / total) * 100"; unit = "%";
      inputs = { running: tele(kpiSel.running, "avg"), cycle: tele(kpiSel.cycle, "avg"),
        good: tele(kpiSel.good, "last"), total: tele(kpiSel.total, "last"),
        target_ct: { source: "const", value: Number(kpiSel.target_ct) || 30 } };
      defName = "OEE %";
    }
    try {
      await api.createKpi({ name: kpiSel.name || defName, device_id: selDevice, unit, expression, inputs });
      setKpiSel({ ...kpiSel, name: "" });
      refreshKpis();
      setHubMsg(`KPI "${kpiSel.name || defName}" saved.`);
    } catch (e: any) { setHubMsg("Error: " + e.message); }
  }

  const parents: Record<string, any[]> = {
    locations: [], plants: tree?.locations || [], departments: tree?.plants || [], lines: tree?.plants || [],
  };

  async function addNode() {
    setMsg("");
    try { await api.addNode(nodeKind, { name: nodeName, parent_id: nodeParent || null }); setNodeName(""); setMsg("Added."); load(); }
    catch (e: any) { setMsg("Error: " + e.message); }
  }
  async function addDevice() {
    setMsg("");
    try { await api.createDevice(dev); setDev({ name: "", machine_type: "", connection_type: "mqtt" }); setMsg("Machine added."); load(); }
    catch (e: any) { setMsg("Error: " + e.message); }
  }
  async function saveMap() {
    try { await api.saveTelemetryDef({ device_id: selDevice, ...mapForm, alarm_min: mapForm.alarm_min === "" ? null : Number(mapForm.alarm_min), alarm_max: mapForm.alarm_max === "" ? null : Number(mapForm.alarm_max), usage: {} }); api.telemetryDefs(selDevice).then(setDefs); }
    catch (e: any) { setMsg("Error: " + e.message); }
  }
  async function runTest() {
    try { setTest(await api.liveTest(selDevice)); } catch (e: any) { setMsg("Error: " + e.message); }
  }

  if (!authed) return <main className="grid min-h-screen place-items-center"><a className="btn" href="/login">Sign in</a></main>;

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="text-2xl font-bold">Assets & onboarding</h1>
        <p className="mt-1 text-slate-600">Build the hierarchy, add machines, map telemetry, and live-test the data.</p>
        {msg && <p className="mt-2 text-sm text-slate-500">{msg}</p>}

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="card p-5">
            <h2 className="mb-3 font-semibold">Add hierarchy node</h2>
            <div className="grid grid-cols-2 gap-3">
              <select className="input" value={nodeKind} onChange={e => { setNodeKind(e.target.value); setNodeParent(""); }}>
                <option value="locations">Location</option><option value="plants">Plant</option>
                <option value="departments">Department</option><option value="lines">Line</option>
              </select>
              <input className="input" placeholder="name" value={nodeName} onChange={e => setNodeName(e.target.value)} />
              {nodeKind !== "locations" && (
                <select className="input col-span-2" value={nodeParent} onChange={e => setNodeParent(e.target.value)}>
                  <option value="">— parent —</option>
                  {(parents[nodeKind] || []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
              <button className="btn col-span-2" onClick={addNode}>Add node</button>
            </div>
            <h3 className="mt-5 mb-2 text-sm font-semibold text-slate-700">Current tree</h3>
            <div className="text-sm text-slate-600">
              {(tree?.locations || []).map((l: any) => (
                <div key={l.id}>📍 {l.name}
                  {(tree.plants || []).filter((p: any) => p.location_id === l.id).map((p: any) => (
                    <div key={p.id} className="ml-4">🏭 {p.name}
                      {(tree.lines || []).filter((ln: any) => ln.plant_id === p.id).map((ln: any) => (
                        <div key={ln.id} className="ml-8">🛠 {ln.name}</div>))}
                    </div>))}
                </div>
              ))}
              {!tree?.locations?.length && <p className="text-slate-400">No locations yet.</p>}
            </div>
          </div>

          <div className="card p-5">
            <h2 className="mb-3 font-semibold">Add machine / device</h2>
            <div className="grid grid-cols-2 gap-3">
              <input className="input" placeholder="name" value={dev.name} onChange={e => setDev({ ...dev, name: e.target.value })} />
              <input className="input" placeholder="machine type" value={dev.machine_type} onChange={e => setDev({ ...dev, machine_type: e.target.value })} />
              <select className="input col-span-2" value={dev.connection_type} onChange={e => setDev({ ...dev, connection_type: e.target.value })}>
                <option value="mqtt">MQTT</option><option value="https">HTTPS</option><option value="csv">CSV/Excel</option>
              </select>
              <button className="btn col-span-2" onClick={addDevice}>Add machine</button>
            </div>
            <h3 className="mt-5 mb-2 text-sm font-semibold text-slate-700">Machines</h3>
            {(tree?.devices || []).map((d: any) => (
              <div key={d.id} className="border-t py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span>{d.name} <span className="text-slate-400">({d.connection_type})</span></span>
                  <span className={`rounded px-2 text-xs ${d.status === "online" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>{d.status}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="truncate text-xs text-slate-500">key: {d.api_key}</code>
                  <button className="text-xs text-brand-dark hover:underline" onClick={() => navigator.clipboard.writeText(d.api_key)}>copy key</button>
                  <button className="text-xs text-brand-dark hover:underline" onClick={() => navigator.clipboard.writeText(`mios/telemetry/${d.api_key}`)}>copy MQTT topic</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card mt-6 p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-semibold">Telemetry mapping & live test</h2>
            <select className="input w-auto" value={selDevice} onChange={e => { setSelDevice(e.target.value); setTest(null); }}>
              {(tree?.devices || []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <input className="input" placeholder="raw_name (e.g. part_count)" value={mapForm.raw_name} onChange={e => setMapForm({ ...mapForm, raw_name: e.target.value })} />
            <input className="input" placeholder="display name" value={mapForm.display_name} onChange={e => setMapForm({ ...mapForm, display_name: e.target.value })} />
            <select className="input" value={mapForm.data_type} onChange={e => setMapForm({ ...mapForm, data_type: e.target.value })}>
              {["numeric", "counter", "status", "text"].map(t => <option key={t}>{t}</option>)}
            </select>
            <input className="input" placeholder="unit" value={mapForm.unit} onChange={e => setMapForm({ ...mapForm, unit: e.target.value })} />
            <select className="input" value={mapForm.aggregation} onChange={e => setMapForm({ ...mapForm, aggregation: e.target.value })}>
              {["last", "sum", "avg", "min", "max", "delta", "count"].map(t => <option key={t} value={t}>agg: {t}</option>)}
            </select>
            <select className="input" value={mapForm.kpi_type} onChange={e => setMapForm({ ...mapForm, kpi_type: e.target.value })}>
              {["raw", "oee", "availability", "performance", "quality", "delta", "shift", "daily", "timestamp"].map(t => <option key={t} value={t}>kpi: {t}</option>)}
            </select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mapForm.is_static} onChange={e => setMapForm({ ...mapForm, is_static: e.target.checked })} /> static</label>
            {mapForm.is_static
              ? <input className="input" placeholder="static value (e.g. machine name)" value={mapForm.static_value} onChange={e => setMapForm({ ...mapForm, static_value: e.target.value })} />
              : <span />}
            <input className="input" type="number" placeholder="alert min" value={mapForm.alarm_min} onChange={e => setMapForm({ ...mapForm, alarm_min: e.target.value })} />
            <input className="input" type="number" placeholder="alert max" value={mapForm.alarm_max} onChange={e => setMapForm({ ...mapForm, alarm_max: e.target.value })} />
            <button className="btn sm:col-span-1" onClick={saveMap}>Save parameter</button>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold">Mapped parameters</h3>
              {defs.map(d => <div key={d.id} className="border-t py-1 text-sm">{d.display_name} <span className="text-slate-400">({d.raw_name}, {d.unit || "—"}, agg:{d.aggregation}, kpi:{d.kpi_type || "raw"}{d.is_static ? `, static=${d.static_value}` : ""}{(d.alarm_min != null || d.alarm_max != null) ? `, alert ${d.alarm_min ?? "-"}..${d.alarm_max ?? "-"}` : ""})</span></div>)}
              {!defs.length && <p className="text-slate-400 text-sm">None mapped.</p>}
            </div>
            <div>
              <button className="btn-ghost mb-2" onClick={runTest}>Run live test</button>
              {test && (
                <div className="rounded-lg bg-slate-50 p-3 text-sm">
                  <div>Status: <b className={test.status === "data_received" ? "text-green-600" : "text-amber-600"}>{test.status}</b></div>
                  <div>Last seen: {test.last_seen || "—"}</div>
                  <div className="mt-1">Latest payload:</div>
                  <pre className="overflow-auto text-xs">{JSON.stringify(test.latest_payload, null, 1)}</pre>
                  {test.unmapped_parameters?.length > 0 && <div className="text-amber-600">Unmapped: {test.unmapped_parameters.join(", ")}</div>}
                </div>
              )}
            </div>
          </div>
        </div>

        {selDevice && (
          <div className="card mt-6 p-5">
            <h2 className="font-semibold">Device intelligence — {(tree?.devices || []).find((d: any) => d.id === selDevice)?.name || ""}</h2>
            <p className="mt-1 text-sm text-slate-500">Assign a shift, add master / user-input, and build KPIs from this device's parameters.</p>
            {hubMsg && <p className="mt-2 text-sm text-slate-600">{hubMsg}</p>}

            <div className="mt-4 grid gap-6 lg:grid-cols-3">
              {/* Shift */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">Shift</h3>
                <input className="input mb-2" placeholder="shift name (A Shift)" value={shiftForm.name} onChange={e => setShiftForm({ ...shiftForm, name: e.target.value })} />
                <div className="mb-2 flex gap-2">
                  <input className="input" type="time" value={shiftForm.start_time} onChange={e => setShiftForm({ ...shiftForm, start_time: e.target.value })} />
                  <input className="input" type="time" value={shiftForm.end_time} onChange={e => setShiftForm({ ...shiftForm, end_time: e.target.value })} />
                </div>
                <input className="input mb-2" type="number" placeholder="target production" value={shiftForm.target_production} onChange={e => setShiftForm({ ...shiftForm, target_production: e.target.value })} />
                <button className="btn w-full" onClick={saveShift}>Save shift</button>
                <div className="mt-2 text-xs text-slate-500">
                  {dshifts.map((sh: any) => <div key={sh.id}>{sh.name}: {sh.start_time}–{sh.end_time}{sh.target_production ? ` · target ${sh.target_production}` : ""}</div>)}
                </div>
              </div>

              {/* Master / user input */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">Master / user input</h3>
                <select className="input mb-2" value={mdForm.dataset} onChange={e => setMdForm({ ...mdForm, dataset: e.target.value })}>
                  {["programs", "products", "sku", "downtime_reasons", "quality_defects"].map(d => <option key={d}>{d}</option>)}
                </select>
                <input className="input mb-2" placeholder="key (e.g. PRG-100 / SKU-9)" value={mdForm.key} onChange={e => setMdForm({ ...mdForm, key: e.target.value })} />
                <div className="mb-2 flex gap-2">
                  <input className="input" placeholder="field (cycle_time)" value={mdForm.f1} onChange={e => setMdForm({ ...mdForm, f1: e.target.value })} />
                  <input className="input" placeholder="value" value={mdForm.v1} onChange={e => setMdForm({ ...mdForm, v1: e.target.value })} />
                </div>
                <div className="mb-2 flex gap-2">
                  <input className="input" placeholder="field (target)" value={mdForm.f2} onChange={e => setMdForm({ ...mdForm, f2: e.target.value })} />
                  <input className="input" placeholder="value" value={mdForm.v2} onChange={e => setMdForm({ ...mdForm, v2: e.target.value })} />
                </div>
                <button className="btn w-full" onClick={addDeviceMaster}>Save master row</button>
              </div>

              {/* Build KPI */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">Build KPI</h3>
                <select className="input mb-2" value={preset} onChange={e => setPreset(e.target.value)}>
                  <option value="quality">Quality % (good/total)</option>
                  <option value="availability">Availability % (running)</option>
                  <option value="oee">OEE % (avail×perf×quality)</option>
                  <option value="average">Average of parameter</option>
                  <option value="min">Minimum</option>
                  <option value="max">Maximum</option>
                  <option value="sum">Sum / Totalizer</option>
                  <option value="delta">Delta (max−min)</option>
                  <option value="last">Latest value</option>
                </select>
                {["average", "min", "max", "sum", "delta", "last"].includes(preset) && (
                  <Pick label="parameter" v={kpiSel.p} on={(v: string) => setKpiSel({ ...kpiSel, p: v })} opts={paramOpts} />
                )}
                {preset === "quality" && (<>
                  <Pick label="good" v={kpiSel.good} on={(v: string) => setKpiSel({ ...kpiSel, good: v })} opts={paramOpts} />
                  <Pick label="total" v={kpiSel.total} on={(v: string) => setKpiSel({ ...kpiSel, total: v })} opts={paramOpts} />
                </>)}
                {preset === "availability" && (
                  <Pick label="running" v={kpiSel.running} on={(v: string) => setKpiSel({ ...kpiSel, running: v })} opts={paramOpts} />
                )}
                {preset === "oee" && (<>
                  <Pick label="good" v={kpiSel.good} on={(v: string) => setKpiSel({ ...kpiSel, good: v })} opts={paramOpts} />
                  <Pick label="total" v={kpiSel.total} on={(v: string) => setKpiSel({ ...kpiSel, total: v })} opts={paramOpts} />
                  <Pick label="running" v={kpiSel.running} on={(v: string) => setKpiSel({ ...kpiSel, running: v })} opts={paramOpts} />
                  <Pick label="cycle time" v={kpiSel.cycle} on={(v: string) => setKpiSel({ ...kpiSel, cycle: v })} opts={paramOpts} />
                  <input className="input mb-2" type="number" placeholder="target cycle time (s)" value={kpiSel.target_ct} onChange={e => setKpiSel({ ...kpiSel, target_ct: e.target.value })} />
                </>)}
                <input className="input mb-2" placeholder="KPI name (optional)" value={kpiSel.name} onChange={e => setKpiSel({ ...kpiSel, name: e.target.value })} />
                <button className="btn w-full" onClick={buildKpi}>Create KPI</button>
              </div>
            </div>

            <h3 className="mt-6 text-sm font-semibold text-slate-700">This device's KPIs (live)</h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {dkpis.map((k: any) => (
                <div key={k.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="text-xl font-bold text-brand-dark">{dkpiVals[k.id]?.value != null ? `${Math.round(dkpiVals[k.id].value * 10) / 10}${k.unit || ""}` : "—"}</div>
                  <div className="text-xs text-slate-500">{k.name}</div>
                  {dkpiVals[k.id]?.error && <div className="text-xs text-amber-600">{dkpiVals[k.id].error}</div>}
                </div>
              ))}
              {!dkpis.length && <p className="text-sm text-slate-400">No KPIs yet for this device.</p>}
            </div>
          </div>
        )}
      </main>
      <Assistant />
    </div>
  );
}

function Pick({ label, v, on, opts }: { label: string; v: string; on: (v: string) => void; opts: string[] }) {
  return (
    <select className="input mb-2" value={v} onChange={e => on(e.target.value)}>
      <option value="">{`— ${label} —`}</option>
      {opts.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
