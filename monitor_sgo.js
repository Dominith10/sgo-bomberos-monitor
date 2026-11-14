'use strict';

// Monitor experimental: fuente publica SGO Norte -> Firestore -> FCM.
// Nunca guarda claves privadas ni tokens en el repositorio.
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const SOURCE = 'https://sgonorte.bomberosperu.gob.pe/24horas';
const STATE_DOC = 'monitor_control/sgo_norte_24h';
const MAX_RECORDS = 300;
const MAX_FCM_RECIPIENTS = 1000; // seguridad: si supera el limite, abortar
const DRY_RUN = process.env.DRY_RUN !== 'false';
const TIMEOUT_MS = 20000;

function normalizeMachine(v) {
  return String(v || '').trim().toUpperCase().replace(/\s+/g, '');
}

function readRows(html) {
  const $ = cheerio.load(html);
  const records = [];
  const tables = $('table');
  let candidateRows = 0;
  let skippedRows = 0;
  const diagnostics = [];

  tables.each((_ti, table) => {
    const headers = $(table).find('thead tr').first().find('th').map((_, th) =>
      $(th).text().replace(/\s+/g, ' ').trim().toLowerCase()
    ).get();
    if (!headers.some(h => /nro\.?\s*parte|n[uú]mero\s*de\s*parte/i.test(h)) ||
        !headers.some(h => /m[aá]quinas|unidades/i.test(h))) return;

    $(table).find('tr').each((_ri, row) => {
      const cells = $(row).children('td');
      if (cells.length < 6) return;
      candidateRows++;
      const clean = n => $(cells[n]).text().replace(/\s+/g, ' ').trim();
      // SGO puede omitir la primera columna (#) en el cuerpo de la tabla.
      // Localizamos el numero de parte, en vez de asumir un indice fijo.
      let partIndex = -1;
      for (const i of [1, 0]) {
        if (i < cells.length && /^\d{8,14}$/.test(clean(i).replace(/\s/g, ''))) {
          partIndex = i;
          break;
        }
      }
      if (partIndex < 0 || partIndex + 5 >= cells.length) {
        skippedRows++;
        if (diagnostics.length < 2) diagnostics.push({ celdas: cells.length,
          primerosCampos: [clean(0), clean(1)].map(x => x.slice(0, 22)) });
        return;
      }
      const part = clean(partIndex).replace(/\s/g, '');
      const machineCell = $(cells[partIndex + 5]);
      const list = machineCell.find('li');
      const rawMachines = list.length
        ? list.map((_, li) => $(li).text()).get()
        : machineCell.text().split(/[\n,;]+/);
      const machines = [...new Set(rawMachines.map(normalizeMachine).filter(Boolean))];
      records.push({
        part,
        date: clean(partIndex + 1),
        address: clean(partIndex + 2),
        emergency: clean(partIndex + 3),
        status: clean(partIndex + 4),
        machines,
      });
    });
  });
  const unique = [...new Set(records.map(r => r.part))].length;
  const withMachines = records.filter(r => r.machines.length > 0).length;
  console.log(`SGO lectura: ${tables.length} tablas, ${candidateRows} filas candidatas, ${records.length} partes interpretados, ${withMachines} con maquinas, ${skippedRows} descartados.`);
  if (diagnostics.length) console.log('SGO filas descartadas (solo IDs):', JSON.stringify(diagnostics));
  // No grabar linea base ni enviar mensajes si la pagina cambia o queda mal interpretada.
  if (records.length < 5 || unique < 5 || (candidateRows > 10 && records.length < candidateRows * 0.7)) {
    throw new Error('La estructura SGO no pudo verificarse con seguridad. No se modifico el estado.');
  }
  if (records.length > MAX_RECORDS) throw new Error('Numero de filas inesperado: ' + records.length);
  console.log('SGO muestra (solo parte y maquinas):', JSON.stringify(records.slice(0, 3).map(r => ({parte:r.part, maquinas:r.machines}))));
  return records;
}

