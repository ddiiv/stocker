/*
 * Por qué tus facturas no tienen un CAE de verdad.
 *
 * Se corre en el servidor —en Railway, desde la Shell del deploy activo— y
 * contesta una sola pregunta: si hoy emitís una factura, ¿va a tener validez
 * fiscal, y si no, qué falta.
 *
 * Existe porque el modo en que esto falla es el peor posible: la factura sale,
 * con número, con CAE y con PDF, y el problema recién aparece el día que alguien
 * busca ese CAE en ARCA y no está. Para entonces pueden haber pasado meses.
 *
 *   node scripts/arca-diagnostico.cjs            → mira la configuración y la base
 *   node scripts/arca-diagnostico.cjs --probar   → además le pregunta a ARCA de verdad
 *
 * Con --probar hace SÓLO consultas de lectura (estado del servicio, puntos de
 * venta, último número autorizado). No emite ningún comprobante.
 *
 * Nunca imprime certificados, claves, tokens ni CUIT completos: de los
 * certificados muestra una huella corta, que alcanza para comparar dos sin
 * revelar ninguno.
 */

require('dotenv').config({ path: __dirname + '/../.env' });

const crypto = require('crypto');

const C = {
  bien: (t) => `\x1b[32m✓\x1b[0m ${t}`,
  mal: (t) => `\x1b[31m✗\x1b[0m ${t}`,
  ojo: (t) => `\x1b[33m!\x1b[0m ${t}`,
  tit: (t) => `\n\x1b[1m${t}\x1b[0m`,
  tenue: (t) => `\x1b[2m${t}\x1b[0m`,
};

const problemas = [];
const avisos = [];
const anotar = (quien, texto, comoSeArregla) => {
  quien.push({ texto, comoSeArregla });
  console.log(quien === problemas ? C.mal(texto) : C.ojo(texto));
  if (comoSeArregla) console.log(C.tenue(`    → ${comoSeArregla}`));
};

/* Un CUIT se muestra como 30-XXXXXXX-7: alcanza para reconocerlo sin publicarlo. */
const cuitCorto = (c) => {
  const s = String(c || '').replace(/\D/g, '');
  if (s.length !== 11) return '(no parece un CUIT)';
  return `${s.slice(0, 2)}-${'X'.repeat(7)}-${s.slice(-1)}`;
};

/*
 * Los mensajes de ARCA traen CUIT adentro ("No aparecio CUIT en lista de
 * relaciones: 20345678906"). Este diagnóstico se corre en un servidor con varios
 * clientes y su salida se pega en un chat o en un ticket, así que los CUIT que
 * vengan en el texto se tapan igual que los demás.
 */
const taparCuits = (texto) => String(texto || '').replace(/\b(\d{2})\d{8}(\d)\b/g, '$1XXXXXXX$2');

/* Huella de un certificado: compara dos sin revelar ninguno. */
const huella = (pem) => (pem
  ? crypto.createHash('sha256').update(String(pem)).digest('hex').slice(0, 12)
  : null);

