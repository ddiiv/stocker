// Facturas (modelo ARCA/AFIP simplificado) y recibos generados a partir
// de las ventas ya pagas. `cae` y `caeVencimiento` son simulados: el día
// que se integre el webservice real de ARCA, ese es el punto de reemplazo.
export const seedInvoices = [
  {
    "id": "inv_8001",
    "numero": "0001-00008001",
    "tipo": "A",
    "ventaId": "sale_1037",
    "ventaNumero": "V-1037",
    "fecha": "2026-07-26",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "items": [
      {
        "sku": "ISUMONBUZTOSS",
        "skuAgrupador": "ISUMONBUZ",
        "titulo": "MONACO Buzo Unisex Tostado",
        "talle": "S",
        "color": "Tostado",
        "cantidad": 4,
        "precioUnitario": 21600,
        "subtotal": 86400
      }
    ],
    "neto": 64264,
    "iva": 13496,
    "total": 77760,
    "cae": "780013902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8002",
    "numero": "0001-00008002",
    "tipo": "B",
    "ventaId": "sale_1040",
    "ventaNumero": "V-1040",
    "fecha": "2026-07-22",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "items": [
      {
        "sku": "ISUPOLBUZNEGL",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 3,
        "precioUnitario": 26050,
        "subtotal": 78150
      },
      {
        "sku": "ISUMISCAMNEG10",
        "skuAgrupador": "ISUMISCAM",
        "titulo": "MISTICA Campera Niño Negro",
        "talle": "10",
        "color": "Negro",
        "cantidad": 3,
        "precioUnitario": 45750,
        "subtotal": 137250
      }
    ],
    "neto": 178017,
    "iva": 37383,
    "total": 215400,
    "cae": "780023902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8003",
    "numero": "0001-00008003",
    "tipo": "A",
    "ventaId": "sale_1033",
    "ventaNumero": "V-1033",
    "fecha": "2026-07-15",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "items": [
      {
        "sku": "ISUJUNSHOBLA10",
        "skuAgrupador": "ISUJUNSHO",
        "titulo": "JUNIOR Short Mujer Blanco",
        "talle": "10",
        "color": "Blanco",
        "cantidad": 5,
        "precioUnitario": 13300,
        "subtotal": 66500
      },
      {
        "sku": "ISUPOLBUZNEGXL",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 1,
        "precioUnitario": 22950,
        "subtotal": 22950
      },
      {
        "sku": "ISURUMSHONEGL",
        "skuAgrupador": "ISURUMSHO",
        "titulo": "RUM Short Hombre Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 1,
        "precioUnitario": 14000,
        "subtotal": 14000
      }
    ],
    "neto": 81221,
    "iva": 17057,
    "total": 98278,
    "cae": "780033902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8004",
    "numero": "0001-00008004",
    "tipo": "A",
    "ventaId": "sale_1006",
    "ventaNumero": "V-1006",
    "fecha": "2026-07-13",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "items": [
      {
        "sku": "ISUBAGPANNEGM",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Negro",
        "talle": "M",
        "color": "Negro",
        "cantidad": 6,
        "precioUnitario": 26900,
        "subtotal": 161400
      },
      {
        "sku": "ISUWOLCAMCELL",
        "skuAgrupador": "ISUWOLCAM",
        "titulo": "WOLF Campera Hombre Celeste",
        "talle": "L",
        "color": "Celeste",
        "cantidad": 1,
        "precioUnitario": 39900,
        "subtotal": 39900
      },
      {
        "sku": "ISUPOLBUZNEGXL",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 2,
        "precioUnitario": 22950,
        "subtotal": 45900
      }
    ],
    "neto": 204298,
    "iva": 42902,
    "total": 247200,
    "cae": "780043902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8005",
    "numero": "0001-00008005",
    "tipo": "B",
    "ventaId": "sale_1008",
    "ventaNumero": "V-1008",
    "fecha": "2026-07-11",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "items": [
      {
        "sku": "ISUPOLBUZNEGL",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 1,
        "precioUnitario": 26050,
        "subtotal": 26050
      }
    ],
    "neto": 20453,
    "iva": 4295,
    "total": 24748,
    "cae": "780053902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8006",
    "numero": "0001-00008006",
    "tipo": "B",
    "ventaId": "sale_1020",
    "ventaNumero": "V-1020",
    "fecha": "2026-07-10",
    "cliente": {
      "nombre": "María Paz Gómez",
      "cuitDni": "27-33445566-3",
      "telefono": "1156789012",
      "email": "mpgomez@gmail.com"
    },
    "items": [
      {
        "sku": "ISUMISCAMNEG10",
        "skuAgrupador": "ISUMISCAM",
        "titulo": "MISTICA Campera Niño Negro",
        "talle": "10",
        "color": "Negro",
        "cantidad": 4,
        "precioUnitario": 45750,
        "subtotal": 183000
      }
    ],
    "neto": 151240,
    "iva": 31760,
    "total": 183000,
    "cae": "780063902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8007",
    "numero": "0001-00008007",
    "tipo": "A",
    "ventaId": "sale_1002",
    "ventaNumero": "V-1002",
    "fecha": "2026-07-08",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "items": [
      {
        "sku": "ISUBOXPANVER12",
        "skuAgrupador": "ISUBOXPAN",
        "titulo": "BOX Pantalon Niño VERDE ESCOLAR/VERDE INGLES",
        "talle": "12",
        "color": "VERDE ESCOLAR/VERDE INGLES",
        "cantidad": 4,
        "precioUnitario": 24150,
        "subtotal": 96600
      }
    ],
    "neto": 75843,
    "iva": 15927,
    "total": 91770,
    "cae": "780073902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8008",
    "numero": "0001-00008008",
    "tipo": "B",
    "ventaId": "sale_1031",
    "ventaNumero": "V-1031",
    "fecha": "2026-07-06",
    "cliente": {
      "nombre": "Julián Ferreyra",
      "cuitDni": "20-38221144-0",
      "telefono": "1167891234",
      "email": "julian.ferreyra@outlook.com"
    },
    "items": [
      {
        "sku": "ISUWOLCAMCHOS",
        "skuAgrupador": "ISUWOLCAM",
        "titulo": "WOLF Campera Hombre Chocolate",
        "talle": "S",
        "color": "Chocolate",
        "cantidad": 6,
        "precioUnitario": 40700,
        "subtotal": 244200
      },
      {
        "sku": "ISUBAGPANNEG2XL",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Negro",
        "talle": "2XL",
        "color": "Negro",
        "cantidad": 4,
        "precioUnitario": 29900,
        "subtotal": 119600
      }
    ],
    "neto": 300661,
    "iva": 63139,
    "total": 363800,
    "cae": "780083902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8009",
    "numero": "0001-00008009",
    "tipo": "B",
    "ventaId": "sale_1046",
    "ventaNumero": "V-1046",
    "fecha": "2026-07-06",
    "cliente": {
      "nombre": "Julián Ferreyra",
      "cuitDni": "20-38221144-0",
      "telefono": "1167891234",
      "email": "julian.ferreyra@outlook.com"
    },
    "items": [
      {
        "sku": "ISUBOXPANVER8",
        "skuAgrupador": "ISUBOXPAN",
        "titulo": "BOX Pantalon Niño VERDE ESCOLAR/VERDE INGLES",
        "talle": "8",
        "color": "VERDE ESCOLAR/VERDE INGLES",
        "cantidad": 1,
        "precioUnitario": 29350,
        "subtotal": 29350
      }
    ],
    "neto": 24256,
    "iva": 5094,
    "total": 29350,
    "cae": "780093902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8010",
    "numero": "0001-00008010",
    "tipo": "A",
    "ventaId": "sale_1043",
    "ventaNumero": "V-1043",
    "fecha": "2026-07-03",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "items": [
      {
        "sku": "ISUMIRREMAAZS",
        "skuAgrupador": "ISUMIRREM",
        "titulo": "MIRRA Remera Unisex Azul",
        "talle": "S",
        "color": "Azul",
        "cantidad": 2,
        "precioUnitario": 9900,
        "subtotal": 19800
      },
      {
        "sku": "ISUMIRREMAAZXL",
        "skuAgrupador": "ISUMIRREM",
        "titulo": "MIRRA Remera Unisex Azul",
        "talle": "XL",
        "color": "Azul",
        "cantidad": 2,
        "precioUnitario": 10600,
        "subtotal": 21200
      },
      {
        "sku": "ISUBRIREMNEGXS",
        "skuAgrupador": "ISUBRIREM",
        "titulo": "BORDI Remera Hombre Negro",
        "talle": "XS",
        "color": "Negro",
        "cantidad": 2,
        "precioUnitario": 10350,
        "subtotal": 20700
      }
    ],
    "neto": 50992,
    "iva": 10708,
    "total": 61700,
    "cae": "780103902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8011",
    "numero": "0001-00008011",
    "tipo": "A",
    "ventaId": "sale_1042",
    "ventaNumero": "V-1042",
    "fecha": "2026-06-30",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "items": [
      {
        "sku": "ISUMONBUZTOSXL",
        "skuAgrupador": "ISUMONBUZ",
        "titulo": "MONACO Buzo Unisex Tostado",
        "talle": "XL",
        "color": "Tostado",
        "cantidad": 5,
        "precioUnitario": 26800,
        "subtotal": 134000
      },
      {
        "sku": "ISUMAECAMNEGM",
        "skuAgrupador": "ISUMAECAM",
        "titulo": "MAEV Campera Mujer Negro",
        "talle": "M",
        "color": "Negro",
        "cantidad": 2,
        "precioUnitario": 40300,
        "subtotal": 80600
      }
    ],
    "neto": 177355,
    "iva": 37245,
    "total": 214600,
    "cae": "780113902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8012",
    "numero": "0001-00008012",
    "tipo": "B",
    "ventaId": "sale_1011",
    "ventaNumero": "V-1011",
    "fecha": "2026-06-29",
    "cliente": {
      "nombre": "María Paz Gómez",
      "cuitDni": "27-33445566-3",
      "telefono": "1156789012",
      "email": "mpgomez@gmail.com"
    },
    "items": [
      {
        "sku": "ISUMAECAMNEGM",
        "skuAgrupador": "ISUMAECAM",
        "titulo": "MAEV Campera Mujer Negro",
        "talle": "M",
        "color": "Negro",
        "cantidad": 3,
        "precioUnitario": 40300,
        "subtotal": 120900
      }
    ],
    "neto": 99917,
    "iva": 20983,
    "total": 120900,
    "cae": "780123902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8013",
    "numero": "0001-00008013",
    "tipo": "A",
    "ventaId": "sale_1017",
    "ventaNumero": "V-1017",
    "fecha": "2026-06-20",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "items": [
      {
        "sku": "ISUWOLCAMCHOS",
        "skuAgrupador": "ISUWOLCAM",
        "titulo": "WOLF Campera Hombre Chocolate",
        "talle": "S",
        "color": "Chocolate",
        "cantidad": 2,
        "precioUnitario": 40700,
        "subtotal": 81400
      },
      {
        "sku": "ISURUMSHONEG2XL",
        "skuAgrupador": "ISURUMSHO",
        "titulo": "RUM Short Hombre Negro",
        "talle": "2XL",
        "color": "Negro",
        "cantidad": 4,
        "precioUnitario": 12500,
        "subtotal": 50000
      }
    ],
    "neto": 108595,
    "iva": 22805,
    "total": 131400,
    "cae": "780133902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8014",
    "numero": "0001-00008014",
    "tipo": "B",
    "ventaId": "sale_1028",
    "ventaNumero": "V-1028",
    "fecha": "2026-06-17",
    "cliente": {
      "nombre": "Julián Ferreyra",
      "cuitDni": "20-38221144-0",
      "telefono": "1167891234",
      "email": "julian.ferreyra@outlook.com"
    },
    "items": [
      {
        "sku": "ISUBAGPANNEGXL",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 2,
        "precioUnitario": 26000,
        "subtotal": 52000
      },
      {
        "sku": "ISUFLUPANNEG2XL",
        "skuAgrupador": "ISUFLUPAN",
        "titulo": "FLUGI Pantalon Unisex Negro",
        "talle": "2XL",
        "color": "Negro",
        "cantidad": 1,
        "precioUnitario": 25900,
        "subtotal": 25900
      }
    ],
    "neto": 64380,
    "iva": 13520,
    "total": 77900,
    "cae": "780143902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8015",
    "numero": "0001-00008015",
    "tipo": "B",
    "ventaId": "sale_1025",
    "ventaNumero": "V-1025",
    "fecha": "2026-06-16",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "items": [
      {
        "sku": "ISUMONCAMNEGXL",
        "skuAgrupador": "ISUMONCAM",
        "titulo": "MONTERO Campera Unisex Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 1,
        "precioUnitario": 45700,
        "subtotal": 45700
      },
      {
        "sku": "ISURUMSHONEGL",
        "skuAgrupador": "ISURUMSHO",
        "titulo": "RUM Short Hombre Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 6,
        "precioUnitario": 14000,
        "subtotal": 84000
      }
    ],
    "neto": 107190,
    "iva": 22510,
    "total": 129700,
    "cae": "780153902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8016",
    "numero": "0001-00008016",
    "tipo": "B",
    "ventaId": "sale_1047",
    "ventaNumero": "V-1047",
    "fecha": "2026-06-15",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "items": [
      {
        "sku": "ISUMONCAMNEG3XL",
        "skuAgrupador": "ISUMONCAM",
        "titulo": "MONTERO Campera Unisex Negro",
        "talle": "3XL",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 42350,
        "subtotal": 211750
      },
      {
        "sku": "ISURUMSHONEGXL",
        "skuAgrupador": "ISURUMSHO",
        "titulo": "RUM Short Hombre Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 3,
        "precioUnitario": 11900,
        "subtotal": 35700
      },
      {
        "sku": "ISUFLUPANNEGM",
        "skuAgrupador": "ISUFLUPAN",
        "titulo": "FLUGI Pantalon Unisex Negro",
        "talle": "M",
        "color": "Negro",
        "cantidad": 1,
        "precioUnitario": 24400,
        "subtotal": 24400
      },
      {
        "sku": "ISUMIRREMAAZL",
        "skuAgrupador": "ISUMIRREM",
        "titulo": "MIRRA Remera Unisex Azul",
        "talle": "L",
        "color": "Azul",
        "cantidad": 6,
        "precioUnitario": 10400,
        "subtotal": 62400
      }
    ],
    "neto": 276240,
    "iva": 58010,
    "total": 334250,
    "cae": "780163902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8017",
    "numero": "0001-00008017",
    "tipo": "A",
    "ventaId": "sale_1045",
    "ventaNumero": "V-1045",
    "fecha": "2026-06-13",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "items": [
      {
        "sku": "ISUBRIREMNEGS",
        "skuAgrupador": "ISUBRIREM",
        "titulo": "BORDI Remera Hombre Negro",
        "talle": "S",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 10200,
        "subtotal": 51000
      },
      {
        "sku": "ISUPOLBUZNEG2XL",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Negro",
        "talle": "2XL",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 25650,
        "subtotal": 128250
      },
      {
        "sku": "ISUPOLBUZBEIM",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Beish",
        "talle": "M",
        "color": "Beish",
        "cantidad": 5,
        "precioUnitario": 22100,
        "subtotal": 110500
      },
      {
        "sku": "ISUMONBUZTOS2XL",
        "skuAgrupador": "ISUMONBUZ",
        "titulo": "MONACO Buzo Unisex Tostado",
        "talle": "2XL",
        "color": "Tostado",
        "cantidad": 4,
        "precioUnitario": 26650,
        "subtotal": 106600
      }
    ],
    "neto": 327562,
    "iva": 68788,
    "total": 396350,
    "cae": "780173902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8018",
    "numero": "0001-00008018",
    "tipo": "B",
    "ventaId": "sale_1048",
    "ventaNumero": "V-1048",
    "fecha": "2026-06-10",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "items": [
      {
        "sku": "ISUBOXPANVER14",
        "skuAgrupador": "ISUBOXPAN",
        "titulo": "BOX Pantalon Niño VERDE ESCOLAR/VERDE INGLES",
        "talle": "14",
        "color": "VERDE ESCOLAR/VERDE INGLES",
        "cantidad": 1,
        "precioUnitario": 29100,
        "subtotal": 29100
      },
      {
        "sku": "ISUCHEREMNEGL",
        "skuAgrupador": "ISUCHEREM",
        "titulo": "CHERRY Remera Mujer Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 8750,
        "subtotal": 43750
      }
    ],
    "neto": 60207,
    "iva": 12643,
    "total": 72850,
    "cae": "780183902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8019",
    "numero": "0001-00008019",
    "tipo": "B",
    "ventaId": "sale_1024",
    "ventaNumero": "V-1024",
    "fecha": "2026-05-31",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "items": [
      {
        "sku": "ISUBAGPANNEGXL",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 2,
        "precioUnitario": 26000,
        "subtotal": 52000
      },
      {
        "sku": "ISUMISCAMNEG6",
        "skuAgrupador": "ISUMISCAM",
        "titulo": "MISTICA Campera Niño Negro",
        "talle": "6",
        "color": "Negro",
        "cantidad": 6,
        "precioUnitario": 46950,
        "subtotal": 281700
      },
      {
        "sku": "ISUJUNSHOBLA8",
        "skuAgrupador": "ISUJUNSHO",
        "titulo": "JUNIOR Short Mujer Blanco",
        "talle": "8",
        "color": "Blanco",
        "cantidad": 4,
        "precioUnitario": 13450,
        "subtotal": 53800
      }
    ],
    "neto": 320248,
    "iva": 67252,
    "total": 387500,
    "cae": "780193902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8020",
    "numero": "0001-00008020",
    "tipo": "B",
    "ventaId": "sale_1001",
    "ventaNumero": "V-1001",
    "fecha": "2026-05-30",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "items": [
      {
        "sku": "ISUCHEREMBLAXS",
        "skuAgrupador": "ISUCHEREM",
        "titulo": "CHERRY Remera Mujer Blanco",
        "talle": "XS",
        "color": "Blanco",
        "cantidad": 4,
        "precioUnitario": 10650,
        "subtotal": 42600
      },
      {
        "sku": "ISUMONCAMNEG3XL",
        "skuAgrupador": "ISUMONCAM",
        "titulo": "MONTERO Campera Unisex Negro",
        "talle": "3XL",
        "color": "Negro",
        "cantidad": 6,
        "precioUnitario": 42350,
        "subtotal": 254100
      }
    ],
    "neto": 220686,
    "iva": 46344,
    "total": 267030,
    "cae": "780203902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8021",
    "numero": "0001-00008021",
    "tipo": "A",
    "ventaId": "sale_1027",
    "ventaNumero": "V-1027",
    "fecha": "2026-05-30",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "items": [
      {
        "sku": "ISUJUNSHOBLA14",
        "skuAgrupador": "ISUJUNSHO",
        "titulo": "JUNIOR Short Mujer Blanco",
        "talle": "14",
        "color": "Blanco",
        "cantidad": 5,
        "precioUnitario": 13550,
        "subtotal": 67750
      }
    ],
    "neto": 55992,
    "iva": 11758,
    "total": 67750,
    "cae": "780213902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8022",
    "numero": "0001-00008022",
    "tipo": "B",
    "ventaId": "sale_1005",
    "ventaNumero": "V-1005",
    "fecha": "2026-05-29",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "items": [
      {
        "sku": "ISUJUNSHOBLA8",
        "skuAgrupador": "ISUJUNSHO",
        "titulo": "JUNIOR Short Mujer Blanco",
        "talle": "8",
        "color": "Blanco",
        "cantidad": 3,
        "precioUnitario": 13450,
        "subtotal": 40350
      }
    ],
    "neto": 33347,
    "iva": 7003,
    "total": 40350,
    "cae": "780223902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8023",
    "numero": "0001-00008023",
    "tipo": "A",
    "ventaId": "sale_1035",
    "ventaNumero": "V-1035",
    "fecha": "2026-05-27",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "items": [
      {
        "sku": "ISUMONCAMNEGXL",
        "skuAgrupador": "ISUMONCAM",
        "titulo": "MONTERO Campera Unisex Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 2,
        "precioUnitario": 45700,
        "subtotal": 91400
      },
      {
        "sku": "ISUBOXPANVER8",
        "skuAgrupador": "ISUBOXPAN",
        "titulo": "BOX Pantalon Niño VERDE ESCOLAR/VERDE INGLES",
        "talle": "8",
        "color": "VERDE ESCOLAR/VERDE INGLES",
        "cantidad": 4,
        "precioUnitario": 29350,
        "subtotal": 117400
      },
      {
        "sku": "ISUMISCAMNEG12",
        "skuAgrupador": "ISUMISCAM",
        "titulo": "MISTICA Campera Niño Negro",
        "talle": "12",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 45300,
        "subtotal": 226500
      },
      {
        "sku": "ISUWOLCAMCHOS",
        "skuAgrupador": "ISUWOLCAM",
        "titulo": "WOLF Campera Hombre Chocolate",
        "talle": "S",
        "color": "Chocolate",
        "cantidad": 5,
        "precioUnitario": 40700,
        "subtotal": 203500
      }
    ],
    "neto": 527934,
    "iva": 110866,
    "total": 638800,
    "cae": "780233902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8024",
    "numero": "0001-00008024",
    "tipo": "B",
    "ventaId": "sale_1034",
    "ventaNumero": "V-1034",
    "fecha": "2026-05-25",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "items": [
      {
        "sku": "ISUFLUPANNEGS",
        "skuAgrupador": "ISUFLUPAN",
        "titulo": "FLUGI Pantalon Unisex Negro",
        "talle": "S",
        "color": "Negro",
        "cantidad": 1,
        "precioUnitario": 28300,
        "subtotal": 28300
      }
    ],
    "neto": 23388,
    "iva": 4912,
    "total": 28300,
    "cae": "780243902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8025",
    "numero": "0001-00008025",
    "tipo": "B",
    "ventaId": "sale_1036",
    "ventaNumero": "V-1036",
    "fecha": "2026-05-21",
    "cliente": {
      "nombre": "María Paz Gómez",
      "cuitDni": "27-33445566-3",
      "telefono": "1156789012",
      "email": "mpgomez@gmail.com"
    },
    "items": [
      {
        "sku": "ISUMAECAMNEGM",
        "skuAgrupador": "ISUMAECAM",
        "titulo": "MAEV Campera Mujer Negro",
        "talle": "M",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 40300,
        "subtotal": 201500
      },
      {
        "sku": "ISUMIRREMAAZL",
        "skuAgrupador": "ISUMIRREM",
        "titulo": "MIRRA Remera Unisex Azul",
        "talle": "L",
        "color": "Azul",
        "cantidad": 5,
        "precioUnitario": 10400,
        "subtotal": 52000
      },
      {
        "sku": "ISUSIDPANNEGL",
        "skuAgrupador": "ISUSIDPAN",
        "titulo": "SIDNEY Pantalon Mujer Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 3,
        "precioUnitario": 27850,
        "subtotal": 83550
      },
      {
        "sku": "ISUCHEREMNEGXS",
        "skuAgrupador": "ISUCHEREM",
        "titulo": "CHERRY Remera Mujer Negro",
        "talle": "XS",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 10000,
        "subtotal": 50000
      }
    ],
    "neto": 303883,
    "iva": 63815,
    "total": 367698,
    "cae": "780253902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8026",
    "numero": "0001-00008026",
    "tipo": "B",
    "ventaId": "sale_1016",
    "ventaNumero": "V-1016",
    "fecha": "2026-05-16",
    "cliente": {
      "nombre": "María Paz Gómez",
      "cuitDni": "27-33445566-3",
      "telefono": "1156789012",
      "email": "mpgomez@gmail.com"
    },
    "items": [
      {
        "sku": "ISUMIRREMAAZL",
        "skuAgrupador": "ISUMIRREM",
        "titulo": "MIRRA Remera Unisex Azul",
        "talle": "L",
        "color": "Azul",
        "cantidad": 1,
        "precioUnitario": 10400,
        "subtotal": 10400
      },
      {
        "sku": "ISUPOLBUZNEGXL",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 3,
        "precioUnitario": 22950,
        "subtotal": 68850
      }
    ],
    "neto": 62221,
    "iva": 13067,
    "total": 75288,
    "cae": "780263902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  },
  {
    "id": "inv_8027",
    "numero": "0001-00008027",
    "tipo": "A",
    "ventaId": "sale_1041",
    "ventaNumero": "V-1041",
    "fecha": "2026-05-13",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "items": [
      {
        "sku": "ISUMIRREMAAZM",
        "skuAgrupador": "ISUMIRREM",
        "titulo": "MIRRA Remera Unisex Azul",
        "talle": "M",
        "color": "Azul",
        "cantidad": 4,
        "precioUnitario": 8650,
        "subtotal": 34600
      },
      {
        "sku": "ISUMISCAMNEG14",
        "skuAgrupador": "ISUMISCAM",
        "titulo": "MISTICA Campera Niño Negro",
        "talle": "14",
        "color": "Negro",
        "cantidad": 1,
        "precioUnitario": 48250,
        "subtotal": 48250
      },
      {
        "sku": "ISUMONBUZTOSM",
        "skuAgrupador": "ISUMONBUZ",
        "titulo": "MONACO Buzo Unisex Tostado",
        "talle": "M",
        "color": "Tostado",
        "cantidad": 4,
        "precioUnitario": 27450,
        "subtotal": 109800
      }
    ],
    "neto": 151255,
    "iva": 31763,
    "total": 183018,
    "cae": "780273902",
    "caeVencimiento": "2026-08-10",
    "estado": "emitida"
  }
];

export const seedReceipts = [
  {
    "id": "rec_5001",
    "numero": "R-5001",
    "facturaId": "inv_8001",
    "ventaId": "sale_1037",
    "fecha": "2026-07-26",
    "cliente": "Textil Belgrano SRL",
    "monto": 77760,
    "medioPago": "Tarjeta de crédito"
  },
  {
    "id": "rec_5002",
    "numero": "R-5002",
    "facturaId": "inv_8002",
    "ventaId": "sale_1040",
    "fecha": "2026-07-22",
    "cliente": "Indumentaria Norte",
    "monto": 215400,
    "medioPago": "Tarjeta de crédito"
  },
  {
    "id": "rec_5003",
    "numero": "R-5003",
    "facturaId": "inv_8003",
    "ventaId": "sale_1033",
    "fecha": "2026-07-15",
    "cliente": "Ropa Andina S.A.",
    "monto": 98278,
    "medioPago": "Tarjeta de débito"
  },
  {
    "id": "rec_5004",
    "numero": "R-5004",
    "facturaId": "inv_8004",
    "ventaId": "sale_1006",
    "fecha": "2026-07-13",
    "cliente": "Textil Belgrano SRL",
    "monto": 247200,
    "medioPago": "Tarjeta de crédito"
  },
  {
    "id": "rec_5005",
    "numero": "R-5005",
    "facturaId": "inv_8005",
    "ventaId": "sale_1008",
    "fecha": "2026-07-11",
    "cliente": "Indumentaria Norte",
    "monto": 24748,
    "medioPago": "Mercado Pago"
  },
  {
    "id": "rec_5006",
    "numero": "R-5006",
    "facturaId": "inv_8006",
    "ventaId": "sale_1020",
    "fecha": "2026-07-10",
    "cliente": "María Paz Gómez",
    "monto": 183000,
    "medioPago": "Transferencia"
  },
  {
    "id": "rec_5007",
    "numero": "R-5007",
    "facturaId": "inv_8007",
    "ventaId": "sale_1002",
    "fecha": "2026-07-08",
    "cliente": "Ropa Andina S.A.",
    "monto": 91770,
    "medioPago": "Efectivo"
  },
  {
    "id": "rec_5008",
    "numero": "R-5008",
    "facturaId": "inv_8008",
    "ventaId": "sale_1031",
    "fecha": "2026-07-06",
    "cliente": "Julián Ferreyra",
    "monto": 363800,
    "medioPago": "Transferencia"
  },
  {
    "id": "rec_5009",
    "numero": "R-5009",
    "facturaId": "inv_8009",
    "ventaId": "sale_1046",
    "fecha": "2026-07-06",
    "cliente": "Julián Ferreyra",
    "monto": 29350,
    "medioPago": "Transferencia"
  },
  {
    "id": "rec_5010",
    "numero": "R-5010",
    "facturaId": "inv_8010",
    "ventaId": "sale_1043",
    "fecha": "2026-07-03",
    "cliente": "Ropa Andina S.A.",
    "monto": 61700,
    "medioPago": "Tarjeta de crédito"
  },
  {
    "id": "rec_5011",
    "numero": "R-5011",
    "facturaId": "inv_8011",
    "ventaId": "sale_1042",
    "fecha": "2026-06-30",
    "cliente": "Ropa Andina S.A.",
    "monto": 214600,
    "medioPago": "Tarjeta de débito"
  },
  {
    "id": "rec_5012",
    "numero": "R-5012",
    "facturaId": "inv_8012",
    "ventaId": "sale_1011",
    "fecha": "2026-06-29",
    "cliente": "María Paz Gómez",
    "monto": 120900,
    "medioPago": "Efectivo"
  },
  {
    "id": "rec_5013",
    "numero": "R-5013",
    "facturaId": "inv_8013",
    "ventaId": "sale_1017",
    "fecha": "2026-06-20",
    "cliente": "Ropa Andina S.A.",
    "monto": 131400,
    "medioPago": "Mercado Pago"
  },
  {
    "id": "rec_5014",
    "numero": "R-5014",
    "facturaId": "inv_8014",
    "ventaId": "sale_1028",
    "fecha": "2026-06-17",
    "cliente": "Julián Ferreyra",
    "monto": 77900,
    "medioPago": "Transferencia"
  },
  {
    "id": "rec_5015",
    "numero": "R-5015",
    "facturaId": "inv_8015",
    "ventaId": "sale_1025",
    "fecha": "2026-06-16",
    "cliente": "Indumentaria Norte",
    "monto": 129700,
    "medioPago": "Efectivo"
  },
  {
    "id": "rec_5016",
    "numero": "R-5016",
    "facturaId": "inv_8016",
    "ventaId": "sale_1047",
    "fecha": "2026-06-15",
    "cliente": "Boutique Alma",
    "monto": 334250,
    "medioPago": "Tarjeta de crédito"
  },
  {
    "id": "rec_5017",
    "numero": "R-5017",
    "facturaId": "inv_8017",
    "ventaId": "sale_1045",
    "fecha": "2026-06-13",
    "cliente": "Textil Belgrano SRL",
    "monto": 396350,
    "medioPago": "Efectivo"
  },
  {
    "id": "rec_5018",
    "numero": "R-5018",
    "facturaId": "inv_8018",
    "ventaId": "sale_1048",
    "fecha": "2026-06-10",
    "cliente": "Boutique Alma",
    "monto": 72850,
    "medioPago": "Tarjeta de crédito"
  },
  {
    "id": "rec_5019",
    "numero": "R-5019",
    "facturaId": "inv_8019",
    "ventaId": "sale_1024",
    "fecha": "2026-05-31",
    "cliente": "Indumentaria Norte",
    "monto": 387500,
    "medioPago": "Mercado Pago"
  },
  {
    "id": "rec_5020",
    "numero": "R-5020",
    "facturaId": "inv_8020",
    "ventaId": "sale_1001",
    "fecha": "2026-05-30",
    "cliente": "Boutique Alma",
    "monto": 267030,
    "medioPago": "Tarjeta de débito"
  },
  {
    "id": "rec_5021",
    "numero": "R-5021",
    "facturaId": "inv_8021",
    "ventaId": "sale_1027",
    "fecha": "2026-05-30",
    "cliente": "Textil Belgrano SRL",
    "monto": 67750,
    "medioPago": "Tarjeta de débito"
  },
  {
    "id": "rec_5022",
    "numero": "R-5022",
    "facturaId": "inv_8022",
    "ventaId": "sale_1005",
    "fecha": "2026-05-29",
    "cliente": "Boutique Alma",
    "monto": 40350,
    "medioPago": "Mercado Pago"
  },
  {
    "id": "rec_5023",
    "numero": "R-5023",
    "facturaId": "inv_8023",
    "ventaId": "sale_1035",
    "fecha": "2026-05-27",
    "cliente": "Ropa Andina S.A.",
    "monto": 638800,
    "medioPago": "Efectivo"
  },
  {
    "id": "rec_5024",
    "numero": "R-5024",
    "facturaId": "inv_8024",
    "ventaId": "sale_1034",
    "fecha": "2026-05-25",
    "cliente": "Indumentaria Norte",
    "monto": 28300,
    "medioPago": "Efectivo"
  },
  {
    "id": "rec_5025",
    "numero": "R-5025",
    "facturaId": "inv_8025",
    "ventaId": "sale_1036",
    "fecha": "2026-05-21",
    "cliente": "María Paz Gómez",
    "monto": 367698,
    "medioPago": "Mercado Pago"
  },
  {
    "id": "rec_5026",
    "numero": "R-5026",
    "facturaId": "inv_8026",
    "ventaId": "sale_1016",
    "fecha": "2026-05-16",
    "cliente": "María Paz Gómez",
    "monto": 75288,
    "medioPago": "Efectivo"
  },
  {
    "id": "rec_5027",
    "numero": "R-5027",
    "facturaId": "inv_8027",
    "ventaId": "sale_1041",
    "fecha": "2026-05-13",
    "cliente": "Ropa Andina S.A.",
    "monto": 183018,
    "medioPago": "Mercado Pago"
  }
];
