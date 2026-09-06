import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MEDIA_BYTES, MEDIA_ACCEPT, assertMediaInput, configureMediaInput } from '../media-input.mjs';

test('the media picker explicitly accepts audio-bearing MP4 and M4A files',()=>{
  assert.match(MEDIA_ACCEPT,/\.mp4/);
  assert.match(MEDIA_ACCEPT,/\.m4a/);
  assert.match(MEDIA_ACCEPT,/video\/mp4/);
  const input={accept:''};configureMediaInput(input);assert.equal(input.accept,MEDIA_ACCEPT);
});

test('media validation permits bounded containers and rejects empty or oversized input',()=>{
  const media={size:MAX_MEDIA_BYTES};
  assert.equal(assertMediaInput(media),media);
  assert.throws(()=>assertMediaInput({size:0}),/empty/);
  assert.throws(()=>assertMediaInput({size:MAX_MEDIA_BYTES+1}),/64 MB/);
});