(async () => {
  console.log('\x1b[1mDiagnóstico de facturación ARCA\x1b[0m');
  console.log(C.tenue(new Date().toISOString()));

  // ── 1. El modo simulado ────────────────────────────────────────
  console.log(C.tit('1. ¿Está en modo simulado?'));
  const mock = process.env.ARCA_MOCK === 'true';
  if (mock) {
    anotar(problemas,
      'ARCA_MOCK=true: TODAS las facturas salen con un CAE inventado.',
      'Poné ARCA_MOCK=false en las variables del servicio y volvé a desplegar. Las facturas que ya salieron así no se convierten: quedan como prueba.');
  } else {
    console.log(C.bien('ARCA_MOCK no está prendido: las facturas se piden a ARCA de verdad.'));
  }

  // ── 2. Los certificados ────────────────────────────────────────
  console.log(C.tit('2. Los certificados de Stocker'));
  const { loadCredentials } = require('../src/services/arcaCredentials');
  const huellas = {};
  for (const ambiente of ['homologacion', 'produccion']) {
    let creds = null;
    try { creds = loadCredentials(ambiente); } catch { creds = null; }
    if (!creds || !creds.cert || !creds.key) {
      const sufijo = ambiente === 'produccion' ? 'PROD' : 'HOMO';
      anotar(ambiente === 'produccion' ? problemas : avisos,
        `No hay certificado para ${ambiente}.`,
        `Cargá ARCA_CERT_B64_${sufijo} y ARCA_KEY_B64_${sufijo} (el .crt y el .key en base64).`);
      continue;
    }
    huellas[ambiente] = huella(creds.cert);
    console.log(C.bien(`${ambiente}: certificado cargado  ${C.tenue(`huella ${huellas[ambiente]}`)}`));
  }

  /*
   * La trampa silenciosa: `loadCredentials` cae al certificado genérico
   * (ARCA_CERT_B64) cuando no encuentra el del ambiente. Si el genérico es el de
   * homologación, un negocio en producción firma con el certificado equivocado y
   * ARCA lo rechaza sin decir por qué de forma entendible.
   */
  if (huellas.homologacion && huellas.produccion && huellas.homologacion === huellas.produccion) {
    anotar(problemas,
      'El certificado de producción y el de homologación son EL MISMO.',
      'Seguramente falta ARCA_CERT_B64_PROD y se está cayendo al genérico. Son dos certificados distintos: el de producción se tramita aparte en ARCA.');
  }

  if (!process.env.ARCA_STOCKER_CUIT) {
    anotar(problemas, 'Falta ARCA_STOCKER_CUIT (el CUIT con el que Stocker firma).',
      'Cargalo en las variables del servicio.');
  } else {
    console.log(C.bien(`CUIT firmante de Stocker: ${cuitCorto(process.env.ARCA_STOCKER_CUIT)}`));
  }

  // ── 3. Qué tiene configurado cada negocio ──────────────────────
  console.log(C.tit('3. Los negocios y sus CUIT'));
  const db = require('../src/config/database');
  const { BusinessArcaConfig, BusinessCuit, Business, Invoice } = require('../src/models');

  const configs = await BusinessArcaConfig.findAll({ raw: true });
  if (!configs.length) {
    anotar(problemas, 'Ningún CUIT tiene configuración de ARCA.',
      'En Stocker: Configuración → ARCA, elegí el CUIT, poné el punto de venta y el ambiente.');
  }

  const cuits = await BusinessCuit.findAll({ raw: true }).catch(() => []);
  const negocios = await Business.findAll({ attributes: ['id', 'nombre'], raw: true }).catch(() => []);
  const nombreDe = new Map(negocios.map((n) => [n.id, n.nombre]));
  const cuitDe = new Map(cuits.map((c) => [c.id, c.cuit]));

  const listos = [];
  for (const c of configs) {
    const quien = `${nombreDe.get(c.businessId) || `negocio ${c.businessId}`} · ${cuitCorto(cuitDe.get(c.businessCuitId))}`;
    const enProduccion = c.ambiente === 'produccion';
    console.log(`\n  ${quien}`);
    console.log(`    ambiente: ${enProduccion ? '\x1b[32mproducción\x1b[0m' : '\x1b[33mhomologación\x1b[0m'}`);
    console.log(`    punto de venta: ${c.puntoVenta || '\x1b[31m(sin configurar)\x1b[0m'}`);
    console.log(`    delegación verificada: ${c.delegacionVerificada ? 'sí' : 'no'}`);
    if (c.ultimoError) console.log(C.tenue(`    último error: ${taparCuits(c.ultimoError).slice(0, 160)}`));

    if (!enProduccion) {
      anotar(avisos, `${quien}: está en HOMOLOGACIÓN, así que sus facturas no tienen validez fiscal.`,
        'Configuración → ARCA → ambiente: producción. Ojo: el punto de venta y la delegación de producción son distintos de los de prueba.');
    }
    if (!c.puntoVenta) {
      anotar(problemas, `${quien}: no tiene punto de venta configurado.`,
        'Dalo de alta en ARCA (Comprobantes en línea → Puntos de venta) y después cargalo acá.');
    }
    if (enProduccion && !c.delegacionVerificada) {
      anotar(problemas, `${quien}: está en producción pero la delegación no está verificada.`,
        'El titular del CUIT tiene que delegarle el servicio "wsfe" al CUIT de Stocker desde su Clave Fiscal (Administrador de Relaciones).');
    }
    if (enProduccion && c.puntoVenta && c.delegacionVerificada) listos.push({ c, quien });
  }

  // ── 4. Lo que de verdad se emitió ──────────────────────────────
  console.log(C.tit('4. Las facturas que ya salieron'));
  const facturas = await Invoice.findAll({
    attributes: ['id', 'cae', 'ambiente', 'simulado', 'clase', 'createdAt'],
    order: [['id', 'DESC']], limit: 200, raw: true,
  }).catch(() => []);
  if (!facturas.length) {
    console.log(C.tenue('  Todavía no se emitió ninguna.'));
  } else {
    const fiscales = facturas.filter((f) => f.cae && f.ambiente === 'produccion' && !f.simulado);
    const simuladas = facturas.filter((f) => f.simulado);
    const deHomo = facturas.filter((f) => f.ambiente !== 'produccion' && !f.simulado);
    const sinCae = facturas.filter((f) => !f.cae);
    console.log(`  De las últimas ${facturas.length}:`);
    console.log(`    ${fiscales.length ? C.bien(`${fiscales.length} con validez fiscal`) : C.tenue('0 con validez fiscal')}`);
    if (deHomo.length) console.log(`    ${C.ojo(`${deHomo.length} emitidas en homologación (no valen)`)}`);
    if (simuladas.length) console.log(`    ${C.mal(`${simuladas.length} simuladas, con CAE inventado`)}`);
    if (sinCae.length) console.log(`    ${C.mal(`${sinCae.length} sin CAE`)}`);
    const ultima = facturas[0];
    console.log(C.tenue(`    la última: #${ultima.id}, ${ultima.ambiente || 'sin ambiente'}${ultima.simulado ? ', simulada' : ''}${ultima.cae ? '' : ', SIN CAE'}`));
  }

  // ── 5. Preguntarle a ARCA ──────────────────────────────────────
  if (!process.argv.includes('--probar')) {
    console.log(C.tit('5. Probar contra ARCA'));
    console.log(C.tenue('  Volvé a correrlo con --probar para preguntarle a ARCA de verdad.'));
    console.log(C.tenue('  Son consultas de lectura: no emite ningún comprobante.'));
  } else if (mock) {
    console.log(C.tit('5. Probar contra ARCA'));
    console.log(C.tenue('  Salteado: con ARCA_MOCK prendido no se llama a ARCA.'));
  } else {
    console.log(C.tit('5. Lo que dice ARCA'));
    const arca = require('../src/services/arcaService');
    const cli = require('../src/services/arcaClient');
    const { loadCredentials: cargar } = require('../src/services/arcaCredentials');

    const ambientes = [...new Set(configs.map((c) => (c.ambiente === 'produccion' ? 'produccion' : 'homologacion')))];
    for (const ambiente of (ambientes.length ? ambientes : ['homologacion'])) {
      console.log(`\n  ── ${ambiente} ──`);
      try {
        const estado = await arca.checkStatus({ ambiente });
        console.log(C.bien(`el servicio responde  ${C.tenue(JSON.stringify(estado).slice(0, 120))}`));
      } catch (e) {
        anotar(problemas, `${ambiente}: ARCA no responde o el certificado no sirve — ${taparCuits(e.message)}`,
          'Si dice algo de "certificado" o "computador no autorizado", el certificado no está habilitado para wsfe en ese ambiente.');
        continue;
      }

      /*
       * Quién le delegó a Stocker. Sale del ticket de acceso, que es una foto de
       * 12 horas: una delegación otorgada hace diez minutos puede no estar acá
       * todavía.
       */
      try {
        const creds = cargar(ambiente);
        const ta = await cli.getTA({ cert: creds.cert, key: creds.key, ambiente });
        const rel = cli.relacionesDelTA(ta) || [];
        console.log(`  representados en el ticket de acceso: ${rel.length}`);
        if (!rel.length) {
          anotar(avisos, `${ambiente}: nadie le delegó el servicio a Stocker todavía (o el ticket es anterior a la delegación).`,
            'El ticket de acceso dura 12 horas. Si delegaste recién, puede tardar en verse.');
        }
      } catch (e) {
        console.log(C.tenue(`  no se pudo leer el ticket de acceso: ${e.message}`));
      }

      for (const { c, quien } of listos.filter((x) => (x.c.ambiente === 'produccion') === (ambiente === 'produccion'))) {
        const cuit = cuitDe.get(c.businessCuitId);
        try {
          const creds = cargar(ambiente);
          const { puntos } = await cli.feParamGetPtosVenta({
            cert: creds.cert, key: creds.key, ambiente, cuitEmisor: cuit,
          });
          const nros = (puntos || []).map((p) => Number(p.Nro ?? p.nro));
          if (!nros.includes(Number(c.puntoVenta))) {
            anotar(problemas,
              `${quien}: el punto de venta ${c.puntoVenta} NO existe en ${ambiente}.`,
              `ARCA dice que tiene: ${nros.join(', ') || '(ninguno)'}. Los puntos de venta de prueba no sirven en producción: hay que darlos de alta aparte.`);
          } else {
            console.log(C.bien(`${quien}: el punto de venta ${c.puntoVenta} existe`));
          }
        } catch (e) {
          anotar(problemas, `${quien}: no se pudieron leer los puntos de venta — ${taparCuits(e.message)}`,
            'Suele ser que falta la delegación del servicio wsfe para ese CUIT.');
        }
      }
    }
  }

  // ── El veredicto ───────────────────────────────────────────────
  console.log(C.tit('En una línea'));
  if (problemas.length) {
    console.log(C.mal(`Hoy NO podés emitir una factura con validez fiscal. Hay ${problemas.length} cosa(s) que arreglar:`));
    problemas.forEach((p, i) => console.log(`  ${i + 1}. ${p.texto}\n     → ${p.comoSeArregla}`));
  } else if (!listos.length) {
    console.log(C.ojo('Ningún CUIT está listo para producción todavía. Mirá los avisos de arriba.'));
  } else {
    console.log(C.bien(`${listos.length} CUIT listo(s) para emitir con validez fiscal.`));
    if (!process.argv.includes('--probar')) {
      console.log(C.tenue('  Corré con --probar para confirmarlo contra ARCA antes de facturarle a un cliente.'));
    }
  }
  if (avisos.length) {
    console.log(`\n${avisos.length} aviso(s) que no bloquean pero conviene mirar.`);
  }

  await db.close();
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => { console.error('\nEl diagnóstico se cayó:', e.message); process.exit(2); });
