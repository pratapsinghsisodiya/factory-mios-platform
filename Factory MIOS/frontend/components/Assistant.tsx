"use client";
import { useState } from "react";
import { api } from "../lib/api";

const SUGGESTIONS = [
  "What is today's OEE?",
  "Total production today",
  "Last 7 days rejection",
  "Top downtime reasons this week",
  "Average cycle time today",
];

export default function Assistant() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<{ role: string; text: string }[]>([
    { role: "bot", text: "Hi, I'm Facto Bot. Ask me about OEE, production, rejection, downtime, cycle time, or energy — answered from your factory data." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(q?: string) {
    const m = (q ?? input).trim();
    if (!m) return;
    setInput("");
    setMsgs(x => [...x, { role: "user", text: m }]); setBusy(true);
    try { const r = await api.factobot(m); setMsgs(x => [...x, { role: "bot", text: r.reply }]); }
    catch (e: any) { setMsgs(x => [...x, { role: "bot", text: "Error: " + e.message }]); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button onClick={() => setOpen(!open)} className="btn fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full shadow-lg">
        {open ? "Close" : (<><img src="/assets/facto-bot-logo.png" alt="" className="h-5 w-5 rounded-full object-cover" /> Facto Bot</>)}
      </button>
      {open && (
        <div className="card fixed bottom-20 right-6 z-40 flex h-[28rem] w-96 flex-col p-3">
          <div className="mb-2 flex items-center gap-2 border-b pb-2"><img src="/assets/facto-bot-logo.png" alt="" className="h-6 rounded" /><span className="text-sm font-semibold">Facto Bot</span></div>
          <div className="flex-1 space-y-2 overflow-y-auto">
            {msgs.map((m, i) => (
              <div key={i} className={`max-w-[88%] rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "ml-auto bg-brand text-white" : "bg-slate-100"}`}>{m.text}</div>
            ))}
            {busy && <div className="text-xs text-slate-400">thinking…</div>}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {SUGGESTIONS.map(s => (
              <button key={s} onClick={() => send(s)} className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50">{s}</button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input className="input" value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && send()} placeholder="Ask Facto Bot…" />
            <button className="btn" onClick={() => send()} disabled={busy}>Send</button>
          </div>
        </div>
      )}
    </>
  );
}
