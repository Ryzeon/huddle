import { keyTail } from '@huddle/protocol';
import { IDENTITY_PATH, loadOrCreateIdentity } from '../../../identity.js';

export function runKey(): void {
  const identity = loadOrCreateIdentity();

  console.log('');
  console.log(`  CLAVE:   ${identity.publicKey}`);
  console.log(`  COLA:    …${keyTail(identity.publicKey)}`);
  console.log('');
  console.log(`  Vive en ${IDENTITY_PATH}. Es lo que ata tu alias en cada sala.`);
  console.log('  Cópiala a otra máquina si quieres usar el mismo alias desde las dos.');
  console.log('');
}
