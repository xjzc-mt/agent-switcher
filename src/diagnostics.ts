import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ops = ['refresh','switch','save','login','update','import','export','remove'] as const;
const triggers = ['manual','automatic','tray','cli','unknown'] as const;
const agents = ['codex','agy','claude','none'] as const;
const steps = ['cached','cooldown','live-session','read-only','access-valid','access-expired','access-missing',
  'query-start','query-end','credential-write','confirm','client-restart','status-read','storage-unavailable',
  'process-unknown','rotation','pending-commit','refresh-revoked','refresh-reused','refresh-expired',
  'refresh-invalid','authentication-rejected','account-unavailable'] as const;
const results = ['ok','failed','waiting','timeout','expired','canceled','cached','unsupported','interrupted'] as const;
type Op = typeof ops[number];
type Trigger = typeof triggers[number];
type Step = typeof steps[number];
type Result = typeof results[number];
type RecordEntry = {
  id: string; op: Op; agent: typeof agents[number]; trigger: Trigger; account?: string; version: string;
  started: number; lastAttempt?: number; ended?: number; result?: Result; lastSuccess?: number; count: number;
  steps: { step: Step; at: number }[];
};
const scope = new AsyncLocalStorage<{ record:RecordEntry; outcome?:Result }>();
const entries = new Map<string,RecordEntry>();
const week = 7 * 24 * 60 * 60 * 1000;
const safeId = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const safeVersion = (s: unknown) => typeof s === 'string' &&
  /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,4})?)?(?:\+(?:source|[a-f\d]{7,12}))?$/.test(s) ? s : 'unknown';
let directory: string | undefined, version = 'unknown', salt: Buffer;
const validTime = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= Date.UTC(2000,0,1) && n <= Date.now() + 60000;

// Multiple development previews can share a release version while running different code.
export function sourceDiagnosticVersion(appVersion: string): string {
  try {
    const hash = createHash('sha256');
    for (const dir of [__dirname, path.join(__dirname, '..', 'renderer')]) {
      const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && /\.(?:js|html|css)$/.test(entry.name))
        .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name))).sort();
      for (const file of files) {
        hash.update(file.split(path.sep).join('/')).update('\0').update(fs.readFileSync(path.join(dir, file))).update('\0');
      }
    }
    return appVersion + '+' + hash.digest('hex').slice(0, 12);
  } catch { return appVersion + '+source'; }
}

function save(r: RecordEntry) {
  if (!directory || entries.get(r.id) !== r) return;
  const temp = path.join(directory, r.id + '.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify(r), { flag:'wx', mode:0o600 });
    fs.renameSync(temp, path.join(directory, r.id + '.json'));
  } catch { try { fs.unlinkSync(temp); } catch { /* Recording must not affect the account operation. */ } }
}

function drop(id: string) {
  entries.delete(id);
  try { if (directory) fs.unlinkSync(path.join(directory,id + '.json')); } catch {}
}

function prune() {
  const cutoff = Date.now() - week;
  for (const r of entries.values()) if ((r.ended ?? r.started) < cutoff) drop(r.id);
  const records = [...entries.values()].sort((a,b) => a.started - b.started);
  const keep = new Set(records.slice(-48));
  let incidents = 0;
  for (let i = records.length - 1; i >= 0 && incidents < 6; i--) {
    if (!['failed','timeout','expired','interrupted'].includes(records[i].result || '')) continue;
    incidents++;
    for (const r of records.slice(Math.max(0,i-1),i+2)) keep.add(r);
  }
  for (const r of records) if (!keep.has(r)) drop(r.id);
}

// Reconstruct only the permitted fields, including when a file was written by an older build.
function restore(id: string, item: any): RecordEntry | undefined {
  if (!item || item.id !== id || !ops.includes(item.op) || !agents.includes(item.agent) ||
      !triggers.includes(item.trigger) || !validTime(item.started) || !Array.isArray(item.steps)) return;
  const trace = item.steps.slice(0,24).filter((s:any) => s && steps.includes(s.step) && validTime(s.at))
    .map((s:any) => ({ step:s.step as Step, at:s.at as number }));
  const complete = validTime(item.ended) && results.includes(item.result);
  return { id, op:item.op, agent:item.agent, trigger:item.trigger,
    account:typeof item.account === 'string' && /^[\da-f]{32}$/.test(item.account) ? item.account : undefined,
    version:safeVersion(item.version), started:item.started, steps:trace, count:Number.isSafeInteger(item.count) && item.count>0 ? item.count : 1,
    lastAttempt:validTime(item.lastAttempt) ? item.lastAttempt : undefined,
    ended:complete ? item.ended : trace.at(-1)?.at ?? item.started, result:complete ? item.result : 'interrupted',
    lastSuccess:validTime(item.lastSuccess) ? item.lastSuccess : undefined };
}

