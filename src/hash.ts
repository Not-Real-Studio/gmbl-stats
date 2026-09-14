// FNV-1a хэш конфиг-снапшота (stats-basis §1: GAS и node обязаны давать ОДИН хэш одного
// конфига, иначе инвалидация протухших колонок разъедется).
//
// Что входит в снапшот — game-specific (какие поля конфига меняют математику). Снапшот собирает
// игра, ядро хэширует переданный объект: порядок ключей объекта = порядок в JSON = часть хэша.

/** FNV-1a (32 бита) от JSON-сериализации снапшота; 8 hex-символов. */
export function configHash(snapshot: unknown): string {
  const snap = JSON.stringify(snapshot);
  let h = 0x811c9dc5;
  for (let i = 0; i < snap.length; i++) {
    h ^= snap.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}
