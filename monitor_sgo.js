
'use strict';

// Monitor SGO Norte -> Firestore -> FCM.
// Usa solo datos publicos de SGO y credenciales mediante GitHub Secrets.

const crypto = require('node:crypto');
const cheerio = require('cheerio');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const SOURCE = 'https://sgonorte.bomberosperu.gob.pe/24horas';
const STATE_DOC = 'monitor_control/sgo_norte_24h';

const MAX_RECORDS = 300;
const MAX_NEW = 40;
const MAX_FCM_RECIPIENTS = 1000;

const DRY_RUN = process.env.DRY_RUN !== 'false';
const RESET_BASELINE = process.env.RESET_BASELINE === 'true';

const TIMEOUT_MS = 20000;

// ==========================================
// NORMALIZAR CODIGOS DE MAQUINAS
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

// ==========================================
// LEER TABLA DE SGO NORTE
// ==========================================

function readRows(html) {
  const $ = cheerio.load(html);
  const records = new Map();

  let candidateRows = 0;

  $('table tr').each((_index, tr) => {
    const cells = $(tr).children('td').toArray();

    if (cells.length < 6) return;

    candidateRows++;

    // Buscar el numero de parte entre las
    // primeras tres celdas.
    const partIndex = cells.slice(0, 3).findIndex(
      cell => /^\d{8,20}$/.test(
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

    // Evitar duplicar un mismo parte.
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

  if (!rows.length || !rows.some(r => r.machines.length)) {
    throw new Error(
      'No se pudo interpretar de forma segura la tabla de SGO. ' +
      'Estado sin modificar.'
    );
  }

  if (rows.length > MAX_RECORDS) {
    throw new Error(
      `Cantidad inesperada de partes: ${rows.length}. ` +
      'Estado sin modificar.'
    );
  }

  return rows;
}

// ==========================================
// CONSULTAR SGO NORTE
// ==========================================

async function getSGO() {
  const response = await fetch(SOURCE, {
    signal: AbortSignal.timeout(TIMEOUT_MS),

    headers: {
      'user-agent':
        'SGO-Bomberos-Monitor/1.0 (prototipo; consulta periodica)',
      accept: 'text/html'
    }
  });

  if (!response.ok) {
    throw new Error(`SGO HTTP ${response.status}`);
  }

  return readRows(await response.text());
}

// ==========================================
// GENERAR IDENTIFICADORES UNICOS
// ==========================================

function entries(rows) {
  const result = new Map();

  for (const r of rows) {
    for (const machine of r.machines) {
      const key = crypto
        .createHash('sha256')
        .update(`${r.part}|${machine}`)
        .digest('hex')
        .slice(0, 32);

      result.set(key, {
        ...r,
        machine
      });
    }
  }

  return result;
}

// ==========================================
// ENVIAR NOTIFICACIONES FCM
// ==========================================

async function notifyFor(entriesToNotify, db) {
  const snapshot = await db.collection('users').get();

  const recipients = [];

  for (const user of snapshot.docs) {
    const u = user.data();

    const follows = new Set(
      (
        Array.isArray(u.machines)
          ? u.machines
          : []
      ).map(normalizeMachine)
    );

    const tokens = [
      ...new Set(
        (
          Array.isArray(u.fcmTokens)
            ? u.fcmTokens
            : []
        ).filter(
          t => typeof t === 'string' && t.length > 20
        )
      )
    ];

    if (!follows.size || !tokens.length) {
      continue;
    }

    for (const entry of entriesToNotify) {
      if (!follows.has(entry.machine)) {
        continue;
      }

      for (const token of tokens) {
        recipients.push({
          token,
          entry
        });
      }
    }
  }

  if (recipients.length > MAX_FCM_RECIPIENTS) {
    throw new Error(
      `Demasiados destinatarios (${recipients.length}); ` +
      'envio cancelado.'
    );
  }

  console.log(
    `${DRY_RUN ? '[PRUEBA] ' : ''}` +
    `Coincidencias con usuarios/tokens: ${recipients.length}.`
  );

  if (DRY_RUN) {
    console.log(
      'DRY_RUN=true: no se enviaron mensajes FCM.'
    );
    return;
  }

  let ok = 0;
  let errors = 0;

  for (const { token, entry } of recipients) {
    try {
      await getMessaging().send({
        token,

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

      ok++;
    } catch (error) {
      errors++;

      console.error(
        `FCM fallo para parte ${entry.part}, ` +
        `maquina ${entry.machine}: ` +
        `${error.code || error.message}`
      );
    }
  }

  console.log(
    `FCM acepto ${ok} mensajes; fallaron ${errors}.`
  );

  if (errors) {
    throw new Error(
      'Hubo envios fallidos: no se actualizo el estado ' +
      'para evitar perder alertas. ' +
      'Revisar posibles duplicados al reintentar.'
    );
  }
}

// ==========================================
// PROCESO PRINCIPAL
// ==========================================

async function main() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!json) {
    throw new Error(
      'Falta GitHub Secret FIREBASE_SERVICE_ACCOUNT'
    );
  }

  const account = JSON.parse(json);

  if (account.project_id !== 'alertas-sgo-bomberos') {
    throw new Error(
      'La clave no corresponde al proyecto Firebase esperado'
    );
  }

  initializeApp({
    credential: cert(account)
  });

  const db = getFirestore();

  // Obtener emergencias actuales.
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

  // Consultar historial de Firestore.
  const ref = db.doc(STATE_DOC);

  const oldSnapshot = await ref.get();

  const known = new Set(
    oldSnapshot.exists &&
    Array.isArray(oldSnapshot.data().known)
      ? oldSnapshot.data().known
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
  // REINICIALIZAR LINEA BASE
  // ========================================

  // Actualiza el historial usando los
  // despachos publicados actualmente.
  //
  // Nunca envia mensajes durante el reset.

  if (RESET_BASELINE || !oldSnapshot.exists) {
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
      RESET_BASELINE
        ? 'LINEA BASE REINICIALIZADA. ' +
          'No se envio ninguna emergencia anterior.'
        : 'Linea base inicializada. ' +
          'No se enviaron emergencias anteriores.'
    );

    return;
  }

  // ========================================
  // DETECTAR ASIGNACIONES NUEVAS
  // ========================================

  const fresh = [...current].filter(
    ([id]) => !known.has(id)
  );

  console.log(
    `Asignaciones nuevas desde la ultima revision: ${fresh.length}`
  );

  if (fresh.length > MAX_NEW) {
    throw new Error(
      `Demasiadas asignaciones nuevas (${fresh.length}). ` +
      'Mantenga DRY_RUN=true y ejecute ' +
      'reinicializacion controlada. ' +
      'No se enviaron notificaciones.'
    );
  }

  for (const [, e] of fresh.slice(0, 15)) {
    console.log(
      `Nuevo: ${e.part} / ${e.machine} / ${e.emergency}`
    );
  }

  if (fresh.length) {
    await notifyFor(
      fresh.map(([, e]) => e),
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
  // ACTUALIZAR HISTORIAL
  // ========================================

  // Conservar identificadores anteriores
  // y los que aparecen actualmente.
  // Evita notificaciones repetidas.

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
    'Estado de asignaciones actualizado.'
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
