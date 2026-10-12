/**
 * Provider sözleşmesi.
 *
 * Bir provider, oyuncu anlık görüntüsünü (snapshot) üreten küçük bir modüldür:
 *
 *   async getSnapshot() → {
 *     players: [{ id: number (>0), name: string, ping: number|null }],
 *     selfId: number|null,   // kendi server ID'n (biliniyorsa)
 *   }
 *
 * Kurallar:
 * - getSnapshot ASLA throw etmemeli; hata varsa throw yerine provider
 *   önceki snapshot'ı korumalı ya da boş liste dönmeli (poller stale işler).
 * - Hassas bilgi (IP/identifier/token) snapshot'a KONMAZ — modelde yeri yok.
 * - `players` listesi validateSnapshot() ile doğrulanır; bozuk kayıt atılır.
 */

function validateSnapshot(snap) {
  const players = [];
  let dropped = 0;
  const list = snap && Array.isArray(snap.players) ? snap.players : [];
  for (const p of list.slice(0, 2000)) {
    try {
      if (!p || typeof p !== 'object') {
        dropped++;
        continue;
      }
      const id = Number(p.id);
      const name = String(p.name ?? '').trim().slice(0, 64);
      if (!Number.isInteger(id) || id < 1 || id > 100000 || !name) {
        dropped++;
        continue;
      }
      const pingRaw = p.ping === null || p.ping === undefined ? null : Number(p.ping);
      const ping = pingRaw === null ? null : Number.isFinite(pingRaw) && pingRaw >= 0 ? Math.floor(pingRaw) : null;
      players.push({ id, name, ping });
    } catch {
      dropped++;
    }
  }
  players.sort((a, b) => a.id - b.id);
  const selfRaw = snap ? Number(snap.selfId) : NaN;
  const selfId = Number.isInteger(selfRaw) && selfRaw > 0 ? selfRaw : null;
  return { players, selfId, dropped };
}

module.exports = { validateSnapshot };
