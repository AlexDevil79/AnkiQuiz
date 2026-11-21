'use strict';
/* Sauvegarde des decks (.apkg) dans IndexedDB */
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('ankiquiz', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('decks');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('decks', mode);
      const out = fn(tx.objectStore('decks'));
      tx.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      tx.onerror = () => rej(tx.error);
    });
  };
  return {
    put: (name, blob) => run('readwrite', (s) => s.put(blob, name)).catch(() => {}),
    del: (name) => run('readwrite', (s) => s.delete(name)).catch(() => {}),
    async all() {
      try {
        const db = await open();
        return await new Promise((res, rej) => {
          const out = [];
          const req = db.transaction('decks').objectStore('decks').openCursor();
          req.onsuccess = () => { const c = req.result; if (c) { out.push({ name: c.key, blob: c.value }); c.continue(); } else res(out); };
          req.onerror = () => rej(req.error);
        });
      } catch { return []; }
    },
  };
})();
