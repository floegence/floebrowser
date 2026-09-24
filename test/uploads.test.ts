import assert from 'node:assert/strict';
import test from 'node:test';
import { open, readFile } from 'node:fs/promises';
import { UploadBudget } from '../src/host/uploads.js';

async function* bytes(value: string) {
  yield Buffer.from(value);
}

test('uploads stream into private staging and only current opaque identities select source paths', async () => {
  const budget = new UploadBudget({ bytes: 100, files: 3 });
  const batch = budget.create(false);
  const id = await batch.write({ name: '例.txt', size: 5 }, bytes('hello'));
  const paths = await batch.readyPaths([id]);
  const file = await open(paths[0]!, 'r');
  try {
    assert.equal(await file.readFile('utf8'), 'hello');
    assert.equal((await file.stat()).mode & 0o077, 0);
  } finally {
    await file.close();
  }
  assert.throws(() => batch.paths(['/etc/passwd']));
  assert.throws(() => batch.paths([id, id]));
  batch.commit();
  await assert.rejects(batch.write({ name: 'late', size: 0 }, bytes('')));
  await batch.close();
  await assert.rejects(readFile(paths[0]!));
});

test('upload limits account for concurrent and retained files and reject truncated or excess bytes', async () => {
  const budget = new UploadBudget({ bytes: 10, files: 2 });
  const a = budget.create(false),
    b = budget.create(false);
  const id = await a.write({ name: 'a', size: 8 }, bytes('12345678'));
  a.commit();
  await assert.rejects(b.write({ name: 'b', size: 3 }, bytes('123')));
  await assert.rejects(b.write({ name: 'b', size: 2 }, bytes('1')));
  await assert.rejects(b.write({ name: 'b', size: 1 }, bytes('123')));
  const last = await b.write({ name: 'b', size: 2 }, bytes('12'));
  assert.ok(b.paths([last]));
  assert.ok(a.paths([id]));
  await a.close();
  await b.close();
});

test('directory uploads preserve one relative tree while rejecting traversal and conflicting names', async () => {
  const batch = new UploadBudget().create(true);
  for (const relativePath of ['../a', '/a', 'root/../a', 'root\\a', 'root//a'])
    await assert.rejects(
      batch.write({ name: 'a', size: 1, relativePath }, bytes('x')),
    );
  const id = await batch.write(
    { name: 'a', size: 1, relativePath: 'folder/nested/a' },
    bytes('x'),
  );
  await assert.rejects(
    batch.write({ name: 'a', size: 1, relativePath: 'other/a' }, bytes('y')),
  );
  await assert.rejects(
    batch.write(
      { name: 'a', size: 1, relativePath: 'folder/nested/a' },
      bytes('y'),
    ),
  );
  const [folder] = await batch.readyPaths([id]);
  assert.equal(await readFile(`${folder}/nested/a`, 'utf8'), 'x');
  await batch.close();
});

test('revoking an upload aborts a stalled producer and releases its reservation', async () => {
  const budget = new UploadBudget({ bytes: 1, files: 1 });
  const batch = budget.create(false);
  const body = {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) };
    },
  };
  const writing = batch.write({ name: 'a', size: 1 }, body);
  await batch.close();
  await assert.rejects(writing);
  const next = budget.create(false);
  await next.write({ name: 'b', size: 1 }, bytes('b'));
  await next.close();
});
