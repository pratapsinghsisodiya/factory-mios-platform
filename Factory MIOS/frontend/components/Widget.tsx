"use client";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";

export default function Widget({ type, title, value, unit }:
  { type: string; title: string; value?: number | null; unit?: string }) {
  return (
    <div className="card p-4">
      <div className="mb-2 text-sm font-semibold text-slate-700">{title}</div>
      <div className="h-40">{render(type, value, unit)}</div>
    </div>
  );
}

function render(type: string, value?: number | null, unit?: string) {
  const live = value !== undefined && value !== null && !Number.isNaN(value);
  const display = live ? `${Math.round((value as number) * 10) / 10}${unit || ""}` : null;

  if (!live) {
    // No bound data → honest empty state, never fake numbers.
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <div className="text-2xl font-bold text-slate-300">—</div>
          <div className="text-xs text-slate-400">no data — bind a KPI or parameter</div>
        </div>
      </div>
    );
  }

  switch (type) {
    case "oee_donut": {
      const v = Math.max(0, Math.min(100, value as number));
      const data = [{ name: "v", value: v }, { name: "rest", value: 100 - v }];
      return (
        <div className="relative h-full">
          <ResponsiveContainer>
            <PieChart>
              <Pie data={data} innerRadius={45} outerRadius={65} dataKey="value" startAngle={90} endAngle={-270}>
                {data.map((_, i) => <Cell key={i} fill={i === 0 ? "#0ea5e9" : "#e2e8f0"} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-lg font-bold text-brand-dark">{display}</div>
        </div>
      );
    }
    case "status_grid":
      return <div className="grid h-full place-items-center text-3xl font-bold text-brand-dark">{display}</div>;
    default:
      return (
        <div className="flex h-full flex-col items-center justify-center">
          <div className="text-4xl font-bold text-brand-dark">{display}</div>
          <div className="text-xs text-slate-500">live</div>
        </div>
      );
  }
}
