// Probe for #3104: patch the shared fs exports BEFORE importing
// path-security, record which realpathSync variant each side calls, then
// print a JSON verdict. Run as a child process — see
// browse/test/path-security-windows-realpath.test.ts.
const fs = require('fs') as typeof import('fs');
const calls: string[] = [];
const real = fs.realpathSync;
const realNative = real.native;
(fs as any).realpathSync = Object.assign(
  (p: string) => { calls.push('js'); return real(p); },
  { native: (p: string) => { calls.push('native'); return realNative(p); } },
);
const root = process.argv[2]!;
const sec = await import(`${root}/browse/src/path-security.ts`);
const importCalls = calls.slice();
calls.length = 0;
try { sec.validateReadPath('/tmp/a.txt'); } catch { /* existence is not the point */ }
const readCalls = calls.slice();
calls.length = 0;
try { sec.validateTempPath('/tmp/a.txt'); } catch { /* existence is not the point */ }
const tempCalls = calls.slice();
console.log(JSON.stringify({ safe: sec.SAFE_DIRECTORIES.length > 0, importCalls, readCalls, tempCalls }));
