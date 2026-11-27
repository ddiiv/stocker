/*
 * Manda una lista larga de a pedazos, uno atrás del otro: el proxy corta cada
 * pedido a los 30 segundos. Si un pedazo falla se corta ahí, y el error dice
 * cuáles quedaron sin mandar (`error.sinMandar`, con los del pedazo que falló).
 */
export async function enTandas(lista, tam, mandar, alAvanzar = () => {}) {
  for (let i = 0; i < lista.length; i += tam) {
    let respuesta;
    try {
      respuesta = await mandar(lista.slice(i, i + tam));
    } catch (e) {
      e.sinMandar = lista.slice(i);
      throw e;
    }
    // false = quien llama ya no quiere seguir (cerró la ventana).
    if (alAvanzar(respuesta, Math.min(i + tam, lista.length)) === false) return;
  }
}
