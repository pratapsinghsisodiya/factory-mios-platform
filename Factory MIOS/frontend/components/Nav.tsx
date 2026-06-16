"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clearToken } from "../lib/api";

const items = [
  ["/dashboard", "Dashboards"], ["/builder", "Builder"], ["/kpi-builder", "KPI Builder"], ["/clients", "Onboarding"],
];

export default function Nav() {
  const path = usePathname();
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" className="font-bold">Factory MIOS</Link>
        <nav className="flex items-center gap-2">
          {items.map(([href, label]) => (
            <Link key={href} href={href}
              className={`rounded-lg px-3 py-1.5 text-sm ${path === href ? "bg-brand/10 text-brand-dark" : "text-slate-600 hover:bg-slate-100"}`}>
              {label}
            </Link>
          ))}
          <button className="btn-ghost text-sm" onClick={() => { clearToken(); location.href = "/login"; }}>Sign out</button>
        </nav>
      </div>
    </header>
  );
}
