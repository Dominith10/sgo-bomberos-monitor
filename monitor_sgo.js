
'use strict';

// SGO Norte -> Firestore -> FCM.
// Las credenciales se obtienen mediante GitHub Secrets.
// No guardar claves privadas ni tokens en este repositorio.

const crypto = require('node:crypto');
const cheerio = require('cheerio');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// ==========================================
// CONFIGURACIÓN GENERAL
// ==========================================

const SOURCE = 'https://sgonorte.bomberosperu.gob.pe/24horas';

const STATE_DOC = 'monitor_control/sgo_norte_24h';

const MAX_RECORDS = 300;
const MAX_NEW = 40;
const MAX_FCM_RECIPIENTS = 1000;

const DRY_RUN = process.env.DRY_RUN !== 'false';
const RESET_BASELINE = process.env.RESET_BASELINE === 'true';

const TIMEOUT_MS = 20000;

// ==========================================
// FUNCIONES AUXILIARES
// ==========================================

function normalizeMachine(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hash(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex');
}

// ==========================================
// LEER LOS DESPACHOS DE SGO NORTE
// ==========================================

function readRows(html) {
  const $ = cheerio.load(html);

  const records = new Map();

  let candidateRows = 0;

  $('table tr').each((_index, tr) => {
    const cells = $(tr).children('td').toArray();

    if (cells.length < 6) return;

    candidateRows++;

    // Buscar el número de parte entre las
    // primeras tres columnas.
    const partIndex = cells
      .slice(0, 3)
      .findIndex(cell =>
        /^\d{8,20}$/.test(
          normalizeText($(cell).text())
        )
      );

    if (partIndex < 0) return;

    const part = normalizeText(
      $(cells[partIndex]).text()
    );

    const date = normalizeText(
      $(cells[partIndex + 1]).text()
    );

    const address = normalizeText(
      $(cells[partIndex + 2]).text()
    );

    const emergency = normalizeText(
      $(cells[partIndex + 3]).text()
    );

    const status = normalizeText(
      $(cells[partIndex + 4]).text()
    );

    const machineCell = cells[partIndex + 5];

    if (!machineCell || !date || !emergency) {
      return;
    }

    const $machines = $(machineCell);

    const rawMachines = $machines.find('li').length
      ? $machines.find('li')
          .map((_i, li) => $(li).text())
          .get()
      : $machines.text().split(/[\n,;]+/);

    const machines = [
      ...new Set(
        rawMachines
          .map(normalizeMachine)
          .filter(Boolean)
      )
    ];

    const previous = records.get(part);

    if (previous) {
      previous.machines = [
        ...new Set([
          ...previous.machines,
          ...machines
        ])
      ];
    } else {
      records.set(part, {
        part,
        date,
        address,
        emergency,
        status,
        machines
      });
    }
  });

  const rows = [...records.values()];

  console.log(
    `SGO lectura: ${candidateRows} filas candidatas, ` +
    `${rows.length} partes interpretados, ` +
    `${rows.filter(r => r.machines.length).length} con maquinas.`
  );

  if (
    !rows.length ||
    !rows.some(r => r.machines.length)
  ) {
    throw new Error(
      'No se pudo interpretar la tabla SGO ' +
      'de forma segura. Estado intacto.'
    );
  }

  if (rows.length > MAX_RECORDS) {
    throw new Error(
      `Cantidad inesperada de partes: ${rows.length}.`
    );
  }

  return rows;
}

// ==========================================
// CONSULTAR LA PÁGINA DE SGO
// ==========================================

async function getSGO() {
  const response = await fetch(SOURCE, {
    signal: AbortSignal.timeout(TIMEOUT_MS),

    headers: {
      'user-agent':
        'SGO-Bomberos-Monitor/1.0 ' +
        '(prototipo; consulta periodica)',
      accept: 'text/html'
    }
  });

  if (!response.ok) {
    throw new Error(
      `SGO HTTP ${response.status}`
    );
  }

  return readRows(
    await response.text()
  );
}

// ==========================================
// IDENTIFICADORES DE ASIGNACIONES
// ==========================================

function entries(rows) {
  const map = new Map();

  for (const record of rows) {
    for (const machine of record.machines) {
      const id = hash(
        `${record.part}|${machine}`
      ).slice(0, 32);

      map.set(id, {
        ...record,
        machine
      });
    }
  }

  return map;
}

// ==========================================
// ENVIAR NOTIFICACIONES FCM
// ==========================================

async function notifyFor(fresh, db) {
  const snapshot = await db
    .collection('users')
    .get();

  const recipients = [];

  for (const user of snapshot.docs) {
    const data = user.data();

    // Máquinas registradas por el bombero.
    const followed = new Set(
      (
        Array.isArray(data.machines)
          ? data.machines
          : []
      ).map(normalizeMachine)
    );

    // Tokens de los dispositivos.
    const tokens = [
      ...new Set(
        (
          Array.isArray(data.fcmTokens)
            ? data.fcmTokens
            : []
        ).filter(
          t => typeof t === 'string' && t.length > 20
        )
      )
    ];

    if (!followed.size || !tokens.length) {
      continue;
    }

    for (const entry of fresh) {
      // Solo avisar si el bombero sigue la máquina.
      if (!followed.has(entry.machine)) {
        continue;
      }

      for (const token of tokens) {
        recipients.push({
          uid: user.id,
          token,
          entry
        });
      }
    }
  }

  // Seguridad contra envíos masivos.
  if (recipients.length > MAX_FCM_RECIPIENTS) {
    throw new Error(
      `Demasiados destinatarios: ${recipients.length}.`
    );
  }

  console.log(
    `${DRY_RUN ? '[PRUEBA] ' : ''}` +
    `Coincidencias con usuarios/tokens: ${recipients.length}.`
  );

  // ========================================
  // MODO DE PRUEBA
  // ========================================

  if (DRY_RUN) {
    console.log(
      'DRY_RUN=true: no se enviaron mensajes FCM.'
    );

    return;
  }

  // ========================================
  // CONTROL DE DUPLICADOS Y ENVÍOS
  // ========================================

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const { uid, token, entry } of recipients) {
    // Identificador de entrega:
    // parte + máquina + usuario + token.
    //
    // El documento no contiene el token en claro.
    const deliveryId = hash(
      `${entry.part}|${entry.machine}|${uid}|${token}`
    );

    const deliveryRef = db
      .collection('sgo_fcm_deliveries')
      .doc(deliveryId);

    const previous = await deliveryRef.get();

    // Si Firebase ya aceptó el mensaje,
    // no volver a enviarlo normalmente.
    if (
      previous.exists &&
      previous.get('status') === 'sent'
    ) {
      skipped++;
      continue;
    }

    try {
      const messageId = await getMessaging().send({
        token,

        // Mensaje de solo datos.
        // El receptor de Flutter crea la alerta.
        data: {
          tipo: 'emergencia',

          maquina: entry.machine,

          emergencia:
            entry.emergency || 'Emergencia',

          direccion:
            entry.address || '',

          numeroParte:
            entry.part,

          fecha:
            entry.date || '',

          estado:
            entry.status || '',

          simulacro: 'false'
        },

        android: {
          priority: 'high'
        }
      });

      // Registrar mensaje aceptado por Firebase.
      await deliveryRef.set({
        status: 'sent',

        part: entry.part,

        machine: entry.machine,

        uid,

        messageId,

        sentAt: FieldValue.serverTimestamp()
      }, {
        merge: true
      });

      sent++;

    } catch (error) {
      failed++;

      console.error(
        `FCM fallo para parte ${entry.part}, ` +
        `maquina ${entry.machine}: ` +
        `${error.code || error.message}`
      );
    }
  }

  console.log(
    `FCM: enviados=${sent}; ` +
    `omitidos por duplicado=${skipped}; ` +
    `fallidos=${failed}.`
  );

  if (failed) {
    throw new Error(
      'Uno o mas envios fallaron. ' +
      'No se actualizara la linea base; ' +
      'los exitosos no se reenviaran ' +
      'en un reintento normal.'
    );
  }
}

