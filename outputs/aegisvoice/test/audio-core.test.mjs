import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AudioChunker,encodeWav,rms} from '../audio-core.mjs';
test('continuous speech flushes at max window without losing or duplicating samples',()=>{
 const output=[],segmenter=new AudioChunker(1000,x=>output.push(x));
 for(let i=0;i<82;i++)segmenter.push(new Float32Array(100).fill(i/100));segmenter.flush();
 assert.equal(output.reduce((n,x)=>n+x.pcm.length,0),8200);assert.equal(output.length,2);
 assert.equal(output[1].start,8);assert.equal(output[1].end,8.2);
 assert.ok(Math.abs(output[1].pcm[0]-.8)<1e-6);
});
test('silence boundary flushes speech after minimum window and preserves time',()=>{
 const output=[],segmenter=new AudioChunker(1000,x=>output.push(x));
 segmenter.push(new Float32Array(2600).fill(.2));segmenter.push(new Float32Array(500));
 assert.equal(output.length,1);assert.equal(output[0].end,3.1);segmenter.flush();assert.equal(output.length,1);
});
test('WAV encoding has a valid mono PCM header and clips signed samples',()=>{
 const wav=encodeWav(new Float32Array([-2,0,2]),48000),view=new DataView(wav);
 assert.equal(new TextDecoder().decode(new Uint8Array(wav,0,4)),'RIFF');
 assert.equal(view.getUint32(24,true),48000);assert.equal(view.getUint16(22,true),1);
 assert.equal(view.getUint32(40,true),6);assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(48,true),32767);
});
test('silence RMS is zero and signed speech energy is retained',()=>{assert.equal(rms(new Float32Array()),0);assert.equal(rms(new Float32Array([-.5,.5])),.5);});
