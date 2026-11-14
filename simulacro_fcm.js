
'use strict';

const { initializeApp, cert } =
  require('firebase-admin/app');

const { getMessaging } =
  require('firebase-admin/messaging');

async function main() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  const token = process.env.FCM_TEST_TOKEN;

  const maquina = (
    process.env.MAQUINA_PRUEBA || 'RESLIG-36'
  ).trim().toUpperCase();

  if (!json) {
    throw new Error(
      'Falta FIREBASE_SERVICE_ACCOUNT'
    );
  }

  if (!token) {
    throw new Error(
      'Falta FCM_TEST_TOKEN'
    );
  }

  const cuenta = JSON.parse(json);

  if (cuenta.project_id !== 'alertas-sgo-bomberos') {
    throw new Error(
      'Proyecto Firebase incorrecto'
    );
  }

  initializeApp({
    credential: cert(cuenta)
  });

  const parte = `SIMULACRO-${Date.now()}`;

  console.log('=== PRUEBA DE NOTIFICACION VISIBLE ===');
  console.log(`Maquina: ${maquina}`);
  console.log(`Parte: ${parte}`);
  console.log('Destino: Samsung de prueba');
  console.log('No se modificara Firestore.');

  const mensaje = {
    token: token.trim(),

    // Android mostrará esta notificación cuando
    // la aplicación esté en segundo plano.
    notification: {
      title: `SIMULACRO SGO - ${maquina}`,
      body: 'PRUEBA: Accidente vehicular. No es real.'
    },

    // Información para abrir el detalle al tocarla.
    data: {
      tipo: 'emergencia',
      maquina: maquina,
      emergencia: 'SIMULACRO - Accidente vehicular',
      direccion: 'Direccion ficticia de prueba',
      numeroParte: parte,
      estado: 'SIMULACRO',
      simulacro: 'true'
    },

    android: {
      priority: 'high',
      ttl: 60000,
      notification: {
        channelId: 'sgo_emergencias_background_v1',
        priority: 'high',
        visibility: 'public',
        defaultSound: true
      }
    }
  };

  const resultado = await getMessaging().send(mensaje);

  console.log('FCM acepto la notificacion visible.');
  console.log(`ID: ${resultado}`);
}

main().catch(error => {
  console.error(
    'ERROR SIMULACRO:',
    error.code || error.message
  );

  process.exitCode = 1;
});
