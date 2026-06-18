export const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const V1 = `${API}/api/v1`;

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("mios_token");
}
export function setToken(t: string) { window.localStorage.setItem("mios_token", t); }
export function clearToken() { window.localStorage.removeItem("mios_token"); }

async function req(path: string, opts: RequestInit = {}, auth = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as any) };
  if (auth) { const t = getToken(); if (t) headers["Authorization"] = `Bearer ${t}`; }
  const res = await fetch(`${V1}${path}`, { ...opts, headers });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  login: async (email: string, password: string) => {
    const body = new URLSearchParams({ username: email, password });
    const res = await fetch(`${V1}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Login failed");
    return res.json();
  },
  me: () => req("/auth/me"),

  // onboarding
  createLink: (data: any) => req("/onboarding/links", { method: "POST", body: JSON.stringify(data) }),
  listLinks: () => req("/onboarding/links"),
  validateLink: (token: string) => req(`/onboarding/links/${token}`, {}, false),
  submitOnboarding: (token: string, data: any) =>
    req(`/onboarding/links/${token}/submit`, { method: "POST", body: JSON.stringify(data) }, false),

  // devices + hierarchy
  devices: () => req("/devices"),
  createDevice: (data: any) => req("/devices", { method: "POST", body: JSON.stringify(data) }),
  tree: () => req("/hierarchy/tree"),
  addNode: (kind: string, data: any) => req(`/hierarchy/${kind}`, { method: "POST", body: JSON.stringify(data) }),

  // telemetry mapping
  telemetryDefs: (deviceId?: string) => req(`/telemetry-map${deviceId ? `?device_id=${deviceId}` : ""}`),
  saveTelemetryDef: (data: any) => req("/telemetry-map", { method: "POST", body: JSON.stringify(data) }),
  liveTest: (deviceId: string) => req(`/telemetry-map/live-test/${deviceId}`),

  // dashboards
  catalog: () => req("/dashboards/catalog", {}, false),
  dashboards: () => req("/dashboards"),
  getDashboard: (id: string) => req(`/dashboards/${id}`),
  createDashboard: (data: any) => req("/dashboards", { method: "POST", body: JSON.stringify(data) }),
  updateDashboard: (id: string, data: any) => req(`/dashboards/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteDashboard: (id: string) => req(`/dashboards/${id}`, { method: "DELETE" }),

  // kpis
  kpis: () => req("/kpis"),
  createKpi: (data: any) => req("/kpis", { method: "POST", body: JSON.stringify(data) }),
  computeKpi: (id: string, q = "") => req(`/kpis/${id}/compute${q}`),
  shifts: () => req("/shifts"),

  // master data
  masterData: (dataset?: string) => req(`/master-data${dataset ? `?dataset=${dataset}` : ""}`),
  upsertMaster: (data: any) => req("/master-data", { method: "POST", body: JSON.stringify(data) }),

  // logging
  createDowntime: (data: any) => req("/logs/downtime", { method: "POST", body: JSON.stringify(data) }),
  closeDowntime: (id: string, reason?: string) =>
    req(`/logs/downtime/${id}/close${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`, { method: "PATCH" }),
  downtimeLogs: (days = 7) => req(`/logs/downtime?days=${days}`),
  downtimePareto: (days = 7) => req(`/logs/downtime/pareto?days=${days}`),
  createQuality: (data: any) => req("/logs/quality", { method: "POST", body: JSON.stringify(data) }),
  qualityLogs: (days = 7) => req(`/logs/quality?days=${days}`),
  qualitySummary: (days = 7) => req(`/logs/quality/summary?days=${days}`),

  // analytics
  analyticsParams: () => req("/analytics/parameters"),
  aggregate: (data: any) => req("/analytics/aggregate", { method: "POST", body: JSON.stringify(data) }),
  trend: (data: any) => req("/analytics/trend", { method: "POST", body: JSON.stringify(data) }),

  // facto bot
  factobot: (question: string) => req("/factobot", { method: "POST", body: JSON.stringify({ question }) }),

  // reports
  downloadReport: async (type: string, windowMinutes = 1440) => {
    const res = await fetch(`${V1}/reports/${type}.xlsx?window_minutes=${windowMinutes}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error("Report export failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `mios-${type}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  },
};
