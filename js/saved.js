import { db, TS } from './firebase.js';
import { state } from './state.js';

// «Избранное»: личный чат с самим собой (id saved_<uid>). Создаётся при входе, если его ещё нет,
// поэтому появляется и у старых аккаунтов. Шифруется ключом самого пользователя.
export async function ensureSavedChat() {
  const me = state.me?.uid;
  if (!me) return;
  const id = 'saved_' + me;
  try {
    const own = await db.ref('userChats/' + me + '/' + id).once('value');
    if (own.val() === true) return;
    try {
      await db.ref('chats/' + id).set({ type: 'dm', saved: true, participants: { [me]: true }, createdAt: TS });
    } catch {} // чат уже мог существовать, тогда достаточно записи в userChats
    await db.ref('userChats/' + me + '/' + id).set(true);
  } catch (e) {
    console.warn('saved chat', e);
  }
}
