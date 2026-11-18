import { parentPort, workerData } from 'worker_threads';
import { parseCredentialDocument } from './credential-document';

parentPort!.postMessage(parseCredentialDocument(workerData.data, workerData.agent));
