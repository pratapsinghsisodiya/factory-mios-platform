import Link from "next/link";

const features = [
  ["Client onboarding links", "Generate a unique, expiring link. The client fills a registration form; a tenant + admin account are created automatically and stored securely in the database."],
  ["Device & GPS registration", "Register each machine or gateway with its location and choose how it connects: MQTT, HTTPS push, or CSV/Excel upload."],
  ["Universal ingestion", "Telemetry flows in over MQTT, HTTPS, or file upload and lands in a TimescaleDB time-series store, ready to query."],
  ["No-code KPI builder", "Wire parameters, master data, shift context and constants together with a math operator — like connecting wires — to compute any KPI."],
  ["Master data mapping", "Import part catalogs and reference tables, then map fields (e.g. target cycle time) to the latest telemetry by part."],
  ["Shift planning", "Define shifts, targets, and cycle times so totalizers and aggregates are evaluated in the right time context."],
  ["Dashboard templates", "Start from OEE, Downtime, Quality, Performance, Real-Time, EMS or WMS templates and drop in widgets."],
  ["AI assistant", "An in-app assistant helps onboard devices, write KPI formulas, and design dashboards."],
];

const useCases = [
  ["Automotive & CNC", "Track OEE per machine, cycle-time deviation, and scrap rate across press lines and machining cells."],
  ["Plastics & Packaging", "Monitor injection-molding shot counts, downtime Pareto, and changeover losses in real time."],
  ["Food, Pharma & Textile", "Combine quality SPC, batch genealogy, and energy use for compliance-grade reporting."],
  ["Energy & Warehouse", "Run EMS energy tiles and WMS stock dashboards alongside production KPIs from one platform."],
];

export default function Home() {
  return (
    <main>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2 font-bold text-lg">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-white">M</span>
            Factory MIOS
          </div>
          <nav className="flex items-center gap-3">
            <a href="#features" className="text-sm text-slate-600 hover:text-ink">Features</a>
            <a href="#use-cases" className="text-sm text-slate-600 hover:text-ink">Use cases</a>
            <Link href="/login" className="btn-ghost text-sm">Sign in</Link>
            <Link href="/clients" className="btn text-sm">Onboard a client</Link>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-20 text-center">
        <p className="mb-3 inline-block rounded-full bg-brand/10 px-3 py-1 text-sm font-medium text-brand-dark">
          Manufacturing Intelligence Operating System
        </p>
        <h1 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight sm:text-5xl">
          Turn machine data into OEE, quality, and downtime intelligence — in one secure platform.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
          Onboard a client, connect any machine over MQTT, HTTPS or CSV, build KPIs with a no-code
          formula engine, and assemble dashboards from a multi-industry widget catalog. Runs on
          your own server or the cloud — fully containerized.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/clients" className="btn">Create an onboarding link</Link>
          <Link href="/dashboard" className="btn-ghost">View a demo dashboard</Link>
        </div>
      </section>

      <section id="features" className="bg-white py-16">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-bold">What the platform does</h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {features.map(([t, d]) => (
              <div key={t} className="card p-5">
                <h3 className="font-semibold">{t}</h3>
                <p className="mt-2 text-sm text-slate-600">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="use-cases" className="py-16">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-bold">Built for any plant</h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {useCases.map(([t, d]) => (
              <div key={t} className="card p-6">
                <h3 className="text-lg font-semibold">{t}</h3>
                <p className="mt-2 text-slate-600">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-ink py-16 text-white">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-3xl font-bold">How onboarding works</h2>
          <ol className="mt-8 space-y-3 text-left text-slate-200">
            <li>1. An admin generates a unique onboarding link with an optional expiry.</li>
            <li>2. The client opens the link and submits a registration form — stored in the database, creating their workspace.</li>
            <li>3. They register devices with GPS and pick a connection method (MQTT / HTTPS / CSV).</li>
            <li>4. Data streams in; they build KPIs and dashboards from the widget catalog.</li>
          </ol>
          <Link href="/clients" className="btn mt-8 inline-block">Get started</Link>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-white py-8 text-center text-sm text-slate-500">
        Factory MIOS · Self-hostable, container-based SaaS · © 2026
      </footer>
    </main>
  );
}
