import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { byteRange } from '../audio-response.mjs';
import { createAegisServer } from '../server.mjs';

test('audio byte range parser supports open, bounded and suffix requests',()=>{
  assert.deepEqual(byteRange('bytes=4-9',20),{start:4,end:9,partial:true});
  assert.deepEqual(byteRange('bytes=4-',20),{start:4,end:19,partial:true});
  assert.deepEqual(byteRange('bytes=-5',20),{start:15,end:19,partial:true});
  assert.deepEqual(byteRange('bytes=0-999',20),{start:0,end:19,partial:true});
  assert.deepEqual(byteRange(undefined,20),{start:0,end:19,partial:false});
  for(const header of ['bytes=20-','bytes=-0','bytes=4-2','bytes=-','bytes=0-1,4-5','bad'])assert.equal(byteRange(header,20),null,header);
});

test('real bundled WAV supports range seeking and invalid ranges',async()=>{
  const server=createAegisServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}/demo-audio/digital-arrest.wav`;
  try{
    const head=await fetch(url,{method:'HEAD'});
    assert.equal(head.status,200);assert.equal(head.headers.get('accept-ranges'),'bytes');
    const size=Number(head.headers.get('content-length'));
    const first=await fetch(url,{headers:{Range:'bytes=0-11'}});
    assert.equal(first.status,206);
    assert.equal(first.headers.get('content-range'),`bytes 0-11/${size}`);
    const bytes=Buffer.from(await first.arrayBuffer());
    assert.equal(bytes.length,12);assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');
    const suffix=await fetch(url,{headers:{Range:'bytes=-64'}});
    assert.equal((await suffix.arrayBuffer()).byteLength,64);
    const invalid=await fetch(url,{headers:{Range:`bytes=${size}-`}});
    assert.equal(invalid.status,416);assert.equal(invalid.headers.get('content-range'),`bytes */${size}`);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
