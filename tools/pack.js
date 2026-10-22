'use strict';
/**
 * 打出两个文件：
 *   release/DeskGlow-Setup-<version>.exe   第一次安装，或连 Electron 一起换
 *   release/DeskGlow-<version>.dgupdate    只替换 resources，配置不动
 *
 * 用 Electron 自带的 Node 跑（打包发布.bat 会设 ELECTRON_RUN_AS_NODE）。
 * 安装包由系统自带的 IExpress 打出来，不需要再装 electron-builder。
 */
process.noAsar = true;

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const iexpress = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'iexpress.exe');
const work = path.join(path.dirname(root), 'DeskGlowRelease');
const stage = path.join(work, 'stage');
const bundle = path.join(work, 'bundle');
const outDir = path.join(work, 'out');
const releaseDir = path.join(root, 'release');

function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function globMatch(rel, pattern) {
  const norm = String(rel).replace(/\\/g, '/');
  const pat = String(pattern).replace(/\\/g, '/');
  if (pat.endsWith('/**/*')) {
    const prefix = pat.slice(0, -5);
    return norm === prefix || norm.startsWith(prefix + '/');
  }
  if (pat.endsWith('/**')) {
    const prefix = pat.slice(0, -3);
    return norm.startsWith(prefix + '/');
  }
  return norm.toLowerCase() === pat.toLowerCase();
}

function align4(n) {
  return (4 - (n % 4)) % 4;
}

function pickleString(str) {
  const bytes = Buffer.from(str, 'utf8');
  const pad = align4(bytes.length);
  const payload = Buffer.alloc(4 + bytes.length + pad);
  payload.writeUInt32LE(bytes.length, 0);
  bytes.copy(payload, 4);
  const wrapped = Buffer.alloc(4 + payload.length);
  wrapped.writeUInt32LE(payload.length, 0);
  payload.copy(wrapped, 4);
  return wrapped;
}

function pickleUInt32(value) {
  const wrapped = Buffer.alloc(8);
  wrapped.writeUInt32LE(4, 0);
  wrapped.writeUInt32LE(value >>> 0, 4);
  return wrapped;
}

function readAsarHeader(buf) {
  if (buf.readUInt32LE(0) !== 4) throw new Error('asar 头不对');
  const headerPickleLen = buf.readUInt32LE(4);
  const payloadSize = buf.readUInt32LE(8);
  if (payloadSize + 4 !== headerPickleLen) throw new Error('asar 头长度对不上');
  const jsonLen = buf.readUInt32LE(12);
  const json = buf.slice(16, 16 + jsonLen).toString('utf8');
  return { header: JSON.parse(json), dataStart: 8 + headerPickleLen };
}

function checkStockAsar() {
  const sample = path.join(electronDist, 'resources', 'default_app.asar');
  const parsed = readAsarHeader(fs.readFileSync(sample));
  if (!parsed.header.files) fail('读不懂 Electron 自带的 asar，打包停了');
  log('asar 格式已对照 Electron 自带包核对');
}

function walkDir(dir, rel, include, unpack, state) {
  const names = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
  const files = {};
  for (const name of names) {
    if (name === '_err.txt') continue;
    const full = path.join(dir, name);
    const childRel = rel ? rel + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      const sub = walkDir(full, childRel, include, unpack, state);
      if (Object.keys(sub.files).length) files[name] = sub;
      continue;
    }
    if (!st.isFile()) continue;
    if (!include.some((p) => globMatch(childRel, p))) continue;
    if (unpack.some((p) => globMatch(childRel, p))) {
      files[name] = { size: st.size, unpacked: true };
      const out = path.join(state.unpackedRoot, ...childRel.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(full, out);
      state.unpacked.push(childRel);
    } else {
      const data = fs.readFileSync(full);
      files[name] = { size: data.length, offset: String(state.offset) };
      state.chunks.push(data);
      state.offset += data.length;
      state.packed.push(childRel);
    }
  }
  return { files };
}

