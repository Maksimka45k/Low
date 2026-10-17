export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCh9OKJ0yx49ZIfGyV4wzBYaZLnGrM9W2U',
  authDomain: 'messenger-low.firebaseapp.com',
  databaseURL: 'https://messenger-low-default-rtdb.firebaseio.com',
  projectId: 'messenger-low',
  storageBucket: 'messenger-low.firebasestorage.app',
  messagingSenderId: '1083975450515',
  appId: '1:1083975450515:web:411c77239a5f0d252c7266'
};

export const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.relay.metered.ca:80" },
    {
      urls: "turn:global.relay.metered.ca:80",
      username: "0ef96a13e5d3f105ba3f4f4b",
      credential: "icVM/b+c2qyOsMVA",
    },
    {
      urls: "turn:global.relay.metered.ca:80?transport=tcp",
      username: "0ef96a13e5d3f105ba3f4f4b",
      credential: "icVM/b+c2qyOsMVA",
    },
    {
      urls: "turn:global.relay.metered.ca:443",
      username: "0ef96a13e5d3f105ba3f4f4b",
      credential: "icVM/b+c2qyOsMVA",
    },
    {
      urls: "turns:global.relay.metered.ca:443?transport=tcp",
      username: "0ef96a13e5d3f105ba3f4f4b",
      credential: "icVM/b+c2qyOsMVA",
    },
  ],
  iceCandidatePoolSize: 4
};

export const LIMITS = {
  page: 50,
  plainFile: 200 * 1024 * 1024,
  encryptedFile: 50 * 1024 * 1024,
  momentFile: 100 * 1024 * 1024,
  ringSeconds: 40
};
