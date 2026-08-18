import { recorteFuente, ajustar, MINIMO } from '../src/utils/recorte.js';

let ok = 0, ko = 0;
const chk = (t, esperado, obtuvo) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtuvo);
  if (a === b) { console.log(`  ✓ ${t}`); ok++; }
  else { console.log(`  ✗ ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n${t}`);

// ── Recorte ──────────────────────────────────────────────────────
tit('1. RECORTE — la caja y el video tienen la misma proporción');
// 1920x1080 mostrado en 640x360: escala exacta 1/3, sin sobrante.
chk('el recuadro central mapea proporcional',
  { sx: 192, sy: 324, sw: 1536, sh: 324 },
  recorteFuente({ vw: 1920, vh: 1080, dw: 640, dh: 360 }, { x: .10, y: .30, w: .80, h: .30 }));

chk('el recuadro completo cubre todo el cuadro',
  { sx: 0, sy: 0, sw: 1920, sh: 1080 },
  recorteFuente({ vw: 1920, vh: 1080, dw: 640, dh: 360 }, { x: 0, y: 0, w: 1, h: 1 }));

tit('2. RECORTE — celular vertical con cámara apaisada (el caso real)');
// Cámara 1920x1080 en una caja 390x420 (vertical). object-cover escala por alto
// (420/1080 = .3889) y recorta 264 px de ancho a cada lado en pantalla.
const cel = { vw: 1920, vh: 1080, dw: 390, dh: 420 };
const r = recorteFuente(cel, { x: .10, y: .36, w: .80, h: .28 });
chk('el recorte no se sale por la izquierda', true, r.sx >= 0);
chk('el recorte no se pasa del ancho del cuadro', true, r.sx + r.sw <= 1920);
chk('el recorte no se pasa del alto del cuadro', true, r.sy + r.sh <= 1080);
// escala = 420/1080 = .38889 (manda el alto). Sobra a lo ancho
// (1920*.38889-390)/2 = 178.3 px de pantalla. x=.10 → (39+178.3)/.38889 = 558.9.
chk('descuenta el sobrante de object-cover', { sx: 559, sy: 389, sw: 802, sh: 302 }, r);

tit('3. RECORTE — el recuadro centrado sigue centrado');
const c = recorteFuente(cel, { x: .25, y: .25, w: .50, h: .50 });
chk('queda simétrico en horizontal', true, Math.abs((c.sx + c.sw / 2) - 960) <= 1);
chk('queda simétrico en vertical',   true, Math.abs((c.sy + c.sh / 2) - 540) <= 1);

tit('4. RECORTE — casos degenerados');
chk('sin dimensiones de video devuelve null', null, recorteFuente({ vw: 0, vh: 0, dw: 390, dh: 420 }, { x: 0, y: 0, w: 1, h: 1 }));
chk('sin caja en pantalla devuelve null',     null, recorteFuente({ vw: 1920, vh: 1080, dw: 0, dh: 0 }, { x: 0, y: 0, w: 1, h: 1 }));
const min = recorteFuente(cel, { x: .5, y: .5, w: .0001, h: .0001 });
chk('un recuadro ínfimo nunca da un lienzo de 0', true, min.sw >= 1 && min.sh >= 1);

// ── Arrastre ─────────────────────────────────────────────────────
const base = { x: .10, y: .36, w: .80, h: .28 };

tit('5. MOVER');
chk('se mueve la posición y no cambia el tamaño',
  { x: .20, y: .46, w: .80, h: .28 }, ajustar('mover', base, .10, .10));
chk('el resultado no arrastra restos de coma flotante', true,
  Object.values(ajustar('mover', base, .10, .10)).every((v) => v === Math.round(v * 1e4) / 1e4));
chk('no se sale por la izquierda',  0, ajustar('mover', base, -5, 0).x);
chk('no se sale por arriba',        0, ajustar('mover', base, 0, -5).y);
chk('no se sale por la derecha',
  Number((1 - base.w).toFixed(10)), Number(ajustar('mover', base, 5, 0).x.toFixed(10)));
chk('no se sale por abajo',
  Number((1 - base.h).toFixed(10)), Number(ajustar('mover', base, 0, 5).y.toFixed(10)));

tit('6. ESTIRAR');
const red = (o) => o;   // ajustar ya redondea; si dejara restos, estos casos fallan
chk('esquina inferior derecha agranda',
  { x: .10, y: .36, w: .85, h: .33 }, red(ajustar('db', base, .05, .05)));
chk('esquina superior izquierda mueve el origen y compensa el tamaño',
  { x: .15, y: .41, w: .75, h: .23 }, red(ajustar('ia', base, .05, .05)));
chk('esquina superior derecha combina ambos ejes',
  { x: .10, y: .41, w: .85, h: .23 }, red(ajustar('da', base, .05, .05)));

tit('7. ESTIRAR — topes');
const chico = ajustar('db', base, -5, -5);
chk('no se achica más allá del mínimo', { w: MINIMO, h: MINIMO }, { w: chico.w, h: chico.h });
const chicoIA = ajustar('ia', base, 5, 5);
chk('tirando del borde izquierdo tampoco se invierte', true, chicoIA.w >= MINIMO && chicoIA.h >= MINIMO);
chk('y el origen no pasa del borde opuesto', true, chicoIA.x + chicoIA.w <= base.x + base.w + 1e-9);
const grande = ajustar('db', base, 5, 5);
chk('estirando de más queda pegado al borde', { w: .90, h: .64 }, red({ w: grande.w, h: grande.h }));
chk('y nunca se pasa del 100%', true, grande.x + grande.w <= 1 + 1e-9 && grande.y + grande.h <= 1 + 1e-9);

tit('8. ESTIRAR — el recuadro siempre queda usable');
// Cien arrastres al azar: ninguno puede dejarlo invertido ni fuera de pantalla.
let sano = true;
let cur = { ...base };
const tipos = ['mover', 'ia', 'da', 'ib', 'db'];
for (let i = 0; i < 100; i++) {
  cur = ajustar(tipos[i % 5], cur, (Math.random() - .5) * 2, (Math.random() - .5) * 2);
  if (cur.w < MINIMO - 1e-9 || cur.h < MINIMO - 1e-9) sano = false;
  if (cur.x < -1e-9 || cur.y < -1e-9) sano = false;
  if (cur.x + cur.w > 1 + 1e-9 || cur.y + cur.h > 1 + 1e-9) sano = false;
}
chk('tras 100 arrastres al azar sigue dentro y con tamaño mínimo', true, sano);

console.log(`\n─────────────────────────────\n  Pasaron: ${ok}   Fallaron: ${ko}`);
process.exit(ko ? 1 : 0);