function writeAsar(stageDir) {
  const include = (pkg.build && pkg.build.files) || ['src/**/*', 'package.json'];
  const unpack = (pkg.build && pkg.build.asarUnpack) || ['src/main/ps/**'];
  const unpackedRoot = path.join(stageDir, 'resources', 'app.asar.unpacked');
  const state = { offset: 0, chunks: [], packed: [], unpacked: [], unpackedRoot };
  const tree = { files: {} };

  const pkgRel = 'package.json';
  if (!include.some((p) => globMatch(pkgRel, p))) fail('package.json 不在打包列表里');
  const pkgBytes = fs.readFileSync(path.join(root, 'package.json'));
  tree.files['package.json'] = { size: pkgBytes.length, offset: '0' };
  state.chunks.push(pkgBytes);
  state.offset += pkgBytes.length;
  state.packed.push(pkgRel);

  const srcDir = path.join(root, 'src');
  const srcTree = walkDir(srcDir, 'src', include, unpack, state);
  if (!srcTree.files || !Object.keys(srcTree.files).length) fail('src 里没有可打包的文件');
  tree.files.src = srcTree;

  if (!state.unpacked.includes('src/main/ps/zorder.ps1')) {
    fail('zorder.ps1 没有拆到 app.asar.unpacked，PowerShell 会读不到');
  }
  for (const must of ['src/preload.js', 'src/main/main.js', 'src/renderer/panel.html', 'src/renderer/dock.js']) {
    if (!state.packed.includes(must)) fail('缺少 ' + must);
  }
  const zorderFile = path.join(state.unpackedRoot, 'src', 'main', 'ps', 'zorder.ps1');
  const zorderHead = fs.readFileSync(zorderFile).subarray(0, 3);
  if (zorderHead[0] !== 0xEF || zorderHead[1] !== 0xBB || zorderHead[2] !== 0xBF) {
    fail('zorder.ps1 丢了 UTF-8 BOM');
  }

  const headerPickle = pickleString(JSON.stringify(tree));
  const sizePickle = pickleUInt32(headerPickle.length);
  const asarPath = path.join(stageDir, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(asarPath, Buffer.concat([sizePickle, headerPickle, ...state.chunks]));

  const buf = fs.readFileSync(asarPath);
  const parsed = readAsarHeader(buf);
  const entry = parsed.header.files['package.json'];
  const got = buf.slice(parsed.dataStart + Number(entry.offset), parsed.dataStart + Number(entry.offset) + entry.size);
  if (!got.equals(pkgBytes)) fail('asar 里的 package.json 和源文件不一致');
  log('app.asar 已写入，' + state.packed.length + ' 个文件在包内，' + state.unpacked.length + ' 个拆到外面');
  return { asarPath, unpackedRoot, packed: state.packed, unpacked: state.unpacked };
}

function writeIcon(dest) {
  // 正式图标：方案二（磨砂 Dock 条），七档尺寸 16-256，源文件在 src/main/assets/icon.ico
  const src = path.join(root, 'src', 'main', 'assets', 'icon.ico');
  if (!fs.existsSync(src)) fail('找不到 ' + src);
  fs.copyFileSync(src, dest);
  log('图标已复制 ' + src);
}

function copyRuntime() {
  if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
    fail('找不到 Electron 运行时。请先双击「安装依赖.bat」。');
  }
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(electronDist, stage, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'default_app.asar' && base !== 'electron.exe';
    },
  });
  fs.copyFileSync(path.join(electronDist, 'electron.exe'), path.join(stage, 'DeskGlow.exe'));
  fs.mkdirSync(path.join(stage, 'resources'), { recursive: true });
  if (!fs.existsSync(path.join(stage, 'locales'))) fail('Electron 运行时不完整（没有 locales）');
  log('运行时已复制');
}

function copyPs1(src, dest) {
  const text = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  fs.writeFileSync(dest, Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from(text, 'utf8'),
  ]));
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function listFiles(dir, rel) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const child = rel ? rel + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, child));
    else if (st.isFile()) out.push(child.replace(/\\/g, '/'));
  }
  return out;
}

function makeUpdate(asarInfo) {
  fs.mkdirSync(releaseDir, { recursive: true });
  const updateRoot = path.join(work, 'update');
  const resDir = path.join(updateRoot, 'resources');
  fs.mkdirSync(resDir, { recursive: true });
  fs.copyFileSync(asarInfo.asarPath, path.join(resDir, 'app.asar'));
  fs.cpSync(asarInfo.unpackedRoot, path.join(resDir, 'app.asar.unpacked'), { recursive: true });
  const files = listFiles(resDir, 'resources').sort().map((rel) => ({
    path: rel,
    sha256: sha256(path.join(updateRoot, ...rel.split('/'))),
  }));
  const manifest = { product: 'deskglow', version, files };
  fs.writeFileSync(path.join(updateRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const dest = path.join(releaseDir, 'DeskGlow-' + version + '.dgupdate');
  if (fs.existsSync(dest)) fs.rmSync(dest);
  const zip = path.join(work, 'update.zip');
  const packed = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', updateRoot, '.'], {
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
  });
  if (packed.status !== 0) fail('更新包压缩失败');
  fs.copyFileSync(zip, dest);
  log('更新包 ' + dest + '  ' + mb(dest));
  return dest;
}

function mb(file) {
  return (fs.statSync(file).size / 1024 / 1024).toFixed(1) + ' MB';
}

