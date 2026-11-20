#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'out', 'site');

const STATIC_FILES = ['index.html', 'styles.css', 'app.js'];

const SHARED_ASSETS = [
  ['packaging/app-icon.png', 'assets/app-icon.png'],
  ['assets/gate-mark.png', 'assets/gate-mark.png'],
  ['assets/wind-trace.svg', 'assets/wind-trace.svg'],
];

function buildSite(outDir = DEFAULT_OUT) {
  const imagesDir = path.join(ROOT, 'docs', 'images');
  const images = fs.readdirSync(imagesDir).filter(name => name.toLowerCase().endsWith('.png'));
  const files = [
    ...STATIC_FILES.map(name => [path.join('site', name), name]),
    ...SHARED_ASSETS,
    ...images.map(name => [path.join('docs', 'images', name), 'images/' + name]),
  ];
  const marker = path.join(outDir, '.nojekyll');
  const signature = 'AgentSwitcher Pages\n';
  fs.mkdirSync(outDir, { recursive: true });
  const invalidOutput = new Error('请选择空目录或已有的 AGS 官网构建目录，已有文件已保留');
  if (!fs.lstatSync(outDir).isDirectory()) throw invalidOutput;
  if (fs.readdirSync(outDir).length) {
    const known = new Set(files.map(([, destination]) => destination).concat('.nojekyll'));
    if (!fs.lstatSync(marker, { throwIfNoEntry: false })?.isFile()) throw invalidOutput;
    for (const entry of fs.readdirSync(outDir, { recursive: true, withFileTypes: true })) {
      const name = path.relative(outDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
      if (entry.isDirectory() && (name === 'assets' || name === 'images')) continue;
      if (!entry.isFile() || !known.has(name)) throw invalidOutput;
    }
    // Previous builds used an empty Pages marker. Recognize their AGS landing page before replacing it.
    const contents = fs.readFileSync(marker, 'utf8');
    if (contents !== signature) {
      const index = path.join(outDir, 'index.html');
      if (contents || !fs.existsSync(index) || !fs.readFileSync(index, 'utf8').includes('<title>AgentSwitcher · AGS')) throw invalidOutput;
    }
  }
  fs.writeFileSync(marker, signature);
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
  for (const [srcRel, destRel] of files) {
    fs.copyFileSync(path.join(ROOT, srcRel), path.join(outDir, destRel));
  }
  return outDir;
}

if (require.main === module) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT;
  const built = buildSite(target);
  console.log(`Built GitHub Pages site -> ${path.relative(ROOT, built) || built}`);
}

module.exports = { buildSite, DEFAULT_OUT };
