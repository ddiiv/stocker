import { http } from "../lib/http";

/** Turno abierto del empleado, con el desglose de lo que debería haber en caja. */
export async function fetchTurnoActual() {
  const { data } = await http.get("/cash/turno-actual");
  return data;
}

export async function abrirTurno({ montoInicial }) {
  const { data } = await http.post("/cash/abrir", { montoInicial });
  return data;
}

export async function cerrarTurno({ montoDeclarado, notaCierre }) {
  const { data } = await http.post("/cash/cerrar", { montoDeclarado, notaCierre });
  return data;
}

/** tipo: ingreso | egreso | retiro. En los retiros la nota es opcional. */
export async function registrarMovimiento(payload) {
  const { data } = await http.post("/cash/movimientos", payload);
  return data;
}

export async function fetchTurnos(params = {}) {
  const { data } = await http.get("/cash/turnos", { params });
  return data;
}

export async function fetchTurno(id) {
  const { data } = await http.get(`/cash/turnos/${id}`);
  return data;
}

/** Total de efectivo retirado y el detalle de cada retiro. */
export async function fetchRetiros(params = {}) {
  const { data } = await http.get("/cash/retiros", { params });
  return data;
}
