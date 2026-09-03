const { BusinessCuit, BusinessArcaConfig, Business } = require('../models');
const arcaService = require('../services/arcaService');
const email = require('../services/emailService');
const { log } = require('../utils/logger');

// GET /api/arca/cuits/:cuitId/config
const getConfig = async (req, res, next) => {
  try {
    const cuit = await BusinessCuit.findOne({ where: { id: req.params.cuitId, businessId: req.auth.businessId } });
    if (!cuit) return res.status(404).json({ message: 'CUIT del negocio no encontrado.' });
    const config = await BusinessArcaConfig.findOne({ where: { businessCuitId: cuit.id } });
    res.json({
      cuit: { id: cuit.id, nombre: cuit.nombre, cuit: cuit.cuit, condicionIva: cuit.condicionIva },
      config: config || null,
      stockerCuit: process.env.ARCA_STOCKER_CUIT || null,
      mockMode: process.env.ARCA_MOCK === 'true',
    });
  } catch (error) { next(error); }
};

// POST /api/arca/cuits/:cuitId/config
// body: { puntoVenta, condicionIva, ambiente }
const saveConfig = async (req, res, next) => {
  try {
    const cuit = await BusinessCuit.findOne({ where: { id: req.params.cuitId, businessId: req.auth.businessId } });
    if (!cuit) return res.status(404).json({ message: 'CUIT del negocio no encontrado.' });
    const { puntoVenta, condicionIva, ambiente } = req.body || {};
    const patch = {
      puntoVenta:   puntoVenta != null ? Number(puntoVenta) : null,
      condicionIva: condicionIva || null,
      ambiente:     ambiente === 'produccion' ? 'produccion' : 'homologacion',
    };
    const [config] = await BusinessArcaConfig.findOrCreate({
      where: { businessCuitId: cuit.id },
      defaults: { businessId: req.auth.businessId, ...patch },
    });
    await config.update(patch);
    res.json(config);
  } catch (error) { next(error); }
};

// POST /api/arca/cuits/:cuitId/verify
// Prueba delegación real llamando a getSalesPoints() de ARCA.
const verifyDelegation = async (req, res, next) => {
  try {
    const cuit = await BusinessCuit.findOne({ where: { id: req.params.cuitId, businessId: req.auth.businessId } });
    if (!cuit) return res.status(404).json({ message: 'CUIT no encontrado.' });
    let config = await BusinessArcaConfig.findOne({ where: { businessCuitId: cuit.id } });
    if (!config) {
      config = await BusinessArcaConfig.create({
        businessId: req.auth.businessId, businessCuitId: cuit.id, ambiente: 'homologacion',
      });
    }

    const result = await arcaService.verifyDelegation({
      businessCuit: cuit.cuit,
      ambiente:     config.ambiente,
    });

    await config.update({
      delegacionVerificada: !!result.ok,
      ultimaVerificacion:   new Date(),
      ultimoError:          result.ok ? null : (result.error || null),
    });

    /*
     * ── Avisar que hay un trámite esperando ──────────────────────
     *
     * El error 600 es el único que el cliente NO puede resolver solo: la
     * relación la tiene que crear alguien de Stocker en el AFIP del cliente.
     * Antes el circuito era: el cliente ve un error que no entiende, escribe,
     * espera, explica cuál CUIT era. Ahora el pedido llega solo, con el número
     * adentro y los pasos al lado.
     *
     * Se avisa una vez por día y no una por intento: "Verificar" es justamente
     * lo que la persona aprieta cuando no le anda, o sea muchas veces seguidas.
     * Y se sigue avisando mientras siga pendiente, porque un trámite que se
     * avisó una vez hace tres semanas es un trámite que nadie hizo.
     *
     * El aviso nunca rompe la respuesta: si el correo no está configurado o
     * falla, el cliente igual tiene que ver su diagnóstico.
     */
    const esperaDelegacion = !result.ok
      && Array.isArray(result.erroresAfip)
      && result.erroresAfip.some((x) => [600, 601].includes(x.codigo))
      // Si nuestro propio certificado tampoco anda, el trámite pendiente no es
      // éste: es otro, y de nuestro lado. Avisar de una delegación mandaría a
      // hacer el trámite equivocado.
      && result.certificadoPropio !== 'falla';

    const UN_DIA = 24 * 60 * 60 * 1000;
    const yaAvisado = config.delegacionAvisadaEn
      && Date.now() - new Date(config.delegacionAvisadaEn).getTime() < UN_DIA;

    if (esperaDelegacion && !yaAvisado) {
      try {
        const negocio = await Business.findByPk(req.auth.businessId, {
          attributes: ['id', 'nombreNegocio', 'cuit', 'email'],
        });
        await email.sendDelegacionArcaPendiente({
          negocio,
          cuit:     cuit.cuit,
          nombre:   cuit.nombre,
          ambiente: config.ambiente,
          motivo:   result.error || null,
          emailDueno: negocio?.email || null,
        });
        await config.update({ delegacionAvisadaEn: new Date() });
      } catch (e) {
        log.warn('arca', 'no se pudo avisar la delegación pendiente', {
          negocio: req.auth.businessId, motivo: e.message,
        });
      }
    }

    res.json({ ...result, config, avisoEnviado: esperaDelegacion && !yaAvisado });
  } catch (error) { next(error); }
};

