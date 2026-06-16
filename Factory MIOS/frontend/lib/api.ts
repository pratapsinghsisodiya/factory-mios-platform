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
  createLink: (data: any) => req("/onboarding/links", { method: "POST", body: JSON.stringify(data) }),
  listLinks: () => req("/onboarding/links"),
  validateLink: (token: string) => req(`/onboarding/links/${token}`, {}, false),
  submitOnboarding: (token: string, data: any) =>
    req(`/onboarding/links/${token}/submit`, { method: "POST", body: JSON.stringify(data) }, false),
  devices: () => req("/devices"),
  createDevice: (data: any) => req("/devices", { method: "POST", body: JSON.stringify(data) }),
  catalog: () => req("/dashboards/catalog", {}, false),
  dashboards: () => req("/dashboards"),
  getDashboard: (id: string) => req(`/dashboards/${id}`),
  createDashboard: (data: any) => req("/dashboards", { method: "POST", body: JSON.stringify(data) }),
  updateDashboard: (id: string, data: any) => req(`/dashboards/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteDashboard: (id: string) => req(`/dashboards/${id}`, { method: "DELETE" }),
  kpis: () => req("/kpis"),
  createKpi: (data: any) => req("/kpis", { method: "POST", body: JSON.stringify(data) }),
  computeKpi: (id: string, q = "") => req(`/kpis/${id}/compute${q}`),
  shifts: () => req("/shifts"),
  chat: (message: string) => req("/assistant", { method: "POST", body: JSON.stringify({ message }) }),
  reportUrl: (type: string, windowMinutes = 1440) =>
    `${API}/api/v1/reports/${type}.xlsx?window_minutes=${windowMinutes}`,
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