function zipStage() {
  fs.mkdirSync(bundle, { recursive: true });
  const zip = path.join(bundle, 'payload.zip');
  log('正在压缩安装内容，这一步要几分钟');
  const packed = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', stage, '.'], {
    stdio: 'inherit',
    timeout: 20 * 60 * 1000,
  });
  if (packed.status !== 0 || !fs.existsSync(zip) || fs.statSync(zip).size < 40 * 1024 * 1024) {
    fail('安装内容压缩失败');
  }
  log('安装内容 ' + mb(zip));
  copyPs1(path.join(root, 'tools', 'install.ps1'), path.join(bundle, 'install.ps1'));
  fs.writeFileSync(path.join(bundle, 'install.cmd'), [
    '@echo off',
    'cd /d "%~dp0"',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"',
    'if errorlevel 1 pause',
    '',
  ].join('\r\n'));
  fs.rmSync(stage, { recursive: true, force: true });
  return zip;
}

function writeSed(setupExe) {
  const sed = [
    '[Version]',
    'Class=IEXPRESS',
    'SEDVersion=3',
    '[Options]',
    'PackagePurpose=InstallApp',
    'ShowInstallProgramWindow=1',
    'HideExtractAnimation=1',
    'UseLongFileName=1',
    'InsideCompressed=1',
    'CAB_FixedSize=0',
    'CAB_ResvCodeSigning=0',
    'RebootMode=N',
    'InstallPrompt=%InstallPrompt%',
    'DisplayLicense=%DisplayLicense%',
    'FinishMessage=%FinishMessage%',
    'TargetName=%TargetName%',
    'FriendlyName=%FriendlyName%',
    'AppLaunched=%AppLaunched%',
    'PostInstallCmd=%PostInstallCmd%',
    'AdminQuietInstCmd=%AdminQuietInstCmd%',
    'UserQuietInstCmd=%UserQuietInstCmd%',
    'SourceFiles=SourceFiles',
    '[Strings]',
    'InstallPrompt=Install DeskGlow?',
    'DisplayLicense=',
    'FinishMessage=',
    'TargetName=' + setupExe,
    'FriendlyName=DeskGlow',
    'AppLaunched=cmd.exe /c install.cmd',
    'PostInstallCmd=<None>',
    'AdminQuietInstCmd=',
    'UserQuietInstCmd=',
    'FILE0="payload.zip"',
    'FILE1="install.cmd"',
    'FILE2="install.ps1"',
    '[SourceFiles]',
    'SourceFiles0=' + bundle,
    '[SourceFiles0]',
    '%FILE0%=',
    '%FILE1%=',
    '%FILE2%=',
    '',
  ].join('\r\n');
  const sedPath = path.join(work, 'setup.sed');
  fs.writeFileSync(sedPath, sed);
  return sedPath;
}

function makeInstaller() {
  if (!fs.existsSync(iexpress)) {
    log('这台电脑没有 iexpress.exe，安装包停在 ' + bundle);
    return null;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const setupExe = path.join(outDir, 'DeskGlow-Setup-' + version + '.exe');
  const sedPath = writeSed(setupExe);
  log('正在做安装包，压缩大约要几分钟');
  const packed = spawnSync(iexpress, ['/N', '/Q', sedPath], {
    stdio: 'inherit',
    timeout: 20 * 60 * 1000,
  });
  if (packed.status !== 0 || !fs.existsSync(setupExe) || fs.statSync(setupExe).size < 40 * 1024 * 1024) {
    log('IExpress 没有打出安装包。可以直接运行 ' + path.join(bundle, 'install.cmd'));
    return null;
  }
  const dest = path.join(releaseDir, path.basename(setupExe));
  fs.copyFileSync(setupExe, dest);
  log('安装包 ' + dest + '  ' + mb(dest));
  return dest;
}

function main() {
  log('DeskGlow ' + version);
  checkStockAsar();
  copyRuntime();
  const asarInfo = writeAsar(stage);
  writeIcon(path.join(stage, 'icon.ico'));
  fs.writeFileSync(path.join(stage, 'version.txt'), version + '\r\n');
  copyPs1(path.join(root, 'tools', 'uninstall.ps1'), path.join(stage, 'uninstall.ps1'));
  const updateFile = makeUpdate(asarInfo);
  zipStage();
  const setupFile = makeInstaller();
  if (setupFile) {
    fs.rmSync(work, { recursive: true, force: true });
    log('完成');
    log(setupFile);
    log(updateFile);
  } else {
    log('安装包 exe 没做成，压缩好的安装内容还在 ' + bundle);
    log(updateFile);
    process.exitCode = 1;
  }
}

main();
