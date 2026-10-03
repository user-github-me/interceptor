'use strict';
/* IndexedDB stores the complete workbench on this browser profile's local disk. */
(function (global) {
  let database;
  async function open() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('interceptor-workspace', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspaces');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { database = null; reject(request.error); };
    });
    return database;
  }
  async function transaction(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workspaces', mode);
      const request = operation(tx.objectStore('workspaces'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Local save cancelled.'));
    });
  }
  const api = {
    read: () => transaction('readonly', (store) => store.get('current')),
    write: (snapshot) => transaction('readwrite', (store) => store.put(snapshot, 'current')),
    preserve: (snapshot) => transaction('readwrite', (store) => store.put(snapshot, 'before-restore')),
    previous: () => transaction('readonly', (store) => store.get('before-restore')),
    clear: () => transaction('readwrite', (store) => store.delete('current')),
  };
  global.LocalStore = api;
})(globalThis);
