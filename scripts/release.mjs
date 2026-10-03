import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extensionId, verifyCrx } from './crx.mjs';

const execute = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = '1.1.0';
const output = path.join(root, 'local', `release-${version}`);
const runtime = path.join(output, 'runtime');
const baseName = `interceptor-${version}`;
const zipPath = path.join(output, baseName + '.zip');
const crxPath = path.join(output, baseName + '.crx');
const archiveScript = path.join(root, 'scripts', 'release-archive.py');
const allowlist = Object.freeze([
  'manifest.json', 'background.js', 'http.js', 'workbench.js', 'workflow.js',
  'workflow-ui.js', 'workflow.css', 'lab.js', 'lab-ui.js', 'lab.css', 'local-store.js',
  'layout.js', 'layout.css',
  'dashboard.html', 'dashboard.js', 'dashboard.css', 'popup.html', 'popup.js', 'popup.css',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
]);

function options() {
  const result = { browser: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', reference: 'local/interceptor-1.0.1.crx' };
  const flags = { '--sign': 'sign', '--verify': 'verify', '--require-crx': 'requireCrx', '--self-test': 'selfTest', '--help': 'help' };
  const values = { '--key': 'key', '--browser': 'browser', '--reference': 'reference' };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (flags[arg]) result[flags[arg]] = true;
    else if (values[arg] && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) result[values[arg]] = process.argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (result.help) return result;
  if (result.verify && result.sign) throw new Error('Use --verify or --sign separately.');
  if (result.key && !result.sign) throw new Error('--key is accepted only with explicit --sign.');
  if (result.sign && !result.key) throw new Error('--sign requires --key PATH pointing to the existing private key.');
  return result;
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function checkSource() {
  assert.equal(allowlist.length, 23);
  for (const name of allowlist) {
    const info = await fs.lstat(path.join(root, name));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Runtime input must be a regular file: ${name}`);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== version || packageJson.version !== version || manifest.manifest_version !== 3) throw new Error('Release requires version 1.1.0 and Manifest V3.');
  const references = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  for (const html of ['dashboard.html', 'popup.html']) {
    const source = await fs.readFile(path.join(root, html), 'utf8');
    for (const match of source.matchAll(/(?:src|href)="([^"]+)"/g)) if (!/^(?:https?:|#)/.test(match[1])) references.push(match[1]);
  }
  if (references.some((name) => !allowlist.includes(name))) throw new Error('Manifest or HTML references a file outside the runtime allowlist.');
}

async function archive(operation, file, allowIconsDirectory = false, source = root) {
  const args = [archiveScript, operation, '--source', source, '--archive', file, '--files', JSON.stringify(allowlist)];
  if (allowIconsDirectory) args.push('--allow-icons-directory');
  const { stdout } = await execute('python3', args, { cwd: root, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

async function signedIdentity(file, reference) {
  const result = verifyCrx(await fs.readFile(file));
  const previous = verifyCrx(await fs.readFile(reference));
  if (result.extensionId !== previous.extensionId || result.publicKeySha256 !== previous.publicKeySha256) throw new Error('Signed package identity differs from the previous release.');
  return { extensionId: result.extensionId, publicKeySha256: result.publicKeySha256, signature: result.signature, matchesPreviousRelease: true };
}

async function artifact(file) {
  const bytes = await fs.readFile(file);
  return { filename: path.basename(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function checkStaging() {
  const actual = [];
  const walk = async (directory, prefix = '') => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name + '/');
      else if (entry.isFile()) actual.push(name);
      else throw new Error('Runtime staging contains an unexpected link or entry.');
    }
  };
  await walk(runtime);
  assert.deepEqual(actual.sort(), [...allowlist].sort(), 'Runtime staging does not match the allowlist.');
  for (const name of allowlist) {
    assert.ok((await fs.readFile(path.join(runtime, name))).equals(await fs.readFile(path.join(root, name))), `Staged runtime differs from source: ${name}`);
  }
}

async function checkReports(artifacts, files, signedCrx) {
  const expected = artifacts.map((item) => `${item.sha256}  ${item.filename}`).join('\n') + '\n';
  assert.equal(await fs.readFile(path.join(output, 'SHA256SUMS'), 'utf8'), expected, 'Recorded checksums do not match artifacts.');
  const report = JSON.parse(await fs.readFile(path.join(output, 'verification.json'), 'utf8'));
  assert.equal(report.version, version);
  assert.equal(report.runtimeFiles, allowlist.length);
  assert.deepEqual(report.artifacts, artifacts, 'Verification report does not match artifacts.');
  assert.deepEqual(report.files, files, 'Verification report does not match runtime files.');
  assert.deepEqual(report.signedCrx, signedCrx, 'Verification report does not match CRX signature results.');
}

async function selfTest(reference) {
  const previous = await fs.readFile(reference);
  const verified = verifyCrx(previous);
  assert.match(verified.extensionId, /^[a-p]{32}$/);
  assert.equal(extensionId(Buffer.from('00112233445566778899aabbccddeeff', 'hex')), 'aabbccddeeffgghhiijjkkllmmnnoopp');
  const tampered = Buffer.from(previous);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => verifyCrx(tampered), /signature verification failed/);
  assert.throws(() => verifyCrx(previous.subarray(0, 10)), /magic/);
  const broken = Buffer.from(previous);
  broken.writeUInt32LE(0xffffffff, 8);
  assert.throws(() => verifyCrx(broken), /header length/);
  await fs.mkdir(path.join(root, 'local'), { recursive: true });
  const fixture = await fs.mkdtemp(path.join(root, 'local', 'release-validator-'));
  try {
    const source = path.join(fixture, 'source');
    await fs.mkdir(path.join(source, 'icons'), { recursive: true });
    for (const name of allowlist) await fs.copyFile(path.join(root, name), path.join(source, name));
    const first = path.join(fixture, 'first.zip'), second = path.join(fixture, 'second.zip');
    await archive('create', first, false, source);
    await archive('create', second, false, source);
    assert.ok((await fs.readFile(first)).equals(await fs.readFile(second)), 'Repeated ZIP creation is not deterministic.');
    await execute('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"a"); z.writestr("docs/unexpected.txt","synthetic fixture"); z.close()', first]);
    await assert.rejects(archive('verify', first, false, source), /exact runtime allowlist/);
    await fs.appendFile(path.join(source, 'http.js'), '\n// changed synthetic source fixture\n');
    await assert.rejects(archive('verify', second, false, source), /differs from source/);
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
  console.log(`PASS: existing CRX3 RSA signature/identity (${verified.extensionId}); tampered CRX, malformed headers, extra archive entries and source drift rejected; deterministic ZIP creation verified.`);
}

async function main() {
  const opts = options();
  if (opts.help) {
    console.log(`Prepare Interceptor ${version} from an exact 23-file runtime allowlist.

Usage:
  npm run release                         Stage runtime and create/verify ZIP only
  npm run release:sign -- --key local/key.pem
                                          Create ZIP and CRX using the EXISTING key
  npm run release:verify                  Recheck ZIP/CRX against current source
  npm run release:check                   Test CRX verifier using previous release

Options:
  --sign --key PATH     Explicitly invoke the browser packer; key contents are never read
  --verify             Verify existing artifacts without staging or signing
  --require-crx        Fail verification if the signed CRX is absent
  --browser PATH       Browser executable (default: installed macOS Brave)
  --reference PATH     Previous signed CRX (default: local/interceptor-1.0.1.crx)
  --self-test          Verify previous signature and reject malformed/tampered CRX
  --help               Show this help

Requirements: Node.js 22+, Python 3 standard library (zipfile), no dependencies
or zip binary to install. Signing also requires Chromium/Brave, the existing
private key, and the previous signed CRX. Never generate a replacement key.
Outputs: local/release-${version}/runtime/, ZIP, optional CRX, SHA256SUMS,
and verification.json. No upload, commit, tag, or publication is performed.`);
    return;
  }
  const reference = path.resolve(root, opts.reference);
  if (opts.selfTest) { await selfTest(reference); return; }
  await checkSource();
  if (!opts.verify) {
    if (opts.sign) {
      const key = path.resolve(root, opts.key);
      const keyInfo = await fs.lstat(key);
      if (!keyInfo.isFile() || keyInfo.isSymbolicLink()) throw new Error('The signing-key argument must be an existing regular file.');
      if (!await exists(opts.browser)) throw new Error('Browser executable is unavailable; pass --browser PATH.');
      verifyCrx(await fs.readFile(reference));
    }
    await fs.mkdir(output, { recursive: true });
    await fs.rm(runtime, { recursive: true, force: true });
    await fs.mkdir(path.join(runtime, 'icons'), { recursive: true });
    await fs.rm(crxPath, { force: true });
    await fs.rm(runtime + '.crx', { force: true });
    for (const name of allowlist) await fs.copyFile(path.join(root, name), path.join(runtime, name));
    await archive('create', zipPath);
    if (opts.sign) {
      // The browser consumes the existing key directly. No process reads its
      // contents into this script, its report, console, ZIP, or CRX payload.
      const packerProfile = await fs.mkdtemp(path.join(output, 'packer-profile-'));
      try {
        await execute(opts.browser, [`--user-data-dir=${packerProfile}`, `--pack-extension=${runtime}`, `--pack-extension-key=${path.resolve(root, opts.key)}`, '--no-message-box'], { timeout: 60_000, maxBuffer: 1_000_000 });
      } catch (error) {
        throw new Error(`Browser packer failed (${error.code || 'process error'}). No private-key contents were read or printed.`);
      } finally { await fs.rm(packerProfile, { recursive: true, force: true }); }
      if (!await exists(runtime + '.crx')) throw new Error('Browser packer produced no CRX.');
      await fs.rename(runtime + '.crx', crxPath);
    }
  }
  await checkStaging();
  const zip = await archive('verify', zipPath);
  const artifacts = [await artifact(zipPath)];
  let crx = null;
  if (await exists(crxPath)) {
    crx = await signedIdentity(crxPath, reference);
    const payload = await archive('verify', crxPath, true);
    assert.deepEqual(payload.files, zip.files, 'ZIP and CRX runtime payloads differ.');
    artifacts.push(await artifact(crxPath));
  } else if (opts.requireCrx || opts.sign) throw new Error('Signed CRX is missing. Run release:sign with the existing key.');
  let commit = null, sourceWorkingTreeDirty = null;
  try {
    commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    sourceWorkingTreeDirty = !!(await execute('git', ['status', '--porcelain'], { cwd: root })).stdout.trim();
  } catch { /* source download */ }
  const report = { version, manifestVersion: 3, generatedAt: new Date().toISOString(), sourceCommit: commit, sourceWorkingTreeDirty, runtimeFiles: zip.runtimeFiles, exactSourceMatch: true, zipCrxPayloadMatch: crx ? true : null, artifacts, signedCrx: crx, files: zip.files };
  if (!opts.verify) {
    await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(path.join(output, 'SHA256SUMS'), artifacts.map((item) => `${item.sha256}  ${item.filename}`).join('\n') + '\n');
  }
  await checkReports(artifacts, zip.files, crx);
  console.log(`PASS: ${version}, ${zip.runtimeFiles} runtime files, ZIP matches source${crx ? ', CRX RSA signature verified, identity matches previous release, ZIP/CRX contents identical' : '; unsigned ZIP only'}.`);
  console.log(path.relative(root, output));
  for (const item of artifacts) console.log(`${item.filename}: ${item.bytes} bytes · SHA-256 ${item.sha256}`);
}

main().catch((error) => { console.error(`Release validation failed: ${error.message}`); process.exitCode = 1; });
