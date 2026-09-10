/*
 * Cambiar la contraseña cierra las sesiones abiertas.
 *
 * Sin esto, cambiar la contraseña porque sospechás que alguien entró no echa a
 * nadie: las sesiones son un JWT firmado y quien tenga la cookie sigue
 * trabajando hasta el tope absoluto de 24 h. Es la peor combinación posible,
 * porque la persona cree que cerró la puerta.
 *
 * Lo que se comprueba acá:
 *
 *   · Las sesiones abiertas en OTRAS computadoras se caen.
 *   · La del que está cambiando la contraseña NO: seguir adentro es lo que
 *     hace que la pantalla no parezca rota.
 *   · El "olvidé mi contraseña" cierra todo, sin excepción.
 *   · Cambiarle la contraseña a un empleado cierra las de ESE empleado, y no
 *     toca ni al dueño ni a los demás.
 *   · Con `sesionesDesde` en nulo —todas las cuentas hasta que alguien cambie
 *     la suya— no se cierra nada: el deploy no desloguea a nadie.
 *   · La ventana deslizante no resucita una sesión cerrada. Es el punto fino:
 *     el token se re-firma en cada pedido, así que el corte no puede mirar el
 *     `iat` del JWT.
 *
 * Corre sobre un negocio propio y descartable: si se cayera a la mitad
 * dejando una contraseña cambiada, se llevaría puestas las otras suites, que
 * entran todas con la cuenta demo.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-sesiones.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const API = process.env.API || 'http://localhost:3000';
const {
  Business, Employee, Role, AccountChangeCode, PasswordResetCode, Subscription, AuthAttempt,
} = require('../src/models');
const { iniciarTrial } = require('../src/services/planService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function sesion() {
  let cookie = '';
  return async (metodo, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* sin json */ }
    return { status: r.status, json };
  };
}

const CUIT   = '20999888771';
/*
 * Email distinto en cada corrida.
 *
 * Los limitadores de login y de recupero se llavean por IP + email, y esta
 * suite abre media docena de sesiones y pide dos códigos. Con un email fijo,
 * la segunda corrida dentro de la ventana de 15 minutos se topa con el
 * limitador y la suite se saltea justo los bloques que más importan. Con uno
 * nuevo por corrida, arranca siempre con la cuota entera.
 */
const SUFIJO = `${process.pid}${Date.now().toString(36)}`;
const EMAIL  = `qa.sesiones.${SUFIJO}@stocker.test`;
const CLAVE  = 'QaSesiones2026!';
const CLAVE2 = 'QaSesiones2026!nueva';
const EMP_EMAIL = `qa.sesiones.emp.${SUFIJO}@stocker.test`;
const EMP_CLAVE = 'QaEmpleado2026!';
// La sección 8 se la cambia; la 10 necesita entrar con la que quedó.
const EMP_NUEVA = 'QaEmpleado2026!otra';

async function limpiar() {
  /*
   * Los intentos fallidos también.
   *
   * El bloque 6 falla un login A PROPÓSITO —comprobar que la contraseña vieja
   * dejó de servir—, y eso queda anotado en la tabla de intentos, que es lo
   * que alimenta el bloqueo por fuerza bruta. Sin borrarlos, la suite se
   * bloquea a sí misma a partir de la quinta corrida y las fallas que aparecen
   * no tienen nada que ver con lo que se está probando.
   */
  await AuthAttempt.destroy({
    where: { identificador: { [Op.like]: 'qa.sesiones.%@stocker.test' } },
  }).catch(() => {});

  // Se barre por patrón, no sólo por el email de ESTA corrida: si una anterior
  // se cayó a la mitad, su negocio quedó ocupando el CUIT, que sí es fijo.
  const restos = await Business.findAll({
    where: { [Op.or]: [{ email: { [Op.like]: 'qa.sesiones.%@stocker.test' } }, { cuit: CUIT }] },
  });
  for (const b of restos) {
    await AccountChangeCode.destroy({ where: { businessId: b.id } }).catch(() => {});
    await PasswordResetCode.destroy({ where: { businessId: b.id } }).catch(() => {});
    await Employee.destroy({ where: { businessId: b.id } });
    await Role.destroy({ where: { businessId: b.id } });
    await Subscription.destroy({ where: { businessId: b.id } });
    await b.destroy();
  }
}

