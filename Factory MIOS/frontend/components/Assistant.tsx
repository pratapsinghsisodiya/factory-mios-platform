"use client";
import { useState } from "react";
import { api } from "../lib/api";

export default function Assistant() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<{ role: string; text: string }[]>([
    { role: "bot", text: "Hi! I'm your Factory MIOS assistant. Ask about onboarding, connecting devices, KPIs, or dashboards." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!input.trim()) return;
    const m = input; setInput("");
    setMsgs(x => [...x, { role: "user", text: m }]); setBusy(true);
    try { const r = await api.chat(m); setMsgs(x => [...x, { role: "bot", text: r.reply }]); }
    catch (e: any) { setMsgs(x => [...x, { role: "bot", text: "Error: " + e.message }]); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button onClick={() => setOpen(!open)} className="btn fixed bottom-6 right-6 z-40 rounded-full shadow-lg">
        {open ? "Close" : "Ask AI"}
      </button>
      {open && (
        <div className="card fixed bottom-20 right-6 z-40 flex h-96 w-80 flex-col p-3">
          <div className="flex-1 space-y-2 overflow-y-auto">
            {msgs.map((m, i) => (
              <div key={i} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "ml-auto bg-brand text-white" : "bg-slate-100"}`}>{m.text}</div>
            ))}
            {busy && <div className="text-xs text-slate-400">thinking…</div>}
          </div>
          <div className="mt-2 flex gap-2">
            <input className="input" value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && send()} placeholder="Type a question…" />
            <button className="btn" onClick={send} disabled={busy}>Send</button>
          </div>
        </div>
      )}
    </>
  );
}
