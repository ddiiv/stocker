// node scripts/probar-tandas.mjs
import assert from "node:assert/strict";
import { enTandas } from "../src/utils/tandas.js";

const pedidos = [];
const avances = [];
await enTandas([1, 2, 3, 4, 5], 2, async (p) => { pedidos.push(p); return p.length; }, (_, n) => { avances.push(n); });
assert.deepEqual(pedidos, [[1, 2], [3, 4], [5]]);
assert.deepEqual(avances, [2, 4, 5]);

const falla = await enTandas([1, 2, 3, 4, 5], 2, async (p) => { if (p[0] === 3) throw new Error("x"); }).catch((e) => e);
assert.deepEqual(falla.sinMandar, [3, 4, 5]);

let veces = 0;
await enTandas([1, 2, 3], 1, async () => { veces += 1; }, () => false);
assert.equal(veces, 1);
console.log("enTandas: OK");