export function initializeDiagnostics(folder: string, appVersion: string): void {
  directory = undefined; entries.clear(); version = safeVersion(appVersion);
  try {
    salt = randomBytes(32);
    fs.mkdirSync(folder, { recursive:true, mode:0o700 });
    if (!fs.lstatSync(folder).isDirectory()) return;
    directory = folder;
    for (const file of fs.readdirSync(folder)) {
      const id = path.parse(file).name;
      if (!safeId.test(id)) continue;
      const filename = path.join(folder,file);
      try {
        if (file === id + '.tmp') { fs.unlinkSync(filename); continue; }
        if (file !== id + '.json') continue;
        const stat = fs.lstatSync(filename);
        const item = stat.isFile() && stat.size <= 8192 && restore(id, JSON.parse(fs.readFileSync(filename,'utf8')));
        if (item) entries.set(id,item);
        else fs.unlinkSync(filename);
      } catch { try { fs.unlinkSync(filename); } catch { /* Unreadable diagnostics must not block startup. */ } }
    }
    prune();
  } catch { directory = undefined; }
}

export function stepDiagnostic(step: Step): void {
  const r = scope.getStore()?.record;
  if (!r || r.result || !steps.includes(step) || r.steps.at(-1)?.step === step) return;
  if (r.steps.length >= 24) r.steps.splice(1,1);
  r.steps.push({ step, at:Date.now() });
  save(r);
}

export function resultDiagnostic(result: Exclude<Result,'interrupted'>, lastSuccess?: string): void {
  const context = scope.getStore();
  if (!context || context.record.result || !results.includes(result)) return;
  // IPC maps the returned account status after the operation has recorded why it returned.
  const specific = context.outcome === 'cached' || context.outcome === 'unsupported' || context.outcome === 'timeout';
  if (!specific || result === 'timeout') context.outcome = result;
  const time = typeof lastSuccess === 'string' ? Date.parse(lastSuccess) : NaN;
  if (validTime(time)) context.record.lastSuccess = time;
}

function finish(r: RecordEntry, result: Result) {
  if (entries.get(r.id) !== r) return;
  r.ended = Date.now(); r.result = result;
  if (result === 'waiting' && r.account) {
    const previous = [...entries.values()].reverse().find(p => p !== r && p.op === r.op && p.agent === r.agent && p.account === r.account);
    if (previous?.result === 'waiting' && previous.ended !== undefined && previous.ended <= r.started &&
        previous.trigger === r.trigger && previous.lastSuccess === r.lastSuccess &&
        previous.steps.map(s => s.step).join() === r.steps.map(s => s.step).join()) {
      previous.count++; previous.lastAttempt = r.started; previous.ended = r.ended;
      save(previous); drop(r.id); return;
    }
  }
  save(r); prune();
}

export async function runDiagnostic<T>(op: Op, agent: string | undefined, trigger: Trigger, profile: string | undefined, work: () => Promise<T>): Promise<T> {
  if (!directory || !ops.includes(op) || !triggers.includes(trigger)) return work();
  let record: RecordEntry;
  try {
    const provider = agents.find(id => id === agent) ?? 'none';
    const account = typeof profile === 'string' ? createHmac('sha256',salt).update(provider + '\0' + profile).digest('hex').slice(0,32) : undefined;
    record = { id:randomUUID(), op, agent:provider, trigger, account, version, started:Date.now(), count:1, steps:[] };
    entries.set(record.id,record); save(record); prune();
  } catch { return work(); }
  const context: { record:RecordEntry; outcome?:Result } = { record };
  return scope.run(context, async () => {
    try {
      const value = await work();
      finish(record,context.outcome ?? 'ok');
      return value;
    } catch (error) {
      finish(record,context.outcome === 'timeout' ? 'timeout' : 'failed');
      throw error;
    }
  });
}

export function exportDiagnostics() {
  prune();
  const aliases = new Map<string,number>();
  const records = [...entries.values()].sort((a,b) => a.started - b.started);
  return {
    schema:1, generatedAt:new Date().toISOString(), version, platform:process.platform, arch:process.arch,
    operations:records.map((r,index) => {
      if (r.account && !aliases.has(r.account)) aliases.set(r.account,aliases.size+1);
      return { id:index+1, operation:r.op, agent:r.agent, account:r.account ? aliases.get(r.account) : undefined,
        trigger:r.trigger, version:r.version, startedAt:new Date(r.started).toISOString(),
        endedAt:r.ended === undefined || r.result === 'interrupted' ? undefined : new Date(r.ended).toISOString(),
        durationMs:r.ended === undefined || r.result === 'interrupted' ? undefined : Math.max(0,r.ended-(r.lastAttempt??r.started)),
        lastAttemptAt:r.lastAttempt && new Date(r.lastAttempt).toISOString(),
        result:r.result ?? 'running', attempts:r.count, lastQuotaAt:r.lastSuccess && new Date(r.lastSuccess).toISOString(),
        steps:r.steps.map(s => ({step:s.step, afterMs:Math.max(0,s.at-r.started)})) };
    }),
  };
}
