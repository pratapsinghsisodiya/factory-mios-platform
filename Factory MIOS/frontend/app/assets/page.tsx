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
  const [mapForm, setMapForm] = useState({ raw_name: "", display_name: "", data_type: "numeric", unit: "", aggregation: "last" });

  async function load() {
    try {
      const t = await api.tree(); setTree(t);
      if (t.devices.length && !selDevice) setSelDevice(t.devices[0].id);
    } catch (e: any) { if (/401|token/i.test(e.message)) setAuthed(false); }
  }
  useEffect(() => { if (!getToken()) setAuthed(false); else load(); }, []);
  useEffect(() => { if (selDevice) { api.telemetryDefs(selDevice).then(setDefs).catch(() => {}); } }, [selDevice]);

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
    try { await api.saveTelemetryDef({ device_id: selDevice, ...mapForm, usage: {} }); api.telemetryDefs(selDevice).then(setDefs); }
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
              <div key={d.id} className="flex items-center justify-between border-t py-1 text-sm">
                <span>{d.name} <span className="text-slate-400">({d.connection_type})</span></span>
                <span className={`rounded px-2 text-xs ${d.status === "online" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>{d.status}</span>
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
          <div className="mt-4 grid gap-3 sm:grid-cols-5">
            <input className="input" placeholder="raw_name" value={mapForm.raw_name} onChange={e => setMapForm({ ...mapForm, raw_name: e.target.value })} />
            <input className="input" placeholder="display name" value={mapForm.display_name} onChange={e => setMapForm({ ...mapForm, display_name: e.target.value })} />
            <select className="input" value={mapForm.data_type} onChange={e => setMapForm({ ...mapForm, data_type: e.target.value })}>
              {["numeric", "counter", "status", "text"].map(t => <option key={t}>{t}</option>)}
            </select>
            <input className="input" placeholder="unit" value={mapForm.unit} onChange={e => setMapForm({ ...mapForm, unit: e.target.value })} />
            <button className="btn" onClick={saveMap}>Save mapping</button>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold">Mapped parameters</h3>
              {defs.map(d => <div key={d.id} className="border-t py-1 text-sm">{d.display_name} <span className="text-slate-400">({d.raw_name}, {d.unit || "—"}, {d.aggregation})</span></div>)}
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
      </main>
      <Assistant />
    </div>
  );
}