async function getSGO() {
  const response = await fetch(SOURCE, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': 'SGO-Bomberos-Monitor/1.0 (prototipo educativo; 1 consulta/5 min)', accept: 'text/html' },
  });
  if (!response.ok) throw new Error(`SGO HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  const html = await response.text();
  console.log('SGO respuesta:', JSON.stringify({
    status: response.status,
    contentType: contentType.slice(0, 100),
    url: response.url.slice(0, 180),
    longitud: html.length,
  }));
  if (!/html/i.test(contentType) && !/<html|<table/i.test(html)) {
    throw new Error('SGO no devolvió HTML. No se modificó el estado.');
  }
  return readRows(html);
}

function entries(rows) {
  const result = {};
  for (const r of rows) {
    for (const machine of r.machines) {
      const key = crypto.createHash('sha256').update(`${r.part}|${machine}`).digest('hex').slice(0, 32);
      result[key] = { ...r, machine };
    }
  }
  return result;
}

async function notifyFor(entriesToNotify, db) {
  const snapshot = await db.collection('users').get();
  const recipients = [];
  for (const user of snapshot.docs) {
    const u = user.data();
    const follows = new Set((Array.isArray(u.machines) ? u.machines : []).map(normalizeMachine));
    const tokens = [...new Set((Array.isArray(u.fcmTokens) ? u.fcmTokens : []).filter(t => typeof t === 'string' && t.length > 20))];
    if (!tokens.length || !follows.size) continue;
    for (const entry of entriesToNotify) {
      if (!follows.has(entry.machine)) continue; // sin equivalencias inventadas
      for (const token of tokens) recipients.push({ token, entry });
    }
  }
  if (recipients.length > MAX_FCM_RECIPIENTS) throw new Error('Demasiados destinatarios; envio cancelado.');
  if (DRY_RUN) {
    console.log(`[PRUEBA] Coincidencias con usuarios/tokens: ${recipients.length}. No se enviaron alertas.`);
    return;
  }
  let ok = 0, errors = 0;
  for (const {token, entry} of recipients) {
    try {
      await getMessaging().send({
        token,
        // Solo datos: el handler Flutter crea la notificación local en segundo plano.
        // Evita la notificación automática adicional de FCM.
        data: {
          tipo: 'emergencia',
          maquina: entry.machine,
          emergencia: entry.emergency || 'Emergencia',
          direccion: entry.address || '',
          numeroParte: entry.part,
          fecha: entry.date || '',
          estado: entry.status || '',
          simulacro: 'false',
        },
        android: { priority: 'high' },
      });
      ok++;
    } catch (e) { errors++; console.error(`Error FCM para parte ${entry.part}, máquina ${entry.machine}: ${e.code || e.message}`); }
  }
  console.log(`FCM aceptó ${ok} mensajes; fallaron ${errors}.`);
  if (errors) throw new Error('Hubo envíos fallidos; revise logs.');
}

async function main() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!json) throw new Error('Falta GitHub Secret FIREBASE_SERVICE_ACCOUNT');
  const serviceAccount = JSON.parse(json);
  if (serviceAccount.project_id !== 'alertas-sgo-bomberos') throw new Error('La clave no corresponde al proyecto esperado');
  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();
  const rows = await getSGO();
  const nowEntries = entries(rows);
  console.log(`SGO Norte: ${rows.length} partes, ${Object.keys(nowEntries).length} asignaciones de máquinas.`);

  const ref = db.doc(STATE_DOC);
  const oldSnapshot = await ref.get();
  if (!oldSnapshot.exists) {
    // El primer ciclo solo establece línea base; nunca envía histórico.
    await ref.set({ known: Object.keys(nowEntries), initializedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    console.log('Línea base inicializada. No se enviaron emergencias anteriores.');
    return;
  }
  const known = new Set(Array.isArray(oldSnapshot.data().known) ? oldSnapshot.data().known : []);
  const fresh = Object.entries(nowEntries).filter(([id]) => !known.has(id));
  console.log(`Asignaciones nuevas desde la última revisión: ${fresh.length}`);
  if (fresh.length > 40) throw new Error('Demasiadas asignaciones nuevas; revisión manual requerida para evitar envío masivo.');
  if (fresh.length) {
    for (const [, e] of fresh) console.log(`Nuevo: ${e.part} / ${e.machine} / ${e.emergency}`);
    await notifyFor(fresh.map(([, e]) => e), db);
  }
  // En modo de prueba NO se marca nada como procesado para que se pueda repetir la prueba.
  if (DRY_RUN) {
    console.log('DRY_RUN=true; no se actualizó el estado de asignaciones nuevas.');
    return;
  }
  // Mantener asignaciones de las últimas ejecuciones para evitar repetidos si una fila sale y vuelve a entrar.
  // El estado se acota para no crecer indefinidamente.
  const next = [...new Set([...known, ...Object.keys(nowEntries)])].slice(-1500);
  await ref.set({ known: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

main().catch(err => { console.error('MONITOR ERROR:', err.stack || err); process.exitCode = 1; });
