import { Atom } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";

import { appAtomRegistry } from "../../state/atom-registry";

const REWRITE_KEY = "t3code.dictation.rewrite-api-key";
// This device only: the key is not restored from a backup or synced by iCloud Keychain.
const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export function readRewriteKey(): Promise<string | null> {
  return SecureStore.getItemAsync(REWRITE_KEY, KEYCHAIN_OPTIONS);
}

/** Whether a key is saved; the key itself stays in the keychain. */
export const rewriteKeyPresentAtom = Atom.writable(
  (get) => {
    void readRewriteKey().then(
      (key) => get.setSelf(key !== null),
      (error: unknown) => console.warn("[dictation] could not read the rewrite key", error),
    );
    return false;
  },
  (ctx, present: boolean) => ctx.setSelf(present),
).pipe(Atom.keepAlive, Atom.withLabel("mobile:dictation-rewrite-key"));

/** Trims; a blank or null key deletes the saved one. */
export async function saveRewriteKey(key: string | null): Promise<void> {
  const trimmed = key?.trim() ?? "";
  if (trimmed === "") await SecureStore.deleteItemAsync(REWRITE_KEY, KEYCHAIN_OPTIONS);
  else await SecureStore.setItemAsync(REWRITE_KEY, trimmed, KEYCHAIN_OPTIONS);
  appAtomRegistry.set(rewriteKeyPresentAtom, trimmed !== "");
}
