"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, setToken } from "../../../lib/api";

export default function Onboard() {
  const { linkId } = useParams<{ linkId: string }>();
  const router = useRouter();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    company_name: "", contact_name: "", contact_email: "", contact_phone: "",
    industry: "", address: "", admin_password: "",
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.validateLink(linkId)
      .then(d => { setInfo(d); setState("ok"); if (d.intended_industry) setForm(f => ({ ...f, industry: d.intended_industry })); })
      .catch(e => { setErr(e.message); setState("error"); });
  }, [linkId]);

  function up(k: string, v: string) { setForm({ ...form, [k]: v }); }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      const t = await api.submitOnboarding(linkId, { ...form, extra: {} });
      setToken(t.access_token);
      router.push("/dashboard");
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (state === "loading") return <Center>Checking your invitation…</Center>;
  if (state === "error") return <Center><span className="text-red-600">{err}</span></Center>;

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-bold">Welcome to Factory MIOS</h1>
      <p className="mt-2 text-slate-600">
        {info?.label ? `Invitation: ${info.label}. ` : ""}Set up your workspace below.
      </p>
      <form onSubmit={submit} className="card mt-8 space-y-4 p-6">
        <Field label="Company name" v={form.company_name} on={(v) => up("company_name", v)} required />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact name" v={form.contact_name} on={(v) => up("contact_name", v)} required />
          <Field label="Contact email" type="email" v={form.contact_email} on={(v) => up("contact_email", v)} required />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone" v={form.contact_phone} on={(v) => up("contact_phone", v)} />
          <Field label="Industry" v={form.industry} on={(v) => up("industry", v)} />
        </div>
        <Field label="Address" v={form.address} on={(v) => up("address", v)} />
        <Field label="Choose an admin password" type="password" v={form.admin_password} on={(v) => up("admin_password", v)} required />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button className="btn w-full" disabled={busy}>{busy ? "Creating workspace…" : "Create my workspace"}</button>
      </form>
    </main>
  );
}

function Field({ label, v, on, type = "text", required = false }:
  { label: string; v: string; on: (v: string) => void; type?: string; required?: boolean }) {
  return (
    <div>
      <label className="label">{label}{required && <span className="text-red-500"> *</span>}</label>
      <input className="input" type={type} value={v} required={required} onChange={e => on(e.target.value)} />
    </div>
  );
}
function Center({ children }: { children: React.ReactNode }) {
  return <main className="grid min-h-screen place-items-center px-6 text-slate-600">{children}</main>;
}
