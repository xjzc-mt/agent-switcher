import type { AgentId } from './agents/metadata';
import { validateName } from './store';
import { parseCredentialJson } from './credential-json';

type ObjectValue = Record<string, unknown>;
export interface CredentialEntry { agent?: AgentId; data?: Buffer; name?: string; error?: string }
const record = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value: ObjectValue, key: string) => Object.hasOwn(value, key);
const keyName = (key: string) => key.replace(/[_ .-]/g, '').toLowerCase();
const collections = new Set(['accounts', 'profiles', 'sessions', 'users', 'records', 'entries', 'items', 'list']);
const wrappers = new Set(['data', 'result', 'results', 'payload', 'response', 'export', 'credentials', 'credential', 'credentialjson', 'credentialsjson', 'auth', 'authjson', 'authdata', 'oauth', 'session', 'sessionjson', 'tokens', ...collections]);
const ignored = new Set(['metadata', 'meta', 'settings', 'config', 'configuration', 'stats', 'statistics', 'usage', 'history', 'logs', 'cookies', 'headers', 'cache', 'proto', 'constructor', 'prototype']);
const accessKeys = ['access_token', 'accessToken'];
const refreshKeys = ['refresh_token', 'refreshToken'];
const idKeys = ['id_token', 'idToken'];
const accountKeys = ['account_id', 'accountId'];

/** Aliases must agree. In particular, never silently choose between two token generations. */
function stringField(value: ObjectValue, keys: string[], required = false): string | undefined {
  const fields = keys.filter(key => own(value, key) && value[key] != null && value[key] !== '');
  if (fields.some(key => typeof value[key] !== 'string')) throw new Error('凭据字段类型不正确');
  const strings = fields.map(key => value[key] as string).filter(field => field.trim());
  if (new Set(strings).size > 1) throw new Error('同一项包含冲突的凭据字段，请检查后重新导入');
  if (required && !strings.length) throw new Error('凭据不完整，缺少登录所需的 Token');
  return strings[0];
}
function nameOf(value: ObjectValue): string | undefined {
  for (const key of ['name', 'label', 'displayName', 'display_name', 'profileName', 'profile_name', 'nickname', 'profile']) {
    const name = safeName(value[key]);
    if (name) return name;
  }
}
function safeName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return;
  try { validateName(value.trim()); return value.trim(); } catch { return; }
}
function optionalText(value: ObjectValue, keys: string[]): string | undefined {
  return keys.map(key => value[key]).find(field => typeof field === 'string' && field.trim()) as string | undefined;
}
function oauthFields(value: ObjectValue, required = false): ObjectValue {
  return {
    access_token: stringField(value, accessKeys, required), refresh_token: stringField(value, refreshKeys, required),
    id_token: stringField(value, idKeys), account_id: stringField(value, accountKeys), email: optionalText(value, ['email']),
  };
}
function nestedObject(value: unknown): ObjectValue {
  // Exporters sometimes serialize the auth object twice; decoding is bounded.
  for (let i = 0; i < 4 && typeof value === 'string'; i++) {
    value = parseCredentialJson(value);
  }
  if (!record(value)) throw new Error('凭据内容必须是 JSON 对象');
  return value;
}

