
'use strict';

const { initializeApp, cert } =
  require('firebase-admin/app');

const { getMessaging } =
  require('firebase-admin/messaging');

async function main() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  const token = process.env.FCM_TEST_TOKEN;
  const maquina = process.env.MAQUINA_PRUEBA || 'RESLIG-36';

  if (!json) {
    throw new Error('Falta FIREBASE_SERVICE_ACCOUNT');
  }

  if (!token) {
    throw new Error('Falta FCM_TEST_TOKEN');
  }

  const cuenta = JSON.parse(json);

  if (cuenta.project_id !== 'alertas-sgo-bomberos') {
    throw new Error('Proyecto Firebase incorrecto');
  }

  initializeApp({
    credential: cert(cuenta)
  });

  const parte = `SIMULACRO-${Date.now()}`;

  console.log('=== SIMULACRO SGO BOMBEROS ===');
  console.log(`Maquina: ${maquina}`);
  console.log(`Parte: ${parte}`);
  console.log('Destino: un dispositivo de prueba');

  const resultado = await getMessaging().send({
    token: token.trim(),
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
      ttl: 60000
    }
  });

  console.log('FCM acepto el simulacro.');
  console.log(`ID: ${resultado}`);
}

main().catch(error => {
  console.error(
    'ERROR SIMULACRO:',
    error.code || error.message
  );
  process.exitCode = 1;
});
