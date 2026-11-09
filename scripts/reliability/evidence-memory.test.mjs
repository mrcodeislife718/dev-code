import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent,distillEvents,assess,compare } from './evidence-memory.mjs';

test('reject unverified fixes',()=>{
 assert.throws(()=>validateEvent({kind:'verified-fix',project:'devcode',subject:'restart',claim:'fixed',evidence:'log'}),/checks/);
});
test('distill verified only, retain provenance and honor retractions',()=>{
 const h=[
 {id:'a',time:'2026-01-01',kind:'verified-fix',project:'devcode',subject:'restart',claim:'works',evidence:'test log',checks:['restart-test']},
 {id:'b',time:'2026-01-02',kind:'verified-fix',project:'devcode',subject:'resume',claim:'works',evidence:'test log',checks:['resume-test']},
 {id:'c',time:'2026-01-03',kind:'retraction',supersedes:'a'}
 ];
 const n=distillEvents(h);
 assert.equal(n.length,1);assert.equal(n[0].source_event_id,'b');
});
test('detect repeated failures',()=>{
 const h=[{kind:'failure',project:'devcode',subject:'build'},{kind:'failure',project:'devcode',subject:'build'}];
 assert.equal(assess(h,{project:'devcode',subject:'build'}).recommendation,'investigate-repeated-failure');
});
test('candidate acceptance blocks failed tests and slowdowns',()=>{
 const b={passed:10,failed:0,duration_ms:1000};
 assert.equal(compare(b,{passed:10,failed:0,duration_ms:1100}).accepted,true);
 assert.equal(compare(b,{passed:10,failed:1,duration_ms:1100}).accepted,false);
 assert.equal(compare(b,{passed:9,failed:0,duration_ms:1100}).accepted,false);
 assert.equal(compare(b,{passed:10,failed:0,duration_ms:2500}).accepted,false);
});