// ==========================================
// PROCESO PRINCIPAL
// ==========================================

async function main() {
  // Obtener credenciales desde GitHub Secrets.
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!json) {
    throw new Error(
      'Falta GitHub Secret FIREBASE_SERVICE_ACCOUNT'
    );
  }

  const account = JSON.parse(json);

  if (
    account.project_id !== 'alertas-sgo-bomberos'
  ) {
    throw new Error(
      'La clave no corresponde al proyecto esperado'
    );
  }

  initializeApp({
    credential: cert(account)
  });

  const db = getFirestore();

  // Leer emergencias publicadas.
  const rows = await getSGO();

  const current = entries(rows);

  const currentIds = [...current.keys()];

  console.log(
    `SGO Norte: ${rows.length} partes, ` +
    `${current.size} asignaciones de maquinas.`
  );

  console.log(
    `Modo: DRY_RUN=${DRY_RUN}; ` +
    `RESET_BASELINE=${RESET_BASELINE}`
  );

  // ========================================
  // CONSULTAR HISTORIAL FIRESTORE
  // ========================================

  const ref = db.doc(STATE_DOC);

  const oldSnapshot = await ref.get();

  const data = oldSnapshot.exists
    ? oldSnapshot.data()
    : {};

  const known = new Set(
    Array.isArray(data.known)
      ? data.known
      : []
  );

  const overlap = currentIds.filter(
    id => known.has(id)
  ).length;

  console.log(
    `Comparacion: ${known.size} identificadores conocidos, ` +
    `${overlap} coinciden con la tabla actual.`
  );

  // ========================================
  // REINICIALIZAR LÍNEA BASE
  // ========================================

  if (
    RESET_BASELINE ||
    !oldSnapshot.exists
  ) {
    await ref.set({
      known: currentIds.slice(-1500),

      updatedAt: FieldValue.serverTimestamp(),

      ...(oldSnapshot.exists
        ? {
            resetAt: FieldValue.serverTimestamp()
          }
        : {
            initializedAt:
              FieldValue.serverTimestamp()
          })
    }, {
      merge: true
    });

    console.log(
      'LINEA BASE ACTUALIZADA. ' +
      'No se enviaron emergencias anteriores.'
    );

    return;
  }

  // ========================================
  // DETECTAR NUEVAS ASIGNACIONES
  // ========================================

  const fresh = [...current].filter(
    ([id]) => !known.has(id)
  );

  console.log(
    `Asignaciones nuevas desde la ultima revision: ${fresh.length}`
  );

  // Prevenir envíos masivos accidentales.
  if (fresh.length > MAX_NEW) {
    throw new Error(
      `Demasiadas asignaciones nuevas (${fresh.length}); ` +
      'no se enviaron notificaciones.'
    );
  }

  // Mostrar hasta 15 asignaciones nuevas.
  for (const [, entry] of fresh.slice(0, 15)) {
    console.log(
      `Nuevo: ${entry.part} / ` +
      `${entry.machine} / ${entry.emergency}`
    );
  }

  if (fresh.length) {
    await notifyFor(
      fresh.map(([, entry]) => entry),
      db
    );
  }

  // ========================================
  // MODO DE PRUEBA
  // ========================================

  if (DRY_RUN) {
    console.log(
      'DRY_RUN=true; las asignaciones nuevas ' +
      'NO se marcaron como procesadas.'
    );

    return;
  }

  // ========================================
  // ACTUALIZAR LÍNEA BASE
  // ========================================

  const next = [
    ...new Set([
      ...known,
      ...currentIds
    ])
  ].slice(-1500);

  await ref.set({
    known: next,
    updatedAt: FieldValue.serverTimestamp()
  }, {
    merge: true
  });

  console.log(
    'Estado actualizado. ' +
    'Las asignaciones revisadas se marcaron como conocidas.'
  );
}

// ==========================================
// CONTROL DE ERRORES
// ==========================================

main().catch(error => {
  console.error(
    'MONITOR ERROR:',
    error.stack || error
  );

  process.exitCode = 1;
});
