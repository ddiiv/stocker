import { z } from "zod";

/*
 * Zod, ya configurado para convivir con la Política de Seguridad de Contenido.
 *
 * Zod compila los validadores con `new Function` para que corran más rápido, y
 * antes de hacerlo prueba si puede: ejecuta un `Function("")` dentro de un
 * try/catch. Con una CSP sin 'unsafe-eval' esa prueba falla —que es lo que
 * queremos— y Zod se cae solo al camino interpretado, así que la validación
 * funciona igual. Pero el navegador igual REPORTA la violación: queda un error
 * rojo en la consola de todos los clientes, y si algún día se configura un
 * report-uri, va a llegar como incidente de seguridad algo que es normal.
 *
 * `jitless: true` le dice a Zod que ni intente la prueba. Es exactamente para
 * esto: su propio código lo comenta así en `util.js` (`allowsEval`). No se
 * pierde nada, porque bajo esta CSP el JIT nunca estuvo disponible.
 *
 * Se exporta `z` desde acá —en vez de llamar a `config()` en el arranque— para
 * que no dependa del orden de los imports. `allowsEval` se consulta al CONSTRUIR
 * cada schema, no al validar, y los schemas se construyen en el cuerpo de cada
 * módulo: si la configuración viviera en `main.jsx`, cualquier `z.object()` de
 * un módulo importado antes ya habría corrido la prueba. Importando `z` de acá
 * es imposible tener el schema sin la configuración.
 */
z.config({ jitless: true });

export { z };
