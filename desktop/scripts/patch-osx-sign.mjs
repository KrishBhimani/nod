import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const originalHash = '602c58064d4d406fffa6d2d1faae0b8aeb033f460c81ce1b7c639ef02f75fdda';
const patchedHash = '02a57fc7f38e3769bc5827b3c212b0d8fc7f9ffbe56eabefd0141434a517d70f';
const hash = (source) => createHash('sha256').update(source).digest('hex');

export async function patchSigningDiscovery(
  directory = dirname(dirname(fileURLToPath(import.meta.resolve('@electron/osx-sign')))),
) {
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (metadata.name !== '@electron/osx-sign' || metadata.version !== '2.7.1')
    throw new Error('The signing discovery patch requires @electron/osx-sign 2.7.1.');
  const target = join(directory, 'dist/util.js');
  const source = await readFile(target, 'utf8');
  const digest = hash(source);
  if (digest === patchedHash) return;
  if (digest !== originalHash)
    throw new Error(
      'The signing SDK source changed; review the discovery patch before installing.',
    );
  const patched = source
    .replace(
      '        return await Promise.all(children.map(async (child) => {',
      '        const results = [];\n        for (const child of children) {\n            results.push(await (async () => {',
    )
    .replace(
      '        }));\n    }\n    const allPaths',
      '            })());\n        }\n        return results;\n    }\n    const allPaths',
    );
  if (hash(patched) !== patchedHash) throw new Error('The signing discovery patch did not match.');
  await writeFile(target, patched);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await patchSigningDiscovery();
