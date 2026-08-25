/*
 * Validación de CUIT/CUIL y email.
 *
 * El CUIT importa más de lo que parece: es el dato con el que se emite la
 * factura electrónica. Un CUIT mal cargado no se nota al guardarlo —se nota
 * cuando ARCA rechaza el comprobante, con el cliente esperando el ticket—, así
 * que conviene frenarlo en la carga y no en la caja.
 */

/*
 * Dígito verificador por módulo 11, que es lo que hace que un CUIT sea
 * verificable sin consultar a nadie. Sin esto, "20123456789" pasa por válido
 * por tener once dígitos y no serlo.
 */
const PESOS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Deja sólo los dígitos: se carga con guiones, con puntos o pegado. */
const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');

function cuitValido(valor) {
  const d = soloDigitos(valor);
  if (d.length !== 11) return false;
  // Todos iguales (00000000000, 11111111111) pasan el módulo 11 y no existen.
  if (/^(\d)\1{10}$/.test(d)) return false;

  const suma = PESOS.reduce((acc, peso, i) => acc + peso * Number(d[i]), 0);
  const resto = suma % 11;
  const esperado = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
  return Number(d[10]) === esperado;
}

/** Normaliza a los once dígitos pelados, que es como lo espera ARCA. */
const normalizarCuit = (valor) => {
  const d = soloDigitos(valor);
  return d.length === 11 ? d : null;
};

/*
 * Email: se comprueba la forma, no la existencia.
 *
 * Alcanza para atajar el error de tipeo —"juan@gmail" sin el .com, un espacio
 * en el medio—, que es el que hace que el comprobante no llegue y nadie se
 * entere hasta que el cliente reclama.
 */
const RE_EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const emailValido = (valor) => RE_EMAIL.test(String(valor ?? '').trim());

module.exports = { cuitValido, normalizarCuit, emailValido, soloDigitos };
