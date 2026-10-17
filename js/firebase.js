import { FIREBASE_CONFIG } from './config.js';

firebase.initializeApp(FIREBASE_CONFIG);

export const auth = firebase.auth();
export const db = firebase.database();
export const TS = firebase.database.ServerValue.TIMESTAMP;
export const EmailAuthProvider = firebase.auth.EmailAuthProvider;
