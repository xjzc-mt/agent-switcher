// Install only after the test has isolated os.homedir(); never access the real keychain.
const os = require('node:os'), path = require('node:path');
for (const [variable, directory] of [['CODEX_HOME', '.codex'], ['CLAUDE_CONFIG_DIR', '.claude']]) {
  const configured = process.env[variable];
  if (!configured || !path.resolve(configured).startsWith(os.homedir() + path.sep)) {
    process.env[variable] = path.join(os.homedir(), directory);
  }
}
require('../dist/credential-vault').setCredentialKeyProvider({
  read: () => Buffer.alloc(32, 7),
  create: () => { throw new Error('The fixture key already exists'); },
});
const native = require('../dist/antigravity-native');
native.readNativeToken = () => null;
native.writeNativeToken = () => { throw new Error('Native credential writes need an explicit fixture'); };

exports.readCredentialFile = (file, encoding) => {
  const bytes = require('../dist/utils').readBuffer(file);
  if (bytes === null) throw Object.assign(new Error('Fixture file not found'), { code: 'ENOENT' });
  return encoding ? bytes.toString(encoding) : bytes;
};
