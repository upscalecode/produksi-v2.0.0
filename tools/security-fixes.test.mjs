import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
test('frontend clears on-time reason after arrival becomes late', () => {
  const script=fs.readFileSync(new URL('../public/script.js',import.meta.url),'utf8');
  const body=script.match(/const syncDowntime = \(\) => \{([\s\S]*?)\r?\n    \};/)[1];
  const option={};
  const ctx={arrival:{value:'08:15'},productionStart:{},productionStartTime:'08:30',minutes:{},reason:{value:'',querySelector:()=>option},note:{},syncNote(){},minutesOfDay:v=>v?Number(v.slice(0,2))*60+Number(v.slice(3)):null};
  const run=()=>vm.runInNewContext('(function(){'+body+'})()',ctx);
  run(); assert.equal(ctx.reason.value,'Tepat Waktu');
  ctx.arrival.value='09:00';run();assert.equal(ctx.reason.value,'');assert.equal(ctx.minutes.value,'30');assert.equal(option.disabled,true);
});
