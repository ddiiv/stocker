import { http } from "../lib/http";

export async function getDashboardMetrics({ rangeDays = 30 } = {}) {
  const { data } = await http.get("/dashboard", { params: { rangeDays } });
  return data;
}
