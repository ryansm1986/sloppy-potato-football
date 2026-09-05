export function accountStorage(storage: Pick<Storage, "getItem" | "setItem">, userId?: string) {
  const key = (value: string) => userId ? `spff:account:${userId}:${value}` : value;
  return { getItem: (value: string) => storage.getItem(key(value)), setItem: (value: string, content: string) => storage.setItem(key(value), content) };
}
