import { http } from "../lib/http";

/*
 * Jumpseller. La clave de la tienda se manda una vez al conectar y no vuelve
 * a salir del servidor: el estado sólo dice si está conectada.
 */
export async function getJumpsellerStatus() {
  const { data } = await http.get("/jumpseller/status");
  return data;
}

export async function conectarJumpseller(payload) {
  const { data } = await http.post("/jumpseller/conectar", payload);
  return data;
}

export async function desconectarJumpseller() {
  const { data } = await http.delete("/jumpseller/conectar");
  return data;
}

export async function previewJumpseller() {
  const { data } = await http.get("/jumpseller/preview");
  return data;
}

export async function syncJumpseller(skus) {
  const { data } = await http.post("/jumpseller/sync", { skus });
  return data;
}