// GET /api/arca/status → salud del servicio ARCA (nuestro cert, ambiente configurado)
// NUNCA tira 500: siempre responde 200 con `ok:false` + `error`/`hint` si algo falla,
// para que el frontend muestre estado claro en vez de mensaje genérico.
const status = async (req, res) => {
  const ambiente = req.query.ambiente === 'produccion' ? 'produccion' : 'homologacion';
  const mockMode = process.env.ARCA_MOCK === 'true';
  const stockerCuit = process.env.ARCA_STOCKER_CUIT || null;
  const certConfigured = !!(process.env.ARCA_CERT_PATH && process.env.ARCA_KEY_PATH);

  const base = { ambiente, mockMode, stockerCuit, certConfigured };

  // Modo mock → OK simulado
  if (mockMode) {
    return res.json({ ...base, ok: true, mock: true, note: 'ARCA_MOCK=true en el .env — usando CAE simulados.' });
  }

  // Chequeos previos antes de intentar conectar a AFIP (así devolvemos mensaje útil):
  if (!stockerCuit) {
    return res.json({ ...base, ok: false, error: 'ARCA_STOCKER_CUIT no configurado en el .env del servidor.' });
  }
  if (!certConfigured) {
    return res.json({ ...base, ok: false, error: 'ARCA_CERT_PATH y/o ARCA_KEY_PATH no configurados en el .env.' });
  }

  try {
    const result = await arcaService.checkStatus({ ambiente });
    res.json({ ...base, ...result });
  } catch (error) {
    // Errores típicos: cert no existe en disco, cert inválido, red bloqueada, timeout AFIP.
    const msg = error.message || String(error);
    const hint =
      /No existe el certificado|ENOENT/i.test(msg)  ? 'El archivo del certificado no está en la ruta configurada. Correlo con `npm run arca:generate-cert` y subí el .crt firmado por AFIP.' :
      /computador|comput_?no.*aut/i.test(msg)       ? 'El certificado está en el server pero AFIP no lo tiene autorizado. Revisá Administrador de Certificados Digitales en AFIP.' :
      /(status code 401|Unauthorized)/i.test(msg)   ? 'AFIP rechazó el certificado (401). Causas típicas: (1) al certificado en AFIP no le asignaste el servicio "Facturación Electrónica" con vos como representante y el alias del cert como Computador Fiscal — hacelo en "Administrador de Relaciones" → Nueva Relación; (2) el .crt del server no matchea con el .key (los generaste como par?); (3) el ambiente no matchea (homologación vs producción usan endpoints distintos).' :
      /(status code 403|Forbidden)/i.test(msg)      ? 'AFIP devolvió 403. El CUIT no tiene adherido el servicio "WebServices Ambiente Homologación" (o Producción). Adherilo desde Administrador de Relaciones → Adherir Servicio.' :
      /(status code 500|status code 503)/i.test(msg)? 'Servidores AFIP con problemas. Reintentá en unos minutos.' :
      /timeout|ETIMEDOUT|ECONNREFUSED/i.test(msg)   ? 'AFIP no responde (puede ser mantenimiento o problema de red).' :
      /certificate|SSL|TLS/i.test(msg)              ? 'Problema con el certificado o TLS. Verificá que el .crt sea el firmado por AFIP y que el .key sea el que generó el CSR.' :
      null;
    res.json({ ...base, ok: false, error: msg, hint });
  }
};

// GET /api/arca/debug → devuelve la config actual de certs sin llamar a AFIP.
// Sirve para diagnosticar 401: ver qué cert está usando, si existe en disco, etc.
const debug = async (req, res) => {
  try {
    res.json(arcaService.debugConfig());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = { getConfig, saveConfig, verifyDelegation, status, debug };
