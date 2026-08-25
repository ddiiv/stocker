import { http } from "../lib/http";

export async function fetchEmployees() {
  const { data } = await http.get("/employees");
  return data;
}

export async function fetchPos() {
  const { data } = await http.get("/locations");
  return data;
}

/*
 * Sólo los locales donde se vende.
 *
 * El punto de venta y el alta de ventas ofrecen elegir de dónde sale la
 * mercadería, y desde un depósito no se vende: mostrarlo en el desplegable
 * termina en un rechazo del servidor con el cliente esperando en la caja.
 *
 * El resto de las pantallas —movimientos, etiquetas, carga de stock— sí los
 * necesita: ahí el depósito es un lugar más donde hay mercadería.
 */
export async function fetchLocalesDeVenta() {
  const locs = await fetchPos();
  return (locs || []).filter((l) => l.tipo !== "deposito");
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

/*
 * Cambia datos de un local, incluido su tipo.
 *
 * Convertir un local con mercadería en depósito devuelve 409 con
 * `codigo: 'LOCAL_CON_STOCK'`: desde un depósito no se vende, así que hay que
 * confirmarlo a sabiendas y no descubrirlo con un cliente adelante.
 */
export async function updateLocation(id, payload) {
  const { data } = await http.put(`/locations/${id}`, payload);
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

/*
 * Levanta el bloqueo por intentos fallidos de un empleado.
 *
 * Devuelve un mensaje del servidor y no un simple ok: puede pasar que el
 * bloqueo siga en pie por la cantidad de intentos desde esa red, y quien
 * aprieta el botón tiene que enterarse ahí y no por su empleada.
 */
export async function desbloquearEmpleado(id) {
  const { data } = await http.post(`/employees/${id}/desbloquear`);
  return data;
}
