import { parentPort, workerData } from 'worker_threads';
import { loadImportKeyInWorker } from './credential-vault';

const key = loadImportKeyInWorker(workerData.root, workerData.create === true);
// Transfer only these 32 bytes. A decoded Buffer can share its underlying slab.
const bytes = Uint8Array.from(key);
key.fill(0);
parentPort!.postMessage(bytes, [bytes.buffer]);
