import { execFile, execFileSync } from 'child_process';
import type { KeychainEntry } from './antigravity-keyring';

const JXA_KEYCHAIN_QUERY = [
  'ObjC.import("Foundation");ObjC.import("Security");ObjC.import("stdlib");',
  'if($.SecKeychainSetUserInteractionAllowed(false)!==0)$.exit(1);',
  'const q=$.NSMutableDictionary.alloc.init;',
  'q.setObjectForKey($("genp"),$("class"));q.setObjectForKey($("gemini"),$("svce"));q.setObjectForKey($("antigravity"),$("acct"));',
].join('');
// Use an item's persistent reference across queries. Several search-list keychains can match the same name.
const JXA_UNIQUE_ITEM = JXA_KEYCHAIN_QUERY + `
  function copy(query) {
    const out = Ref();
    const status = $.SecItemCopyMatching($.CFBridgingRetain(query), out);
    if (status !== 0) $.exit(status === -25300 ? 44 : 77);
    return ObjC.castRefToObject(out[0]);
  }
  q.setObjectForKey($.NSNumber.numberWithBool(true), $("r_PersistentRef"));
  q.setObjectForKey($.NSNumber.numberWithBool(true), $("r_Attributes"));
  q.setObjectForKey($("m_LimitAll"), $("m_Limit"));
  function uniqueItem() {
    const results = copy(q);
    if (Number(results.count) !== 1) $.exit(78);
    const item = results.objectAtIndex(0);
    const ref = item.objectForKey($("v_PersistentRef"));
    const date = item.objectForKey($("mdat")).timeIntervalSinceReferenceDate;
    if (!(Number(ref.length) > 0) || !Number.isFinite(date)) $.exit(78);
    return { ref, revision: ObjC.unwrap(ref.base64EncodedStringWithOptions(0)) + "/" + date };
  }
`;
const JXA_KEYCHAIN_REVISION = JXA_UNIQUE_ITEM + '\n// AGS_KEYCHAIN_REVISION\nuniqueItem().revision;';
const JXA_UNLOCKED_ITEM = JXA_UNIQUE_ITEM + `
  // Legacy Security opaque out parameters need Objective-C object storage. With the
  // default BridgeSupport signature Ref()[0] can be CFNull even after errSecSuccess.
  ObjC.bindFunction("SecKeychainItemCopyFromPersistentReference", ["int", ["id", "id *"]]);
  ObjC.bindFunction("SecKeychainItemCopyKeychain", ["int", ["id", "id *"]]);
  ObjC.bindFunction("SecKeychainGetStatus", ["int", ["id", "uint32_t *"]]);
  const entry = uniqueItem(), item = Ref(), keychain = Ref(), flags = Ref();
  if ($.SecKeychainItemCopyFromPersistentReference(entry.ref, item) !== 0 ||
      $.CFGetTypeID(item[0]) !== $.SecKeychainItemGetTypeID() ||
      $.SecKeychainItemCopyKeychain(item[0], keychain) !== 0 ||
      $.CFGetTypeID(keychain[0]) !== $.SecKeychainGetTypeID() ||
      $.SecKeychainGetStatus(keychain[0], flags) !== 0 || (Number(flags[0]) & 3) !== 3) $.exit(77);
`;
const JXA_SHARED_REVISION = JXA_UNLOCKED_ITEM + '\n// AGS_SHARED_QUOTA_REVISION\nentry.revision;';
const JXA_READ_ROUTE = JXA_UNLOCKED_ITEM + `
  // AGS_SECURITY_READ_ROUTE
  function readRoute() {
    const query = $.NSMutableDictionary.alloc.init;
    query.setObjectForKey(entry.ref, $("v_PersistentRef"));
    query.setObjectForKey($.NSNumber.numberWithBool(true), $("r_Data"));
    const data = Ref(), result = $.SecItemCopyMatching($.CFBridgingRetain(query), data);
    if (result === 0) {
      const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
      stdout.writeData($("N").dataUsingEncoding(4));
      stdout.writeData(ObjC.castRefToObject(data[0]));
      return;
    }
    if (result !== -25293 && result !== -25308) $.exit(78);
    // Only a verified, unlocked item that explicitly allows Apple's security tool
    // is eligible for the second reader. Inspect the very same item as the native read.
    ObjC.bindFunction("SecKeychainItemCopyAccess", ["int", ["id", "id *"]]);
    ObjC.bindFunction("SecAccessCopyMatchingACLList", ["id", ["id", "id"]]);
    ObjC.bindFunction("SecACLCopyContents", ["int", ["id", "id *", "id *", "uint16_t *"]]);
    ObjC.bindFunction("SecTrustedApplicationCopyData", ["int", ["id", "id *"]]);
    const access = Ref();
    if ($.SecKeychainItemCopyAccess(item[0], access) !== 0 || $.CFGetTypeID(access[0]) !== $.SecAccessGetTypeID()) $.exit(77);
    function contents(list, index) {
      const apps = Ref(), description = Ref(), prompt = Ref();
      if ($.SecACLCopyContents(list.objectAtIndex(index), apps, description, prompt) !== 0 || (Number(prompt[0]) & 1)) return;
      return { apps: apps[0], description: description[0] };
    }
    function permitsSecurity() {
      const decrypt = $.SecAccessCopyMatchingACLList(access[0], ObjC.castRefToObject($.kSecACLAuthorizationDecrypt));
      for (let i = 0; i < Number(decrypt.count); i++) {
        const acl = contents(decrypt, i);
        if (!acl) continue;
        for (let j = 0; j < Number(acl.apps.count); j++) {
          const bytes = Ref();
          if ($.SecTrustedApplicationCopyData(acl.apps.objectAtIndex(j), bytes) !== 0) continue;
          const name = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes[0], 4));
          if (name === "/usr/bin/security" || name === "/usr/bin/security\\0") return true;
        }
      }
      return false;
    }
    const partitions = $.SecAccessCopyMatchingACLList(access[0], ObjC.castRefToObject($.kSecACLAuthorizationPartitionID));
    if (Number(partitions.count) !== 1 || !permitsSecurity()) $.exit(77);
    const acl = contents(partitions, 0);
    if (!acl || !acl.description) $.exit(77);
    const hex = ObjC.unwrap(acl.description);
    if (typeof hex !== "string" || hex.length > 65536 || !/^(?:[a-f0-9]{2})+$/i.test(hex)) $.exit(77);
    const plist = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError($("<" + hex + ">").propertyList, 0, null, null);
    if (!plist || !ObjC.deepUnwrap(plist).Partitions.includes("apple-tool:")) $.exit(77);
    return "T" + entry.revision;
  }
  readRoute();
`;
function keychainRetirementScript(nativeReader: boolean): string {
  return JXA_UNIQUE_ITEM + `
    const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    const expected = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, 4)));
    const current = uniqueItem();
    if (current.revision !== expected.revision) $.exit(78);
    const one = $.NSMutableDictionary.alloc.init;
    one.setObjectForKey($.NSArray.arrayWithObject(current.ref), $("m_ItemList"));
    ${nativeReader ? `
      const query = one.mutableCopy;
      query.setObjectForKey($.NSNumber.numberWithBool(true), $("r_Data"));
      if (!copy(query).isEqualToData($(expected.raw).dataUsingEncoding(4))) $.exit(78);
    ` : ''}
    const status = $.SecItemDelete($.CFBridgingRetain(one));
    if (status !== 0) $.exit(status === -25300 ? 44 : 77);
  `;
}

