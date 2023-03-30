import dotenv from 'dotenv';
dotenv.config();

import * as lib from './lib'

async function run() {
  const mediation = await lib.createMediation('test1', 0)
  await lib.participate(0, "Sarah", mediation.id)
  await lib.participate(1, "Peter", mediation.id) 
  await lib.closeMediation(mediation.id)
  await lib.storePerspective(mediation.id, 0, "Immer wenn ich aufs Klo gehe hört Hans laut Musik") 
  await lib.storePerspective(mediation.id, 1, "Sarah macht komische Geräusche, wenn sie aufs Klo geht") 
  await lib.checkWhetherMediationIsReadyAndConsultChatGPT(mediation.id) 
}

console.log('starting tests');
run()