function tokenContainer(value: unknown): boolean {
  for (let i = 0; i < 4 && typeof value === 'string'; i++) {
    if (!/^[\s\uFEFF]*[\[{"`~]/.test(value)) return false;
    value = parseCredentialJson(value);
  }
  return record(value) && [...accessKeys, ...refreshKeys, ...idKeys, ...accountKeys].some(key => own(value, key));
}

function codexMode(value: ObjectValue, expected: string): string | undefined {
  const mode = stringField(value, ['auth_mode', 'authMode']);
  if (mode && mode !== expected) throw new Error('此登录类型与凭据不一致，暂不支持导入');
  return mode;
}

function codexTokenMetadata(value: ObjectValue): ObjectValue {
  const raw = value.oauth_provenance ?? value.oauthProvenance;
  let provenance: ObjectValue | undefined;
  if (raw != null) {
    const p = nestedObject(raw);
    provenance = { issuer: stringField(p, ['issuer'], true), client_id: stringField(p, ['client_id', 'clientId'], true) };
    if (own(value, 'oauth_provenance') && own(value, 'oauthProvenance') && value.oauthProvenance != null) {
      const alias = nestedObject(value.oauthProvenance);
      if (provenance.issuer !== stringField(alias, ['issuer'], true) || provenance.client_id !== stringField(alias, ['client_id', 'clientId'], true)) throw new Error('同一项包含冲突的 OAuth 来源字段');
    }
  }
  return { oauth_provenance: provenance, login_owner_id: stringField(value, ['login_owner_id', 'loginOwnerId']) };
}

/** Project one self-contained credential onto fields understood by our clients. */
function normalize(value: ObjectValue, selectedAgent?: string): { agent: AgentId; auth: ObjectValue } | undefined {
  const hints = ['platform', 'provider', 'agent', 'type'].flatMap(key => typeof value[key] === 'string' ? [value[key].trim().toLowerCase()] : []);
  // A retired provider's wrapper must not be walked as a generic access/refresh token pair.
  if (own(value, 'claudeAiOauth') || hints.some(hint => /^(?:claude(?:[ _-]?code)?|anthropic)$/.test(hint))) {
    throw new Error('该平台的账号凭据暂不支持导入');
  }
  // Container names alone are not proof of credentials (e.g. an export's "tokens" statistics).
  const codexTokens = own(value, 'tokens') && tokenContainer(value.tokens);
  const apiKey = value.OPENAI_API_KEY != null && (typeof value.OPENAI_API_KEY !== 'string' || Boolean(value.OPENAI_API_KEY.trim()));
  if (codexTokens && apiKey) throw new Error('同一项包含多种登录凭据，请拆分后导入');
  const flat = [...accessKeys, ...refreshKeys].some(key => own(value, key));
  const token = own(value, 'token') && tokenContainer(value.token);
  if (!codexTokens && !apiKey && !flat && !token) return;
  const detected = codexTokens || apiKey ? 'codex' : token ? 'agy' : selectedAgent;
  if ((detected !== 'codex' && detected !== 'agy') || (selectedAgent && detected !== selectedAgent)) throw new Error('无法识别该平台的客户端凭据');
  const platforms: Record<string, string> = { codex: 'codex', openai: 'codex', chatgpt: 'codex', agy: 'agy', antigravity: 'agy' };
  if (hints.some(hint => own(platforms, hint) && platforms[hint] !== detected)) throw new Error('凭据的平台标识与所选平台不一致');
  if (detected === 'codex') {
    if (apiKey) return { agent: detected, auth: { OPENAI_API_KEY: stringField(value, ['OPENAI_API_KEY'], true), auth_mode: codexMode(value, 'apikey') } };
    const tokenSource = codexTokens ? nestedObject(value.tokens) : value;
    const tokens = { ...oauthFields(tokenSource, true), ...codexTokenMetadata(tokenSource) };
    const lastRefresh = optionalText(value, ['last_refresh', 'lastRefresh']);
    const timestamp = lastRefresh && Number.isFinite(Date.parse(lastRefresh))
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(lastRefresh) ? lastRefresh : new Date(lastRefresh).toISOString()
      : undefined;
    return { agent: detected, auth: { tokens, auth_mode: codexMode(value, 'chatgpt'), last_refresh: timestamp } };
  }
  const source = token ? nestedObject(value.token) : value;
  const fields = oauthFields(source);
  if (!fields.access_token && !fields.refresh_token) throw new Error('凭据不完整，缺少登录所需的 Token');
  const idTokenEmail = stringField(value, ['id_token_email', 'idTokenEmail']) || (token ? optionalText(value, ['email']) : undefined);
  // Antigravity has a native outer id_token / id_token_email; it belongs to this same credential record.
  return { agent: detected, auth: { ...(token ? { token: { ...fields, expiry: optionalText(source, ['expiry']) } } : fields),
    ...(token ? { id_token: stringField(value, idKeys) } : {}),
    ...(idTokenEmail ? { id_token_email: idTokenEmail } : {}),
    expiry: optionalText(value, ['expiry']), auth_method: optionalText(value, ['auth_method']),
  } };
}

/** Discover account records without joining fields from different nodes or traversing caches. */
export function parseCredentialDocument(data: Buffer, agent?: string): { entries: CredentialEntry[]; collection: boolean } {
  if (data.length > 32 * 1024 * 1024) throw new Error('凭据文件超过 32 MB');
  const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(data); }
  catch { throw new Error('凭据文件编码损坏，请使用 UTF-8 或带 BOM 的 UTF-16 文件'); }
  const root = parseCredentialJson(text);
  const entries: CredentialEntry[] = [];
  let nodes = 0, decodedBytes = 0, collection = false;
  const add = (entry: CredentialEntry) => {
    if (entries.length >= 200) throw new Error('一次最多导入 200 个账号');
    entries.push(entry);
  };
  const visit = (input: unknown, depth: number, name?: string, required = false): void => {
    if (++nodes > 30000 || depth > 24) throw new Error('JSON 结构过于复杂，请精简后导入');
    let value = input;
    if (typeof value === 'string' && /^[\s\uFEFF]*[\[{"`~]/.test(value)) {
      decodedBytes += Buffer.byteLength(value);
      if (decodedBytes > 64 * 1024 * 1024) throw new Error('嵌套 JSON 内容过大');
      try { value = parseCredentialJson(value); }
      catch { if (required) add({ name, error: '此项不是有效的 JSON 凭据' }); return; }
      visit(value, depth + 1, name, required); return;
    }
    if (Array.isArray(value)) {
      collection = true;
      for (const child of value) visit(child, depth + 1, undefined, required);
      return;
    }
    if (!record(value)) {
      if (required) add({ name, error: '此项不是完整的账号凭据对象' });
      return;
    }
    name = nameOf(value) || name;
    let credentials: ReturnType<typeof normalize>;
    try { credentials = normalize(value, agent); }
    catch (error) { add({ name, error: (error as Error).message }); return; }
    if (credentials) {
      const bytes = Buffer.from(JSON.stringify(credentials.auth));
      add(bytes.length > 1024 * 1024 ? { name, error: '单个账号凭据超过 1 MB' } : { name, data: bytes, agent: credentials.agent });
      return; // Never descend into tokens or accidentally interpret one account twice.
    }
    const before = entries.length;
    const children = Object.entries(value).filter(([key, child]) => !ignored.has(keyName(key)) && (record(child) || Array.isArray(child) || typeof child === 'string' && /^[\s\uFEFF]*[\[{"`~]/.test(child)));
    for (const [key, child] of children) {
      const field = keyName(key);
      if (collections.has(field)) collection = true;
      visit(child, depth + 1, wrappers.has(field) || children.length === 1 && name ? name : safeName(key), collections.has(field));
    }
    if (entries.length === before && required) add({ name, error: '未找到完整的客户端凭据；单段 Session / Cookie 不支持导入' });
  };
  visit(root, 0, undefined, true);
  if (!entries.length) throw new Error('未找到可导入的账号凭据');
  return { entries, collection: collection || entries.length > 1 };
}
