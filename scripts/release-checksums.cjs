const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function main() {
  const files = process.argv.slice(2).map(file => path.resolve(file));
  if (!files.length) throw new Error('请传入本次发布的 DMG 路径');
  const directory = path.dirname(files[0]);
  if (new Set(files).size !== files.length || files.some(file =>
    path.dirname(file) !== directory || !/^[\w.-]+\.dmg$/.test(path.basename(file)))) {
    throw new Error('请选择同一目录中的 DMG，文件名只使用字母、数字、点、下划线和连字符，不重复选择');
  }
  const lines = [];
  for (const file of files) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${path.basename(file)}`);
  }
  const target = path.join(directory, 'SHA256SUMS');
  fs.writeFileSync(target, lines.join('\n') + '\n');
  console.log(target);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
