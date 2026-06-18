"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clearToken } from "../lib/api";

const items: [string, string][] = [
  ["/dashboard", "Dashboards"],
  ["/builder", "Builder"],
  ["/kpi-builder", "KPI"],
  ["/assets", "Assets"],
  ["/downtime", "Downtime"],
  ["/quality", "Quality"],
  ["/analytics", "Analytics"],
  ["/views", "Role Views"],
  ["/clients", "Onboarding"],
];

export default function Nav() {
  const path = usePathname();
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-6 py-3">
        <Link href="/" className="font-bold">Factory MIOS</Link>
        <nav className="flex flex-wrap items-center gap-1">
          {items.map(([href, label]) => (
            <Link key={href} href={href}
              className={`rounded-lg px-3 py-1.5 text-sm ${path === href ? "bg-brand/10 text-brand-dark" : "text-slate-600 hover:bg-slate-100"}`}>
              {label}
            </Link>
          ))}
          <Link href="/bigscreen" className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">Big Screen</Link>
          <button className="btn-ghost text-sm" onClick={() => { clearToken(); location.href = "/login"; }}>Sign out</button>
        </nav>
      </div>
    </header>
  );
}
