"use client";
import { useEffect, useState } from "react";
import { api, getToken } from "../../lib/api";
import Nav from "../../components/Nav";
import Assistant from "../../components/Assistant";

export default function Quality() {
  const [authed, setAuthed] = useState(true);
  const [logs, setLogs] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [devices, setDevices] = useState<any[]>([]);
  const [defects, setDefects] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ device_id: "", product: "", job_id: "", batch_id: "", serial_no: "", good_qty: 0, reject_qty: 0, rework_qty: 0, defect_reason: "", operator: "" });
  const [msg, setMsg] = useState("");

  async function load() {
    try {
      const [lg, sm, dv, df] = await Promise.all([
        api.qualityLogs(7), api.qualitySummary(7), api.devices(), api.masterData("quality_defects"),
      ]);
      setLogs(lg); setSummary(sm); setDevices(dv); setDefects(df);
      if (dv.length && !form.device_id) setForm((f: any) => ({ ...f, device_id: dv[0].id }));
    } catch (e: any) { if (/401|token/i.test(e.message)) setAuthed(false); }
  }
  useEffect(() => { if (!getToken()) setAuthed(false); else load(); }, []);

  function up(k: string, v: any) { setForm({ ...form, [k]: v }); }
  async function submit() {
    setMsg("");
    try {
      await api.createQuality({ ...form, good_qty: +form.good_qty, reject_qty: +form.reject_qty, rework_qty: +form.rework_qty });
      setMsg("Quality entry logged."); load();
    } catch (e: any) { setMsg("Error: " + e.message); }
  }

  if (!authed) return <main className="grid min-h-screen place-items-center"><a className="btn" href="/login">Sign in</a></main>;

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="text-2xl font-bold">Quality logging</h1>
        <p className="mt-1 text-slate-600">Record good / reject / rework shift- and date-wise with defect reason.</p>

        {summary && (
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Good (7d)" value={summary.good} />
            <Stat label="Reject (7d)" value={summary.reject} />
            <Stat label="Reject rate" value={`${summary.reject_rate_pct}%`} />
            <Stat label="First-pass yield" value={`${summary.fpy_pct}%`} />
          </div>
        )}

        <div className="card mt-6 grid gap-3 p-5 sm:grid-cols-4">
          <Field label="Machine" type="select" value={form.device_id} on={(v: string) => up("device_id", v)} options={devices.map(d => [d.id, d.name])} />
          <Field label="Product" value={form.product} on={(v: string) => up("product", v)} />
          <Field label="Job ID" value={form.job_id} on={(v: string) => up("job_id", v)} />
          <Field label="Serial No" value={form.serial_no} on={(v: string) => up("serial_no", v)} />
          <Field label="Good qty" value={form.good_qty} on={(v: string) => up("good_qty", v)} />
          <Field label="Reject qty" value={form.reject_qty} on={(v: string) => up("reject_qty", v)} />
          <Field label="Rework qty" value={form.rework_qty} on={(v: string) => up("rework_qty", v)} />
          <Field label="Defect" type="select" value={form.defect_reason} on={(v: string) => up("defect_reason", v)} options={[["", "—"], ...defects.map(d => [d.key, d.key])]} />
          <div className="sm:col-span-4 flex items-center gap-2">
            <button className="btn" onClick={submit}>Log quality entry</button>
            {msg && <span className="text-sm text-slate-500">{msg}</span>}
          </div>
        </div>

        <div className="card mt-8 p-5">
          <h2 className="mb-3 font-semibold">Recent quality logs</h2>
          <div className="max-h-96 overflow-auto text-sm">
            <table className="w-full">
              <thead><tr className="text-left text-slate-500"><th>Product</th><th>Job</th><th>Good</th><th>Reject</th><th>Defect</th></tr></thead>
              <tbody>{logs.map(l => (
                <tr key={l.id} className="border-t"><td>{l.product || "—"}</td><td>{l.job_id || "—"}</td><td>{l.good_qty}</td><td>{l.reject_qty}</td><td>{l.defect_reason || "—"}</td></tr>
              ))}</tbody>
            </table>
            {!logs.length && <p className="text-slate-500">No records.</p>}
          </div>
        </div>
      </main>
      <Assistant />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return <div className="card p-4"><div className="text-2xl font-bold text-brand-dark">{value}</div><div className="text-xs text-slate-500">{label}</div></div>;
}
function Field({ label, value, on, type = "text", options = [] }:
  { label: string; value: any; on: (v: string) => void; type?: string; options?: any[] }) {
  return (
    <div>
      <label className="label">{label}</label>
      {type === "select"
        ? <select className="input" value={value} onChange={e => on(e.target.value)}>{options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
        : <input className="input" value={value} onChange={e => on(e.target.value)} />}
    </div>
  );
}
