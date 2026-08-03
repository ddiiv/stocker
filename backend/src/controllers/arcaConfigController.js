const { BusinessCuit, BusinessArcaConfig } = require('../models');
const arcaService = require('../services/arcaService');

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

    res.json({ ...result, config });
  } catch (error) { next(error); }
};

// GET /api/arca/status → salud del servicio ARCA (nuestro cert, ambiente configurado)
const status = async (req, res, next) => {
  try {
    const ambiente = req.query.ambiente === 'produccion' ? 'produccion' : 'homologacion';
    const result = await arcaService.checkStatus({ ambiente });
    res.json({
      ambiente,
      mockMode:    process.env.ARCA_MOCK === 'true',
      stockerCuit: process.env.ARCA_STOCKER_CUIT || null,
      certConfigured: !!(process.env.ARCA_CERT_PATH && process.env.ARCA_KEY_PATH),
      ...result,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};

module.exports = { getConfig, saveConfig, verifyDelegation, status };