const keychainItem = ['-s', 'gemini', '-a', 'antigravity'];
export const keychainAccessError = 'AGS 暂时无法读取 Antigravity 的当前登录。请确认登录钥匙串可访问后，回到 AGS 重试。';
export let keychainAccessBlocked = false;
let noToolReadRevision: string | undefined;
export let keychainWriteBlocked = false;

export function retryNativeKeychainAccess(): void {
  noToolReadRevision = undefined;
  keychainAccessBlocked = false;
  keychainWriteBlocked = false;
}

export function sharedMacRevision(): string | undefined {
  try {
    return execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SHARED_REVISION], {
      encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || undefined;
  } catch { return undefined; }
}

interface ReadReply { raw?: string; code?: number }
type ReadRequest = [string, string[]];
const keychainReadOptions = { encoding: 'utf8' as const, maxBuffer: 2 * 1024 * 1024, timeout: 1500 };

/** The dashboard executes this same no-UI read sequence asynchronously; commits recheck synchronously. */
function* macKeychainRead(checkOnly = false): Generator<ReadRequest, KeychainEntry, ReadReply> {
  const route = yield ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_READ_ROUTE]];
  if (route.code === 44 || route.raw?.startsWith('N')) {
    keychainAccessBlocked = false;
    return route.code === 44 ? { raw: null } : { raw: route.raw!.slice(1), nativeReadable: true };
  }
  if (!route.raw?.startsWith('T') || route.raw.length === 1) throw new Error(keychainAccessError);
  const revision = route.raw.slice(1);
  if (noToolReadRevision === revision) throw new Error(keychainAccessError);
  if (checkOnly) return { raw: null };
  const result = yield ['/usr/bin/security', ['find-generic-password', ...keychainItem, '-w']];
  if (result.raw !== undefined || result.code === 44) {
    // The search list or item can change between the two executables. Recheck
    // the unique item's revision before associating the returned data with it.
    const after = yield ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SHARED_REVISION]];
    if (result.raw !== undefined && after.raw === revision) {
      keychainAccessBlocked = false;
      return { raw: result.raw, sharedRevision: revision };
    }
    if (result.code === 44 && after.code === 44) { keychainAccessBlocked = false; return { raw: null }; }
  } else {
    noToolReadRevision = revision;
    keychainAccessBlocked = true;
  }
  throw new Error(keychainAccessError);
}

