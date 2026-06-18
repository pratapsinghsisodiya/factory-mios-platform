"use client";
import { useEffect, useState } from "react";
import { api, getToken } from "../../lib/api";
import Nav from "../../components/Nav";

export default function Clients() {
  const [authed, setAuthed] = useState(true);
  const [links, setLinks] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [label, setLabel] = useState("");
  const [industry, setIndustry] = useState("");
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<any>(null);

  async function load() {
    try {
      const [lk, cl] = await Promise.all([api.listLinks(), api.listClients()]);
      setLinks(lk); setClients(cl);
    } catch (e: any) { if (/401|token|permission/i.test(e.message)) setAuthed(false); else setErr(e.message); }
  }
  useEffect(() => { if (!getToken()) setAuthed(false); else load(); }, []);

  function fullUrl(path: string) {
    if (typeof window === "undefined" || !path) return path;
    return `${window.location.origin}${path}`;
  }

  async function createLink(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try { await api.createLink({ label, intended_industry: industry, expires_in_days: 14 }); setLabel(""); setIndustry(""); load(); }
    catch (e: any) { setErr(e.message); }
  }
  async function delLink(id: string) {
    if (!confirm("Delete this onboarding link?")) return;
    try { await api.deleteLink(id); load(); } catch (e: any) { setErr(e.message); }
  }
  async function delClient(c: any) {
    if (!confirm(`Delete client "${c.company_name}" and ALL its data? This cannot be undone.`)) return;
    try { await api.deleteClient(c.tenant_id); load(); } catch (e: any) { setErr(e.message); }
  }
  async function saveEdit() {
    try {
      await api.editClient(editing.tenant_id, {
        company_name: editing.company_name, contact_name: editing.contact_name,
        contact_phone: editing.contact_phone, industry: editing.industry,
        address: editing.address, is_active: editing.is_active,
      });
      setEditing(null); load();
    } catch (e: any) { setErr(e.message); }
  }

  if (!authed) return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div><p className="mb-4 text-slate-600">Sign in as an admin to manage clients.</p><a href="/login" className="btn">Sign in</a></div>
    </main>
  );

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-2xl font-bold">Client onboarding & management</h1>
        <p className="mt-1 text-slate-600">Generate a unique link, then the client registers and logs in with their own email/password.</p>
        {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

        <form onSubmit={createLink} className="card mt-6 flex flex-wrap items-end gap-4 p-5">
          <div className="flex-1 min-w-[180px]"><label className="label">Label</label>
            <input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="ACME Plant — Pune" /></div>
          <div className="flex-1 min-w-[160px]"><label className="label">Industry</label>
            <input className="input" value={industry} onChange={e => setIndustry(e.target.value)} placeholder="automotive" /></div>
          <button className="btn">Generate link</button>
        </form>

        <h2 className="mt-8 text-lg font-semibold">Onboarding links</h2>
        <div className="mt-2 space-y-2">
          {links.map(l => (
            <div key={l.id} className="card flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="font-medium">{l.label || "Untitled"}{l.is_used && <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">used</span>}</div>
                <code className="block truncate text-xs text-slate-500">{fullUrl(l.url_path)}</code>
              </div>
              <div className="flex shrink-0 gap-2">
                <button className="btn-ghost text-sm" onClick={() => navigator.clipboard.writeText(fullUrl(l.url_path))}>Copy</button>
                <button className="text-sm text-red-500 hover:underline" onClick={() => delLink(l.id)}>Delete</button>
              </div>
            </div>
          ))}
          {!links.length && <p className="text-slate-500">No links yet.</p>}
        </div>

        <h2 className="mt-10 text-lg font-semibold">Onboarded clients</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500"><th className="py-2">Company</th><th>Login email</th><th>Industry</th><th>Devices</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {clients.map(c => (
                <tr key={c.tenant_id} className="border-t">
                  <td className="py-2 font-medium">{c.company_name}</td>
                  <td><code className="text-xs">{c.admin_email || "—"}</code></td>
                  <td>{c.industry || "—"}</td>
                  <td>{c.devices}</td>
                  <td>{c.is_active ? <span className="text-green-600">active</span> : <span className="text-slate-400">disabled</span>}</td>
                  <td className="text-right">
                    <button className="mr-3 text-sm text-brand-dark hover:underline" onClick={() => setEditing({ ...c })}>Edit</button>
                    <button className="text-sm text-red-500 hover:underline" onClick={() => delClient(c)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!clients.length && <p className="mt-2 text-slate-500">No clients onboarded yet. Generate a link and complete the registration form to create one.</p>}
        </div>
        <p className="mt-3 text-sm text-slate-500">Clients log in at <code>{fullUrl("/login")}</code> with the email and password set during onboarding.</p>
      </main>

      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6" onClick={() => setEditing(null)}>
          <div className="card w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h3 className="mb-4 text-lg font-semibold">Edit client</h3>
            <div className="space-y-3">
              <div><label className="label">Company name</label><input className="input" value={editing.company_name || ""} onChange={e => setEditing({ ...editing, company_name: e.target.value })} /></div>
              <div><label className="label">Contact name</label><input className="input" value={editing.contact_name || ""} onChange={e => setEditing({ ...editing, contact_name: e.target.value })} /></div>
              <div><label className="label">Phone</label><input className="input" value={editing.contact_phone || ""} onChange={e => setEditing({ ...editing, contact_phone: e.target.value })} /></div>
              <div><label className="label">Industry</label><input className="input" value={editing.industry || ""} onChange={e => setEditing({ ...editing, industry: e.target.value })} /></div>
              <div><label className="label">Address</label><input className="input" value={editing.address || ""} onChange={e => setEditing({ ...editing, address: e.target.value })} /></div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!editing.is_active} onChange={e => setEditing({ ...editing, is_active: e.target.checked })} /> Active</label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn" onClick={saveEdit}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
