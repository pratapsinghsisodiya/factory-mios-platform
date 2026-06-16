"use client";
import { PieChart, Pie, Cell, LineChart, Line, BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";

const demoTrend = Array.from({ length: 12 }, (_, i) => ({ x: `${i + 1}`, v: 60 + Math.round(Math.sin(i) * 15 + Math.random() * 10) }));
const COLORS = ["#0ea5e9", "#22c55e", "#f59e0b", "#ef4444"];

export default function Widget({ type, title }: { type: string; title: string }) {
  return (
    <div className="card p-4">
      <div className="mb-2 text-sm font-semibold text-slate-700">{title}</div>
      <div className="h-40">{render(type)}</div>
    </div>
  );
}

function render(type: string) {
  switch (type) {
    case "oee_donut": {
      const data = [{ name: "OEE", value: 72 }, { name: "Loss", value: 28 }];
      return (
        <ResponsiveContainer>
          <PieChart>
            <Pie data={data} innerRadius={45} outerRadius={65} dataKey="value" startAngle={90} endAngle={-270}>
              {data.map((_, i) => <Cell key={i} fill={i === 0 ? "#0ea5e9" : "#e2e8f0"} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      );
    }
    case "line": case "energy":
      return (<ResponsiveContainer><LineChart data={demoTrend}><XAxis dataKey="x" hide /><YAxis hide /><Tooltip /><Line dataKey="v" stroke="#0ea5e9" dot={false} strokeWidth={2} /></LineChart></ResponsiveContainer>);
    case "bar": case "pareto": case "inventory":
      return (<ResponsiveContainer><BarChart data={demoTrend}><XAxis dataKey="x" hide /><YAxis hide /><Tooltip /><Bar dataKey="v" fill="#0ea5e9" /></BarChart></ResponsiveContainer>);
    case "gauge": case "stat":
      return (<div className="flex h-full flex-col items-center justify-center"><div className="text-4xl font-bold text-brand-dark">72%</div><div className="text-xs text-slate-500">live value</div></div>);
    case "status_grid":
      return (<div className="grid h-full grid-cols-4 gap-2">{Array.from({ length: 12 }).map((_, i) => <div key={i} className={`rounded ${[2, 5, 9].includes(i) ? "bg-red-400" : "bg-green-400"}`} />)}</div>);
    case "map":
      return (<div className="grid h-full place-items-center rounded bg-slate-100 text-sm text-slate-500">📍 Device GPS map</div>);
    case "spc": case "waterfall": case "heatmap": case "table": default:
      return (<div className="grid h-full place-items-center rounded bg-slate-50 text-sm text-slate-400">{type} widget</div>);
  }
}
