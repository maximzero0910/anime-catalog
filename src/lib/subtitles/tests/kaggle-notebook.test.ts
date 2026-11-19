import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Kaggle notebook stays single-cell and renews its backend lease during inference',async()=>{
  const notebook=JSON.parse(await readFile(new URL('../../../../notebooks/anineko_translation_worker.ipynb',import.meta.url),'utf8')) as {cells:Array<{cell_type:string;source:string[]}>};
  const code=notebook.cells.filter(cell=>cell.cell_type==='code');
  assert.equal(code.length,1);
  const source=code[0]!.source.join('');
  assert.match(source,/secrets\.get_secret\("ANINEKO_API_URL"\)/);
  assert.match(source,/secrets\.get_secret\("ANINEKO_WORKER_TOKEN"\)/);
  assert.match(source,/AninekoKaggleWorker\/1\.0/);
  assert.match(source,/def heartbeat_job\(job_id\):/);
  assert.match(source,/\/api\/worker\/heartbeat/);
  assert.match(source,/worker lease lost before checkpoint/);
  assert.match(source,/worker lease lost before completion/);
  assert.match(source,/HEARTBEAT_STOP\.set\(\); heartbeat\.join\(timeout=16\)/);
});