function readMacKeychainSync(checkOnly: boolean): KeychainEntry {
  const plan = macKeychainRead(checkOnly);
  let next = plan.next();
  while (!next.done) {
    let reply: ReadReply;
    try { reply = { raw: execFileSync(...next.value, { ...keychainReadOptions, stdio: 'pipe' }).trim() }; }
    catch (error) { reply = { code: (error as { status?: number }).status }; }
    next = plan.next(reply);
  }
  return next.value;
}

export function readMacKeychain(): KeychainEntry { return readMacKeychainSync(false); }

export async function readMacKeychainAsync(): Promise<KeychainEntry> {
  const plan = macKeychainRead();
  let next = plan.next();
  while (!next.done) {
    const [file, args] = next.value;
    const reply = await new Promise<ReadReply>(resolve => {
      execFile(file, args, keychainReadOptions, (error, stdout) => resolve(error
        ? { code: typeof error.code === 'number' ? error.code : undefined } : { raw: stdout.trim() }));
    });
    next = plan.next(reply);
  }
  return next.value;
}

export function canReadNormalQuotaLogin(): boolean {
  try { readMacKeychainSync(true); return true; } catch { return false; }
}

function keychainCommand(encoded: string): string {
  return `add-generic-password -U -s gemini -a antigravity -w "${encoded}"\n`;
}

export function fitsMacKeychain(raw: string): boolean {
  return Buffer.byteLength(keychainCommand(raw)) < 4000 && /^[A-Za-z0-9+/=:_-]*$/.test(raw);
}

export function macKeychainWriteIssue(encoded: string | null, previous: KeychainEntry): string | undefined {
  if (previous.raw === encoded && !previous.nativeReadable) return;
  if (previous.nativeReadable || (previous.raw !== null && !fitsMacKeychain(previous.raw)) ||
      (encoded !== null && !fitsMacKeychain(encoded))) {
    return '本次写入无法保留官方客户端的钥匙串访问权限，已保留原登录';
  }
}

export function writeMacKeychain(encoded: string | null): void {
  try {
    if (encoded === null) {
      execFileSync('/usr/bin/security', ['delete-generic-password', ...keychainItem], { stdio: 'pipe', timeout: 1500 });
    } else {
      execFileSync('/usr/bin/security', ['-i'], { input: keychainCommand(encoded), timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
    }
  } catch (error) {
    if (encoded === null && (error as { status?: number }).status === 44) return;
    const failure = error as NodeJS.ErrnoException & { status?: number };
    if (failure.code === 'ETIMEDOUT' || failure.status === 36 || failure.status === 51 || failure.status === 128) keychainWriteBlocked = true;
    throw new Error(encoded === null ? '无法还原 Antigravity 未登录状态' : '无法更新 Antigravity Keychain 凭据');
  }
}

export function prepareMacRetirement(): string {
  const revision = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_KEYCHAIN_REVISION], {
    encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!revision) throw new Error('无法唯一识别原钥匙串条目');
  return revision;
}

export function retireMacKeychain(entry: KeychainEntry, revision: string): void {
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', keychainRetirementScript(entry.nativeReadable === true)], {
    input: JSON.stringify({ raw: entry.raw, revision }), timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
