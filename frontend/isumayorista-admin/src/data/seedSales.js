// Ventas y cotizaciones de ejemplo (48 registros, últimos ~75 días)
// generadas sobre los productos reales del seed. Alimentan el módulo
// de Ventas y las métricas del Dashboard.
export const seedSales = [
  {
    "id": "sale_1010",
    "numero": "COT-1010",
    "tipo": "cotizacion",
    "fecha": "2026-07-26",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
    "items": [
      {
        "sku": "ISUPOLBUZNEGXL",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 4,
        "precioUnitario": 22950,
        "subtotal": 91800
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
        "sku": "ISUCHEREMBLAXS",
        "skuAgrupador": "ISUCHEREM",
        "titulo": "CHERRY Remera Mujer Blanco",
        "talle": "XS",
        "color": "Blanco",
        "cantidad": 6,
        "precioUnitario": 10650,
        "subtotal": 63900
      }
    ],
    "subtotal": 207700,
    "descuentoPct": 10,
    "descuento": 20770,
    "total": 186930,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1037",
    "numero": "V-1037",
    "tipo": "venta",
    "fecha": "2026-07-26",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
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
    "subtotal": 86400,
    "descuentoPct": 10,
    "descuento": 8640,
    "total": 77760,
    "estado": "pagado",
    "medioPago": "Tarjeta de crédito",
    "notas": ""
  },
  {
    "id": "sale_1003",
    "numero": "COT-1003",
    "tipo": "cotizacion",
    "fecha": "2026-07-25",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_1",
    "empleadoNombre": "Marina Sosa",
    "posId": "pos_deposito",
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
      }
    ],
    "subtotal": 19800,
    "descuentoPct": 10,
    "descuento": 1980,
    "total": 17820,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1040",
    "numero": "V-1040",
    "tipo": "venta",
    "fecha": "2026-07-22",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
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
    "subtotal": 215400,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 215400,
    "estado": "pagado",
    "medioPago": "Tarjeta de crédito",
    "notas": ""
  },
  {
    "id": "sale_1033",
    "numero": "V-1033",
    "tipo": "venta",
    "fecha": "2026-07-15",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
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
    "subtotal": 103450,
    "descuentoPct": 5,
    "descuento": 5172,
    "total": 98278,
    "estado": "pagado",
    "medioPago": "Tarjeta de débito",
    "notas": ""
  },
  {
    "id": "sale_1038",
    "numero": "V-1038",
    "tipo": "venta",
    "fecha": "2026-07-15",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
    "items": [
      {
        "sku": "ISUBAGPANNEG2XL",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Negro",
        "talle": "2XL",
        "color": "Negro",
        "cantidad": 4,
        "precioUnitario": 29900,
        "subtotal": 119600
      },
      {
        "sku": "ISUBAGPANNEGXL",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 4,
        "precioUnitario": 26000,
        "subtotal": 104000
      },
      {
        "sku": "ISUJUNSHOBLA12",
        "skuAgrupador": "ISUJUNSHO",
        "titulo": "JUNIOR Short Mujer Blanco",
        "talle": "12",
        "color": "Blanco",
        "cantidad": 2,
        "precioUnitario": 13250,
        "subtotal": 26500
      },
      {
        "sku": "ISUJUNSHOBLA6",
        "skuAgrupador": "ISUJUNSHO",
        "titulo": "JUNIOR Short Mujer Blanco",
        "talle": "6",
        "color": "Blanco",
        "cantidad": 3,
        "precioUnitario": 11900,
        "subtotal": 35700
      }
    ],
    "subtotal": 285800,
    "descuentoPct": 5,
    "descuento": 14290,
    "total": 271510,
    "estado": "cancelado",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1006",
    "numero": "V-1006",
    "tipo": "venta",
    "fecha": "2026-07-13",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
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
    "subtotal": 247200,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 247200,
    "estado": "pagado",
    "medioPago": "Tarjeta de crédito",
    "notas": ""
  },
  {
    "id": "sale_1026",
    "numero": "V-1026",
    "tipo": "venta",
    "fecha": "2026-07-12",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
    "items": [
      {
        "sku": "ISUMIRREMAAZXL",
        "skuAgrupador": "ISUMIRREM",
        "titulo": "MIRRA Remera Unisex Azul",
        "talle": "XL",
        "color": "Azul",
        "cantidad": 6,
        "precioUnitario": 10600,
        "subtotal": 63600
      },
      {
        "sku": "ISUBAGPANNEG2XL",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Negro",
        "talle": "2XL",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 29900,
        "subtotal": 149500
      },
      {
        "sku": "ISUBAGPANNEGS",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Negro",
        "talle": "S",
        "color": "Negro",
        "cantidad": 4,
        "precioUnitario": 24300,
        "subtotal": 97200
      }
    ],
    "subtotal": 310300,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 310300,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1029",
    "numero": "V-1029",
    "tipo": "venta",
    "fecha": "2026-07-12",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
    "items": [
      {
        "sku": "ISUWOLCAMCELXL",
        "skuAgrupador": "ISUWOLCAM",
        "titulo": "WOLF Campera Hombre Celeste",
        "talle": "XL",
        "color": "Celeste",
        "cantidad": 2,
        "precioUnitario": 45150,
        "subtotal": 90300
      },
      {
        "sku": "ISUMISCAMNEG10",
        "skuAgrupador": "ISUMISCAM",
        "titulo": "MISTICA Campera Niño Negro",
        "talle": "10",
        "color": "Negro",
        "cantidad": 4,
        "precioUnitario": 45750,
        "subtotal": 183000
      },
      {
        "sku": "ISUMIRREMAAZM",
        "skuAgrupador": "ISUMIRREM",
        "titulo": "MIRRA Remera Unisex Azul",
        "talle": "M",
        "color": "Azul",
        "cantidad": 3,
        "precioUnitario": 8650,
        "subtotal": 25950
      }
    ],
    "subtotal": 299250,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 299250,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1008",
    "numero": "V-1008",
    "tipo": "venta",
    "fecha": "2026-07-11",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
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
    "subtotal": 26050,
    "descuentoPct": 5,
    "descuento": 1302,
    "total": 24748,
    "estado": "pagado",
    "medioPago": "Mercado Pago",
    "notas": ""
  },
  {
    "id": "sale_1020",
    "numero": "V-1020",
    "tipo": "venta",
    "fecha": "2026-07-10",
    "cliente": {
      "nombre": "María Paz Gómez",
      "cuitDni": "27-33445566-3",
      "telefono": "1156789012",
      "email": "mpgomez@gmail.com"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
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
    "subtotal": 183000,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 183000,
    "estado": "pagado",
    "medioPago": "Transferencia",
    "notas": ""
  },
  {
    "id": "sale_1018",
    "numero": "COT-1018",
    "tipo": "cotizacion",
    "fecha": "2026-07-09",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_1",
    "empleadoNombre": "Marina Sosa",
    "posId": "pos_deposito",
    "items": [
      {
        "sku": "ISURUMSHONEGXL",
        "skuAgrupador": "ISURUMSHO",
        "titulo": "RUM Short Hombre Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 1,
        "precioUnitario": 11900,
        "subtotal": 11900
      },
      {
        "sku": "ISUMISCAMNEG14",
        "skuAgrupador": "ISUMISCAM",
        "titulo": "MISTICA Campera Niño Negro",
        "talle": "14",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 48250,
        "subtotal": 241250
      },
      {
        "sku": "ISUSIDPANNEGXL",
        "skuAgrupador": "ISUSIDPAN",
        "titulo": "SIDNEY Pantalon Mujer Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 6,
        "precioUnitario": 27850,
        "subtotal": 167100
      },
      {
        "sku": "ISUPOLBUZBEIM",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Beish",
        "talle": "M",
        "color": "Beish",
        "cantidad": 1,
        "precioUnitario": 22100,
        "subtotal": 22100
      }
    ],
    "subtotal": 442350,
    "descuentoPct": 5,
    "descuento": 22118,
    "total": 420232,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1002",
    "numero": "V-1002",
    "tipo": "venta",
    "fecha": "2026-07-08",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "empleadoId": "emp_1",
    "empleadoNombre": "Marina Sosa",
    "posId": "pos_deposito",
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
    "subtotal": 96600,
    "descuentoPct": 5,
    "descuento": 4830,
    "total": 91770,
    "estado": "pagado",
    "medioPago": "Efectivo",
    "notas": ""
  },
  {
    "id": "sale_1031",
    "numero": "V-1031",
    "tipo": "venta",
    "fecha": "2026-07-06",
    "cliente": {
      "nombre": "Julián Ferreyra",
      "cuitDni": "20-38221144-0",
      "telefono": "1167891234",
      "email": "julian.ferreyra@outlook.com"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
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
    "subtotal": 363800,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 363800,
    "estado": "pagado",
    "medioPago": "Transferencia",
    "notas": ""
  },
  {
    "id": "sale_1046",
    "numero": "V-1046",
    "tipo": "venta",
    "fecha": "2026-07-06",
    "cliente": {
      "nombre": "Julián Ferreyra",
      "cuitDni": "20-38221144-0",
      "telefono": "1167891234",
      "email": "julian.ferreyra@outlook.com"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
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
    "subtotal": 29350,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 29350,
    "estado": "pagado",
    "medioPago": "Transferencia",
    "notas": ""
  },
  {
    "id": "sale_1013",
    "numero": "V-1013",
    "tipo": "venta",
    "fecha": "2026-07-03",
    "cliente": {
      "nombre": "María Paz Gómez",
      "cuitDni": "27-33445566-3",
      "telefono": "1156789012",
      "email": "mpgomez@gmail.com"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
    "items": [
      {
        "sku": "ISUMAECAMNEGM",
        "skuAgrupador": "ISUMAECAM",
        "titulo": "MAEV Campera Mujer Negro",
        "talle": "M",
        "color": "Negro",
        "cantidad": 6,
        "precioUnitario": 40300,
        "subtotal": 241800
      },
      {
        "sku": "ISUJUNSHOBLA6",
        "skuAgrupador": "ISUJUNSHO",
        "titulo": "JUNIOR Short Mujer Blanco",
        "talle": "6",
        "color": "Blanco",
        "cantidad": 2,
        "precioUnitario": 11900,
        "subtotal": 23800
      }
    ],
    "subtotal": 265600,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 265600,
    "estado": "cancelado",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1043",
    "numero": "V-1043",
    "tipo": "venta",
    "fecha": "2026-07-03",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
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
    "subtotal": 61700,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 61700,
    "estado": "pagado",
    "medioPago": "Tarjeta de crédito",
    "notas": ""
  },
  {
    "id": "sale_1009",
    "numero": "V-1009",
    "tipo": "venta",
    "fecha": "2026-07-02",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
    "items": [
      {
        "sku": "ISUBRIREMNEGXL",
        "skuAgrupador": "ISUBRIREM",
        "titulo": "BORDI Remera Hombre Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 6,
        "precioUnitario": 8800,
        "subtotal": 52800
      },
      {
        "sku": "ISUBAGPANMELS",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Grid Claro/Melang",
        "talle": "S",
        "color": "Grid Claro/Melang",
        "cantidad": 4,
        "precioUnitario": 26700,
        "subtotal": 106800
      }
    ],
    "subtotal": 159600,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 159600,
    "estado": "cancelado",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1014",
    "numero": "COT-1014",
    "tipo": "cotizacion",
    "fecha": "2026-07-01",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
    "items": [
      {
        "sku": "ISUBAGPANMELS",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Grid Claro/Melang",
        "talle": "S",
        "color": "Grid Claro/Melang",
        "cantidad": 1,
        "precioUnitario": 26700,
        "subtotal": 26700
      }
    ],
    "subtotal": 26700,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 26700,
    "estado": "vencida",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1042",
    "numero": "V-1042",
    "tipo": "venta",
    "fecha": "2026-06-30",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
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
    "subtotal": 214600,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 214600,
    "estado": "pagado",
    "medioPago": "Tarjeta de débito",
    "notas": ""
  },
  {
    "id": "sale_1011",
    "numero": "V-1011",
    "tipo": "venta",
    "fecha": "2026-06-29",
    "cliente": {
      "nombre": "María Paz Gómez",
      "cuitDni": "27-33445566-3",
      "telefono": "1156789012",
      "email": "mpgomez@gmail.com"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
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
    "subtotal": 120900,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 120900,
    "estado": "pagado",
    "medioPago": "Efectivo",
    "notas": ""
  },
  {
    "id": "sale_1023",
    "numero": "COT-1023",
    "tipo": "cotizacion",
    "fecha": "2026-06-27",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "empleadoId": "emp_1",
    "empleadoNombre": "Marina Sosa",
    "posId": "pos_deposito",
    "items": [
      {
        "sku": "ISUJUNSHOBLA8",
        "skuAgrupador": "ISUJUNSHO",
        "titulo": "JUNIOR Short Mujer Blanco",
        "talle": "8",
        "color": "Blanco",
        "cantidad": 2,
        "precioUnitario": 13450,
        "subtotal": 26900
      },
      {
        "sku": "ISUPOLBUZNEGL",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 6,
        "precioUnitario": 26050,
        "subtotal": 156300
      },
      {
        "sku": "ISURUMSHONEG3XL",
        "skuAgrupador": "ISURUMSHO",
        "titulo": "RUM Short Hombre Negro",
        "talle": "3XL",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 12700,
        "subtotal": 63500
      },
      {
        "sku": "ISUSIDPANNEGL",
        "skuAgrupador": "ISUSIDPAN",
        "titulo": "SIDNEY Pantalon Mujer Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 2,
        "precioUnitario": 27850,
        "subtotal": 55700
      }
    ],
    "subtotal": 302400,
    "descuentoPct": 10,
    "descuento": 30240,
    "total": 272160,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1015",
    "numero": "COT-1015",
    "tipo": "cotizacion",
    "fecha": "2026-06-24",
    "cliente": {
      "nombre": "Julián Ferreyra",
      "cuitDni": "20-38221144-0",
      "telefono": "1167891234",
      "email": "julian.ferreyra@outlook.com"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
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
      },
      {
        "sku": "ISUBAGPANMELS",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Grid Claro/Melang",
        "talle": "S",
        "color": "Grid Claro/Melang",
        "cantidad": 5,
        "precioUnitario": 26700,
        "subtotal": 133500
      },
      {
        "sku": "ISUBOXPANVER12",
        "skuAgrupador": "ISUBOXPAN",
        "titulo": "BOX Pantalon Niño VERDE ESCOLAR/VERDE INGLES",
        "talle": "12",
        "color": "VERDE ESCOLAR/VERDE INGLES",
        "cantidad": 2,
        "precioUnitario": 24150,
        "subtotal": 48300
      },
      {
        "sku": "ISUMONCAMNEGL",
        "skuAgrupador": "ISUMONCAM",
        "titulo": "MONTERO Campera Unisex Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 6,
        "precioUnitario": 44950,
        "subtotal": 269700
      }
    ],
    "subtotal": 491850,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 491850,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1017",
    "numero": "V-1017",
    "tipo": "venta",
    "fecha": "2026-06-20",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
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
    "subtotal": 131400,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 131400,
    "estado": "pagado",
    "medioPago": "Mercado Pago",
    "notas": ""
  },
  {
    "id": "sale_1028",
    "numero": "V-1028",
    "tipo": "venta",
    "fecha": "2026-06-17",
    "cliente": {
      "nombre": "Julián Ferreyra",
      "cuitDni": "20-38221144-0",
      "telefono": "1167891234",
      "email": "julian.ferreyra@outlook.com"
    },
    "empleadoId": "emp_1",
    "empleadoNombre": "Marina Sosa",
    "posId": "pos_deposito",
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
    "subtotal": 77900,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 77900,
    "estado": "pagado",
    "medioPago": "Transferencia",
    "notas": ""
  },
  {
    "id": "sale_1019",
    "numero": "V-1019",
    "tipo": "venta",
    "fecha": "2026-06-16",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
    "items": [
      {
        "sku": "ISUFLUPANNEGXL",
        "skuAgrupador": "ISUFLUPAN",
        "titulo": "FLUGI Pantalon Unisex Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 27300,
        "subtotal": 136500
      }
    ],
    "subtotal": 136500,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 136500,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1025",
    "numero": "V-1025",
    "tipo": "venta",
    "fecha": "2026-06-16",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
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
    "subtotal": 129700,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 129700,
    "estado": "pagado",
    "medioPago": "Efectivo",
    "notas": ""
  },
  {
    "id": "sale_1004",
    "numero": "COT-1004",
    "tipo": "cotizacion",
    "fecha": "2026-06-15",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
    "items": [
      {
        "sku": "ISUMONBUZTOSS",
        "skuAgrupador": "ISUMONBUZ",
        "titulo": "MONACO Buzo Unisex Tostado",
        "talle": "S",
        "color": "Tostado",
        "cantidad": 6,
        "precioUnitario": 21600,
        "subtotal": 129600
      },
      {
        "sku": "ISUMIRREMBEIS",
        "skuAgrupador": "ISUMIRREM",
        "titulo": "MIRRA Remera Unisex Beish",
        "talle": "S",
        "color": "Beish",
        "cantidad": 3,
        "precioUnitario": 10050,
        "subtotal": 30150
      }
    ],
    "subtotal": 159750,
    "descuentoPct": 5,
    "descuento": 7988,
    "total": 151762,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1047",
    "numero": "V-1047",
    "tipo": "venta",
    "fecha": "2026-06-15",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
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
    "subtotal": 334250,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 334250,
    "estado": "pagado",
    "medioPago": "Tarjeta de crédito",
    "notas": ""
  },
  {
    "id": "sale_1022",
    "numero": "COT-1022",
    "tipo": "cotizacion",
    "fecha": "2026-06-14",
    "cliente": {
      "nombre": "Julián Ferreyra",
      "cuitDni": "20-38221144-0",
      "telefono": "1167891234",
      "email": "julian.ferreyra@outlook.com"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
    "items": [
      {
        "sku": "ISUFLUPANNEGL",
        "skuAgrupador": "ISUFLUPAN",
        "titulo": "FLUGI Pantalon Unisex Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 28550,
        "subtotal": 142750
      },
      {
        "sku": "ISUFLUPANCELS",
        "skuAgrupador": "ISUFLUPAN",
        "titulo": "FLUGI Pantalon Unisex Celeste",
        "talle": "S",
        "color": "Celeste",
        "cantidad": 5,
        "precioUnitario": 26850,
        "subtotal": 134250
      },
      {
        "sku": "ISUMONBUZTOSXL",
        "skuAgrupador": "ISUMONBUZ",
        "titulo": "MONACO Buzo Unisex Tostado",
        "talle": "XL",
        "color": "Tostado",
        "cantidad": 1,
        "precioUnitario": 26800,
        "subtotal": 26800
      },
      {
        "sku": "ISUWOLCAMCEL2XL",
        "skuAgrupador": "ISUWOLCAM",
        "titulo": "WOLF Campera Hombre Celeste",
        "talle": "2XL",
        "color": "Celeste",
        "cantidad": 3,
        "precioUnitario": 40100,
        "subtotal": 120300
      }
    ],
    "subtotal": 424100,
    "descuentoPct": 10,
    "descuento": 42410,
    "total": 381690,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1045",
    "numero": "V-1045",
    "tipo": "venta",
    "fecha": "2026-06-13",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
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
    "subtotal": 396350,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 396350,
    "estado": "pagado",
    "medioPago": "Efectivo",
    "notas": ""
  },
  {
    "id": "sale_1048",
    "numero": "V-1048",
    "tipo": "venta",
    "fecha": "2026-06-10",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
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
    "subtotal": 72850,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 72850,
    "estado": "pagado",
    "medioPago": "Tarjeta de crédito",
    "notas": ""
  },
  {
    "id": "sale_1032",
    "numero": "V-1032",
    "tipo": "venta",
    "fecha": "2026-06-08",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
    "items": [
      {
        "sku": "ISUMAECAMAMAM",
        "skuAgrupador": "ISUMAECAM",
        "titulo": "MAEV Campera Mujer Amarillo",
        "talle": "M",
        "color": "Amarillo",
        "cantidad": 6,
        "precioUnitario": 44750,
        "subtotal": 268500
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
      },
      {
        "sku": "ISUBRIREMNEGXS",
        "skuAgrupador": "ISUBRIREM",
        "titulo": "BORDI Remera Hombre Negro",
        "talle": "XS",
        "color": "Negro",
        "cantidad": 6,
        "precioUnitario": 10350,
        "subtotal": 62100
      }
    ],
    "subtotal": 393000,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 393000,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1007",
    "numero": "V-1007",
    "tipo": "venta",
    "fecha": "2026-06-06",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
    "items": [
      {
        "sku": "ISUMISCAMNEG8",
        "skuAgrupador": "ISUMISCAM",
        "titulo": "MISTICA Campera Niño Negro",
        "talle": "8",
        "color": "Negro",
        "cantidad": 3,
        "precioUnitario": 47950,
        "subtotal": 143850
      },
      {
        "sku": "ISUJUNSHOBLA12",
        "skuAgrupador": "ISUJUNSHO",
        "titulo": "JUNIOR Short Mujer Blanco",
        "talle": "12",
        "color": "Blanco",
        "cantidad": 1,
        "precioUnitario": 13250,
        "subtotal": 13250
      }
    ],
    "subtotal": 157100,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 157100,
    "estado": "cancelado",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1024",
    "numero": "V-1024",
    "tipo": "venta",
    "fecha": "2026-05-31",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
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
    "subtotal": 387500,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 387500,
    "estado": "pagado",
    "medioPago": "Mercado Pago",
    "notas": ""
  },
  {
    "id": "sale_1001",
    "numero": "V-1001",
    "tipo": "venta",
    "fecha": "2026-05-30",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "empleadoId": "emp_5",
    "empleadoNombre": "Yamila Godoy",
    "posId": "pos_online",
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
    "subtotal": 296700,
    "descuentoPct": 10,
    "descuento": 29670,
    "total": 267030,
    "estado": "pagado",
    "medioPago": "Tarjeta de débito",
    "notas": ""
  },
  {
    "id": "sale_1027",
    "numero": "V-1027",
    "tipo": "venta",
    "fecha": "2026-05-30",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
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
    "subtotal": 67750,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 67750,
    "estado": "pagado",
    "medioPago": "Tarjeta de débito",
    "notas": ""
  },
  {
    "id": "sale_1005",
    "numero": "V-1005",
    "tipo": "venta",
    "fecha": "2026-05-29",
    "cliente": {
      "nombre": "Boutique Alma",
      "cuitDni": "30-69988776-5",
      "telefono": "3514567890",
      "email": "boutiquealma@hotmail.com"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
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
    "subtotal": 40350,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 40350,
    "estado": "pagado",
    "medioPago": "Mercado Pago",
    "notas": ""
  },
  {
    "id": "sale_1035",
    "numero": "V-1035",
    "tipo": "venta",
    "fecha": "2026-05-27",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
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
    "subtotal": 638800,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 638800,
    "estado": "pagado",
    "medioPago": "Efectivo",
    "notas": ""
  },
  {
    "id": "sale_1039",
    "numero": "V-1039",
    "tipo": "venta",
    "fecha": "2026-05-27",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
    "items": [
      {
        "sku": "ISUBAGPANMELS",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Grid Claro/Melang",
        "talle": "S",
        "color": "Grid Claro/Melang",
        "cantidad": 1,
        "precioUnitario": 26700,
        "subtotal": 26700
      },
      {
        "sku": "ISUMAECAMNEGL",
        "skuAgrupador": "ISUMAECAM",
        "titulo": "MAEV Campera Mujer Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 3,
        "precioUnitario": 47000,
        "subtotal": 141000
      }
    ],
    "subtotal": 167700,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 167700,
    "estado": "cancelado",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1034",
    "numero": "V-1034",
    "tipo": "venta",
    "fecha": "2026-05-25",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "empleadoId": "emp_1",
    "empleadoNombre": "Marina Sosa",
    "posId": "pos_deposito",
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
    "subtotal": 28300,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 28300,
    "estado": "pagado",
    "medioPago": "Efectivo",
    "notas": ""
  },
  {
    "id": "sale_1021",
    "numero": "V-1021",
    "tipo": "venta",
    "fecha": "2026-05-24",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "empleadoId": "emp_1",
    "empleadoNombre": "Marina Sosa",
    "posId": "pos_deposito",
    "items": [
      {
        "sku": "ISUBAGPANNEGS",
        "skuAgrupador": "ISUBAGPAN",
        "titulo": "BAGGY Pantalon Hombre Negro",
        "talle": "S",
        "color": "Negro",
        "cantidad": 1,
        "precioUnitario": 24300,
        "subtotal": 24300
      },
      {
        "sku": "ISUBOXPANVER8",
        "skuAgrupador": "ISUBOXPAN",
        "titulo": "BOX Pantalon Niño VERDE ESCOLAR/VERDE INGLES",
        "talle": "8",
        "color": "VERDE ESCOLAR/VERDE INGLES",
        "cantidad": 1,
        "precioUnitario": 29350,
        "subtotal": 29350
      },
      {
        "sku": "ISUPOLBUZNEGL",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 1,
        "precioUnitario": 26050,
        "subtotal": 26050
      },
      {
        "sku": "ISUBOXPANVER14",
        "skuAgrupador": "ISUBOXPAN",
        "titulo": "BOX Pantalon Niño VERDE ESCOLAR/VERDE INGLES",
        "talle": "14",
        "color": "VERDE ESCOLAR/VERDE INGLES",
        "cantidad": 6,
        "precioUnitario": 29100,
        "subtotal": 174600
      }
    ],
    "subtotal": 254300,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 254300,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1036",
    "numero": "V-1036",
    "tipo": "venta",
    "fecha": "2026-05-21",
    "cliente": {
      "nombre": "María Paz Gómez",
      "cuitDni": "27-33445566-3",
      "telefono": "1156789012",
      "email": "mpgomez@gmail.com"
    },
    "empleadoId": "emp_3",
    "empleadoNombre": "Camila Rearte",
    "posId": "pos_local2",
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
    "subtotal": 387050,
    "descuentoPct": 5,
    "descuento": 19352,
    "total": 367698,
    "estado": "pagado",
    "medioPago": "Mercado Pago",
    "notas": ""
  },
  {
    "id": "sale_1030",
    "numero": "V-1030",
    "tipo": "venta",
    "fecha": "2026-05-19",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "empleadoId": "emp_1",
    "empleadoNombre": "Marina Sosa",
    "posId": "pos_deposito",
    "items": [
      {
        "sku": "ISUJUNSHOBLA12",
        "skuAgrupador": "ISUJUNSHO",
        "titulo": "JUNIOR Short Mujer Blanco",
        "talle": "12",
        "color": "Blanco",
        "cantidad": 5,
        "precioUnitario": 13250,
        "subtotal": 66250
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
    "subtotal": 150250,
    "descuentoPct": 10,
    "descuento": 15025,
    "total": 135225,
    "estado": "cancelado",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1044",
    "numero": "COT-1044",
    "tipo": "cotizacion",
    "fecha": "2026-05-18",
    "cliente": {
      "nombre": "Indumentaria Norte",
      "cuitDni": "30-70123456-1",
      "telefono": "3794123456",
      "email": "pedidos@indunorte.com"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
    "items": [
      {
        "sku": "ISUMAECAMNEGXL",
        "skuAgrupador": "ISUMAECAM",
        "titulo": "MAEV Campera Mujer Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 2,
        "precioUnitario": 38700,
        "subtotal": 77400
      },
      {
        "sku": "ISUMISCAMNEG10",
        "skuAgrupador": "ISUMISCAM",
        "titulo": "MISTICA Campera Niño Negro",
        "talle": "10",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 45750,
        "subtotal": 228750
      },
      {
        "sku": "ISUPOLBUZNEGXL",
        "skuAgrupador": "ISUPOLBUZ",
        "titulo": "POLO Buzo Hombre Negro",
        "talle": "XL",
        "color": "Negro",
        "cantidad": 6,
        "precioUnitario": 22950,
        "subtotal": 137700
      },
      {
        "sku": "ISUBRIREMNEGXS",
        "skuAgrupador": "ISUBRIREM",
        "titulo": "BORDI Remera Hombre Negro",
        "talle": "XS",
        "color": "Negro",
        "cantidad": 3,
        "precioUnitario": 10350,
        "subtotal": 31050
      }
    ],
    "subtotal": 474900,
    "descuentoPct": 0,
    "descuento": 0,
    "total": 474900,
    "estado": "vencida",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1016",
    "numero": "V-1016",
    "tipo": "venta",
    "fecha": "2026-05-16",
    "cliente": {
      "nombre": "María Paz Gómez",
      "cuitDni": "27-33445566-3",
      "telefono": "1156789012",
      "email": "mpgomez@gmail.com"
    },
    "empleadoId": "emp_1",
    "empleadoNombre": "Marina Sosa",
    "posId": "pos_deposito",
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
    "subtotal": 79250,
    "descuentoPct": 5,
    "descuento": 3962,
    "total": 75288,
    "estado": "pagado",
    "medioPago": "Efectivo",
    "notas": ""
  },
  {
    "id": "sale_1012",
    "numero": "COT-1012",
    "tipo": "cotizacion",
    "fecha": "2026-05-13",
    "cliente": {
      "nombre": "Textil Belgrano SRL",
      "cuitDni": "30-71234567-9",
      "telefono": "1145671234",
      "email": "compras@textilbelgrano.com.ar"
    },
    "empleadoId": "emp_2",
    "empleadoNombre": "Federico Luna",
    "posId": "pos_local1",
    "items": [
      {
        "sku": "ISURUMSHONEG3XL",
        "skuAgrupador": "ISURUMSHO",
        "titulo": "RUM Short Hombre Negro",
        "talle": "3XL",
        "color": "Negro",
        "cantidad": 2,
        "precioUnitario": 12700,
        "subtotal": 25400
      },
      {
        "sku": "ISUMAECAMNEGL",
        "skuAgrupador": "ISUMAECAM",
        "titulo": "MAEV Campera Mujer Negro",
        "talle": "L",
        "color": "Negro",
        "cantidad": 5,
        "precioUnitario": 47000,
        "subtotal": 235000
      },
      {
        "sku": "ISUFLUPANNEG2XL",
        "skuAgrupador": "ISUFLUPAN",
        "titulo": "FLUGI Pantalon Unisex Negro",
        "talle": "2XL",
        "color": "Negro",
        "cantidad": 4,
        "precioUnitario": 25900,
        "subtotal": 103600
      }
    ],
    "subtotal": 364000,
    "descuentoPct": 10,
    "descuento": 36400,
    "total": 327600,
    "estado": "pendiente",
    "medioPago": null,
    "notas": ""
  },
  {
    "id": "sale_1041",
    "numero": "V-1041",
    "tipo": "venta",
    "fecha": "2026-05-13",
    "cliente": {
      "nombre": "Ropa Andina S.A.",
      "cuitDni": "30-68877665-4",
      "telefono": "2614456778",
      "email": "ventas@ropaandina.com"
    },
    "empleadoId": "emp_1",
    "empleadoNombre": "Marina Sosa",
    "posId": "pos_deposito",
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
    "subtotal": 192650,
    "descuentoPct": 5,
    "descuento": 9632,
    "total": 183018,
    "estado": "pagado",
    "medioPago": "Mercado Pago",
    "notas": ""
  }
];
