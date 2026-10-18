import { FIREBASE_CONFIG } from './config.js';

firebase.initializeApp(FIREBASE_CONFIG);

export const auth = firebase.auth();
export const db = firebase.database();
export const TS = firebase.database.ServerValue.TIMESTAMP;
export const EmailAuthProvider = firebase.auth.EmailAuthProvider;

function storageWorks() {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (!done) { done = true; resolve(ok); } };
    setTimeout(() => finish(false), 2500);
    try {
      const req = indexedDB.open('low-probe', 1);
      req.onsuccess = () => { req.result.close(); finish(true); };
      req.onerror = () => finish(false);
      req.onblocked = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

export async function prepareAuthStorage() {
  if (await storageWorks()) return;
  const session = firebase.auth.Auth?.Persistence?.SESSION;
  if (session) await auth.setPersistence(session).catch(() => {});
}
