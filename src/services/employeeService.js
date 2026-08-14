import { http } from "../lib/http";

export async function fetchEmployees() {
  const { data } = await http.get("/employees");
  return data;
}

export async function fetchPos() {
  const { data } = await http.get("/locations");
  return data;
}

export async function fetchRoles() {
  const { data } = await http.get("/roles");
  return data;
}

export async function createEmployee(payload) {
  const { data } = await http.post("/employees", payload);
  return data;
}

export async function updateEmployee(id, payload) {
  const { data } = await http.put(`/employees/${id}`, payload);
  return data;
}

export async function toggleEmployeeActive(id) {
  const { data } = await http.patch(`/employees/${id}/toggle`);
  return data;
}

export async function deleteEmployee(id) {
  await http.delete(`/employees/${id}`);
}

export async function fetchEmployeeSessions(id) {
  const { data } = await http.get(`/employees/${id}/sessions`);
  return data;
}

export async function createLocation(payload) {
  const { data } = await http.post("/locations", payload);
  return data;
}

export async function updateRole(id, payload) {
  const { data } = await http.put(`/roles/${id}`, payload);
  return data;
}
export async function deleteRole(id) {
  await http.delete(`/roles/${id}`);
}
export async function createRole(payload) {
  const { data } = await http.post("/roles", payload);
  return data;
}

export async function fetchClients(search) {
  const params = search ? { search } : {};
  const { data } = await http.get("/clients", { params });
  return data;
}

export async function createClient(payload) {
  const { data } = await http.post("/clients", payload);
  return data;
}
