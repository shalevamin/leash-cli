import type { Store } from "./state.js";
import { deviceCredentials, syncDevice } from "./device.js";

export async function sync(store: Store, dryRun = false) {
  if (dryRun) return store.snapshot();
  if (process.env.LEASH_OFFLINE === "1" || process.env.LEASH_SYNC === "0")
    return;
  if (deviceCredentials()) return syncDevice(store);
}