(async () => {
  await limpiar();

  const negocio = await Business.create({
    nombreNegocio: 'QA Sesiones', ownerNombre: 'QA', ownerApellido: 'Sesiones',
    cuit: CUIT, email: EMAIL, passwordHash: await bcrypt.hash(CLAVE, 10),
  });
  await iniciarTrial(negocio.id);

  const cargo = await Role.create({ businessId: negocio.id, nombre: 'QA Cargo', permisos: { clientes: 'ver' } });
  const empleado = await Employee.create({
    businessId: negocio.id, roleId: cargo.id, dni: '39888777',
    nombre: 'QA', apellido: 'Empleado', email: EMP_EMAIL,
    passwordHash: await bcrypt.hash(EMP_CLAVE, 10), activo: true,
  });

  // El código de confirmación viaja por mail; acá se lee de la base.
  const codigoVigente = async (tipo) => {
    const r = await AccountChangeCode.findOne({
      where: { businessId: negocio.id, tipo, usedAt: null },
      order: [['id', 'DESC']],
    });
    return r?.code || r?.codigo || null;
  };

  try {
    tit('1. DOS COMPUTADORAS, DOS SESIONES');
    const compuA = sesion(), compuB = sesion();
    const primera = await compuA('POST', '/api/auth/login', { email: EMAIL, password: CLAVE });
    /*
     * Esta suite abre media docena de sesiones, así que corriéndola dos veces
     * seguidas se topa con el limitador de peticiones. Se avisa y se corta: si
     * no, salen veinte fallas que no son fallas y esconden a las de verdad.
     */
    if (primera.status === 429) {
      console.log('\n\x1b[31m✖ El limitador de peticiones está frenando los logins.\x1b[0m');
      console.log('  Esperá un minuto y volvé a correr esta prueba.');
      await limpiar();
      process.exit(1);
    }
    chk('entra en A', 200, primera.status);
    chk('entra en B', 200, (await compuB('POST', '/api/auth/login', { email: EMAIL, password: CLAVE })).status);
    chk('A trabaja', 200, (await compuA('GET', '/api/auth/me')).status);
    chk('B trabaja', 200, (await compuB('GET', '/api/auth/me')).status);

    tit('2. CON sesionesDesde EN NULO NO SE CIERRA NADA');
    // Es el estado de todas las cuentas hasta que alguien cambie su contraseña:
    // el deploy de esto no puede desloguear a nadie.
    await negocio.reload();
    chk('la cuenta arranca sin corte', null, negocio.sesionesDesde);
    chk('y las dos siguen adentro', [200, 200],
      [(await compuA('GET', '/api/auth/me')).status, (await compuB('GET', '/api/auth/me')).status]);

    tit('3. CAMBIO LA CONTRASEÑA DESDE A');
    const pedido = await compuA('POST', '/api/account/password/solicitar', { passwordActual: CLAVE });
    /*
     * El limitador del recupero es de 5 pedidos cada 15 minutos, así que esta
     * suite entra dos o tres veces por ventana. Cuando se agota se saltean los
     * bloques que dependen del cambio de contraseña —3 a 6 y 9— y se corren
     * igual los del empleado, que no lo necesitan. Saltear TODO por esto
     * dejaría sin cubrir la mitad que sí se puede probar.
     */
    const limitado = pedido.status === 429;
    // Se declara afuera del bloque: la sección 8 la usa aunque 3-6 se salteen.
    const compuC = sesion();
    if (limitado) {
      console.log('  (el limitador de recupero está agotado: se saltean los bloques 3 a 6 y el 9)');
      console.log('  Se reintenta solo en la próxima ventana de 15 minutos.');
    }
    if (!limitado) {
    chk('pide el código al mail', 200, pedido.status);
    const code = await codigoVigente('password');
    chk('el código existe', true, Boolean(code));

    const cambio = await compuA('POST', '/api/account/password/confirmar', { code, passwordNueva: CLAVE2 });
    chk('el cambio entra', 200, cambio.status);
    chk('y avisa que cerró las otras', true, /otros dispositivos/i.test(cambio.json?.message || ''));

    tit('4. B QUEDA AFUERA, A SIGUE ADENTRO');
    const enB = await compuB('GET', '/api/auth/me');
    chk('B ya no entra',            401,             enB.status);
    chk('y le dice por qué',        'SESION_CERRADA', enB.json?.codigo);
    chk('A no fue echada',          200,             (await compuA('GET', '/api/auth/me')).status);

    tit('5. LA VENTANA DESLIZANTE NO RESUCITA A B');
    /*
     * El token se re-firma en cada pedido, así que el `iat` de una sesión que
     * se sigue usando es siempre nuevo. Si el corte mirara el `iat`, B volvería
     * a entrar sola en el segundo intento — que es exactamente lo que haría el
     * token robado.
     */
    chk('sigue afuera al reintentar', 401, (await compuB('GET', '/api/auth/me')).status);
    chk('y al tercer intento también', 401, (await compuB('GET', '/api/auth/me')).status);

    tit('6. LA CONTRASEÑA VIEJA YA NO SIRVE Y LA NUEVA SÍ');
    chk('con la vieja no entra', 401, (await compuC('POST', '/api/auth/login', { email: EMAIL, password: CLAVE })).status);
    chk('con la nueva sí',       200, (await compuC('POST', '/api/auth/login', { email: EMAIL, password: CLAVE2 })).status);

    }
    if (limitado) {
      // Sin el cambio de contraseña, la que vale sigue siendo la original.
      chk('el dueño entra igual, para las secciones que sí se pueden probar', 200,
        (await compuC('POST', '/api/auth/login', { email: EMAIL, password: CLAVE })).status);
    }

    tit('7. EL EMPLEADO NO SE VE AFECTADO POR EL CAMBIO DEL DUEÑO');
    /*
     * El empleado entra con SU contraseña, que nadie tocó. Echarlo del
     * mostrador porque el dueño cambió la suya sería cortar ventas por algo
     * que no lo involucra.
     */
    const emp1 = sesion(), emp2 = sesion();
    chk('el empleado entra en una compu', 200,
      (await emp1('POST', '/api/auth/employee-login', { email: EMP_EMAIL, password: EMP_CLAVE })).status);
    chk('y en otra',                      200,
      (await emp2('POST', '/api/auth/employee-login', { email: EMP_EMAIL, password: EMP_CLAVE })).status);
    chk('sigue trabajando', 200, (await emp1('GET', '/api/auth/me')).status);

    tit('8. CAMBIARLE LA CONTRASEÑA AL EMPLEADO LO SACA DE TODAS LAS COMPUS');
    const edicion = await compuC('PUT', `/api/employees/${empleado.id}`, { password: EMP_NUEVA });
    chk('el dueño se la cambia', 200, edicion.status);

    const e1 = await emp1('GET', '/api/auth/me');
    chk('la compu 1 queda afuera', 401,              e1.status);
    chk('con el motivo',           'SESION_CERRADA', e1.json?.codigo);
    chk('la compu 2 también',      401,              (await emp2('GET', '/api/auth/me')).status);
    chk('el dueño no se ve afectado', 200,           (await compuC('GET', '/api/auth/me')).status);

    tit('9. "OLVIDÉ MI CONTRASEÑA" CIERRA TODO, SIN EXCEPCIÓN');
    if (limitado) { console.log('  (se saltea: el limitador de recupero está agotado)'); } else {
    /*
     * Acá no hay sesión a la que perdonar: quien usa este camino perdió el
     * control de la cuenta, y la sesión que la está usando puede ser la del
     * intruso.
     */
    const compuD = sesion();
    chk('D entra con la contraseña de ahora', 200,
      (await compuD('POST', '/api/auth/login', { email: EMAIL, password: CLAVE2 })).status);

    const pedidoReset = await compuD('POST', '/api/auth/forgot-password', { email: EMAIL, cuit: CUIT });
    /*
     * El recupero tiene su propio limitador, más estricto que el del login
     * porque cada intento manda un mail. Corriendo la suite dos veces seguidas
     * se agota. Se saltea SÓLO ante un 429 explícito: saltear en silencio
     * cuando no llega el código escondería justamente la regresión que este
     * bloque cubre.
     */
    if (pedidoReset.status === 429) {
      console.log('  (el limitador de recupero frenó este bloque: se saltea)');
    } else {
      const reset = await PasswordResetCode.findOne({
        where: { businessId: negocio.id, usedAt: null }, order: [['id', 'DESC']],
      });
      chk('llegó un código de recupero', true, Boolean(reset));

      const rehecha = await sesion()('POST', '/api/auth/reset-password', {
        email: EMAIL, code: reset.code, newPassword: CLAVE,
      });
      chk('la contraseña se rehace', 200, rehecha.status);
      chk('y C queda afuera',        401, (await compuC('GET', '/api/auth/me')).status);
      chk('y D también',             401, (await compuD('GET', '/api/auth/me')).status);
    }
    }

    tit('10. EL BOTÓN DE CERRAR TODO, INCLUIDOS LOS EMPLEADOS');
    /*
     * Es el caso del teléfono perdido con la sesión abierta: sacar a todos sin
     * obligar a nadie a inventarse una contraseña nueva. A diferencia del
     * cambio de contraseña, acá los empleados SÍ entran en la volteada — es
     * justamente para lo que se aprieta.
     */
    const jefe = sesion(), jefeOtraCompu = sesion(), empA = sesion(), empB = sesion();
    chk('el dueño entra',              200, (await jefe('POST', '/api/auth/login', { email: EMAIL, password: CLAVE })).status);
    chk('y en otra computadora',       200, (await jefeOtraCompu('POST', '/api/auth/login', { email: EMAIL, password: CLAVE })).status);
    chk('un empleado entra',           200, (await empA('POST', '/api/auth/employee-login', { email: EMP_EMAIL, password: EMP_NUEVA })).status);
    chk('y en otra computadora',       200, (await empB('POST', '/api/auth/employee-login', { email: EMP_EMAIL, password: EMP_NUEVA })).status);

    /*
     * Con la contraseña equivocada no se cierra nada. Sin este control,
     * cualquiera que agarre la máquina del mostrador con la sesión abierta
     * deja al negocio entero afuera en el medio de un sábado.
     */
    const conClaveMala = await jefe('POST', '/api/account/sesiones/cerrar', { passwordActual: 'no-es-esta' });
    chk('con la contraseña equivocada no cierra', 400, conClaveMala.status);
    chk('y nadie se cayó',                        [200, 200],
      [(await empA('GET', '/api/auth/me')).status, (await jefeOtraCompu('GET', '/api/auth/me')).status]);

    const cierre = await jefe('POST', '/api/account/sesiones/cerrar', { passwordActual: CLAVE });
    chk('con la correcta sí',            200,  cierre.status);
    chk('y dice a cuántos empleados sacó', 1,  cierre.json?.empleadosAfectados);

    chk('el empleado queda afuera en una compu', 401, (await empA('GET', '/api/auth/me')).status);
    chk('y en la otra también',                  401, (await empB('GET', '/api/auth/me')).status);
    chk('la otra compu del dueño también',       401, (await jefeOtraCompu('GET', '/api/auth/me')).status);
    chk('pero el que apretó el botón sigue adentro', 200, (await jefe('GET', '/api/auth/me')).status);

    /*
     * Y nadie tuvo que cambiar su contraseña: vuelven a entrar con la de
     * siempre. Es la diferencia con el cambio de contraseña, y es el motivo de
     * que este botón exista aparte.
     */
    chk('el empleado vuelve con su misma contraseña', 200,
      (await sesion()('POST', '/api/auth/employee-login', { email: EMP_EMAIL, password: EMP_NUEVA })).status);
    chk('y el dueño con la suya',                     200,
      (await sesion()('POST', '/api/auth/login', { email: EMAIL, password: CLAVE })).status);

  } finally {
    tit('Limpieza');
    await limpiar();
    chk('no queda el negocio de prueba', 0, await Business.count({ where: { email: EMAIL } }));
    chk('ni su empleado', 0, await Employee.count({ where: { email: EMP_EMAIL } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch(async (e) => { console.error('ERROR', e); await limpiar().catch(() => {}); process.exit(1); });
