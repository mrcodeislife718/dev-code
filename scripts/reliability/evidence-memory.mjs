#!/usr/bin/env node
/**
 * Evidence-first reliability layer for DevCode. Node built-ins only.
 * Commands: record <json-file>, distill, assess <json-file>, compare <baseline.json> <candidate.json>
 * State is project-local under .devcode-factory/reliability (override DEVCODE_RELIABILITY_DIR).
 * No model training, self-modifying execution, or deployment privileges.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { evaluateAdaptiveStrategy } from './factory-guard.mjs';

const root = resolve(process.env.DEVCODE_RELIABILITY_DIR || '.devcode-factory/reliability');
const events = join(root, 'events.jsonl');
const notes = join(root, 'verified-notes.json');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const json = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
const lines = async () => { try { return (await readFile(events, 'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x)); } catch(e) { if(e.code==='ENOENT') return []; throw e; } };
const atomic = async (p, value) => { await mkdir(dirname(p), {recursive:true}); const tmp=p+'.'+randomUUID()+'.tmp'; await writeFile(tmp, JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600}); await rename(tmp,p); };
const allowed = new Set(['observation','failure','verified-fix','decision','retraction']);
export function validateEvent(e) {
 if (!e || typeof e !== 'object' || !allowed.has(e.kind)) throw Error('Invalid event kind');
 for(const k of ['project','subject','claim','evidence']) if(typeof e[k] !== 'string' || !e[k].trim() || e[k].length>8192) throw Error('Missing/invalid '+k);
 if(e.kind==='verified-fix' && (!e.checks || !Array.isArray(e.checks) || !e.checks.length || e.checks.some(x=>typeof x!=='string'||!x.trim()))) throw Error('Verified fixes require named passing checks');
 if(e.kind==='verified-fix' && (typeof e.host_proof_id !== 'string' || !e.host_proof_id || typeof e.revision !== 'string' || !e.revision)) throw Error('Verified fixes require host proof ID and source revision');
 return {id:randomUUID(),time:new Date().toISOString(),kind:e.kind,project:e.project,subject:e.subject,claim:e.claim,evidence:e.evidence,checks:e.checks||[],supersedes:e.supersedes||null,host_proof_id:e.host_proof_id||null,revision:e.revision||null,host_verified:false};
}
export function distillEvents(history) {
 const withdrawn=new Set(history.filter(x=>x.kind==='retraction').map(x=>x.supersedes).filter(Boolean));
 const byKey=new Map();
 for(const e of history) {
   if(e.kind!=='verified-fix' || e.host_verified !== true || !e.host_proof_id || !e.revision || withdrawn.has(e.id) || !Array.isArray(e.checks) || !e.checks.length) continue;
   const key=e.project+'\u0000'+e.subject;
   const prev=byKey.get(key);
   if(!prev || e.time>prev.time) byKey.set(key,e);
 }
 return [...byKey.values()].map(e=>({project:e.project,subject:e.subject,claim:e.claim,evidence:e.evidence,checks:e.checks,source_event_id:e.id,verified_at:e.time,revision:e.revision,host_proof_id:e.host_proof_id})).sort((a,b)=>a.project.localeCompare(b.project)||a.subject.localeCompare(b.subject));
}
export function assess(history, candidate) {
 const recent=history.filter(x=>x.project===candidate.project && x.subject===candidate.subject);
 const failures=recent.filter(x=>x.kind==='failure').length;
 const verified=recent.filter(x=>x.kind==='verified-fix' && x.host_verified===true).length;
 return {project:candidate.project,subject:candidate.subject,failures,verified_fixes:verified,requires_independent_verification: true, recommendation: failures>=2?'investigate-repeated-failure':failures===1?'verify-proposed-fix':'run-baseline-tests'};
}
export function compare(b,c) {
 for(const x of [b,c]) for(const k of ['passed','failed','duration_ms']) if(!Number.isFinite(x[k]) || x[k]<0) throw Error('Invalid metric '+k);
 const accepted=c.failed===0 && c.passed>=b.passed && c.duration_ms<=Math.max(b.duration_ms*1.25,b.duration_ms+1000);
 return {accepted,reason:accepted?'measured-candidate-passes':'regression-or-unverified-candidate',baseline:b,candidate:c};
}
const observed = async () => {
  try {
    const data = await readFile(join(root, 'host-events.jsonl'), 'utf8');
    return data.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};
const matchesProof = (host, id, revision) =>
  host.some(e => e.schema === 1 && e.id === id &&
    e.revision === revision && e.type === 'verified-checks' && e.passed === true);

async function main() {
 const [cmd,...args]=process.argv.slice(2);
 if(cmd==='record') {
   const e=validateEvent(await json(resolve(args[0]),null));
   if (e.kind === 'verified-fix') {
     if (!matchesProof(await observed(), e.host_proof_id, e.revision))
       throw Error('A matching host-observed verification event is required');
     e.host_verified = true;
   }
   await mkdir(root,{recursive:true});
   // Append-only evidence log; single-writer use only, external lock required for concurrent writers.
   const {open}=await import('node:fs/promises');
   const handle = await open(events,'a',0o600);
   try { await handle.writeFile(JSON.stringify(e)+'\n'); await handle.sync(); }
   finally { await handle.close(); }
   console.log(JSON.stringify({recorded:e.id,digest:sha(JSON.stringify(e))}));
 } else if(cmd==='distill') {
   const result=distillEvents(await lines());
   await atomic(notes,{schema:1,generated_at:new Date().toISOString(),notes:result});
   console.log(JSON.stringify({verified_notes:result.length,path:notes}));
 } else if(cmd==='assess') {
   const candidate=await json(resolve(args[0]),null);
   if(!candidate || typeof candidate.project!=='string' || typeof candidate.subject!=='string') throw Error('Candidate needs project and subject');
   console.log(JSON.stringify(assess(await lines(),candidate),null,2));
 } else if(cmd==='compare') {
   console.log(JSON.stringify(compare(await json(resolve(args[0]),null),await json(resolve(args[1]),null)),null,2));
 } else if(cmd==='evaluate-strategy') {
   const [b,c]=await Promise.all(args.slice(0,2).map(p=>json(resolve(p),null)));
   const host=await observed();
   const attested=x=>({ ...x,hostVerified:matchesProof(host,x?.proofId,x?.revision) });
   console.log(JSON.stringify(evaluateAdaptiveStrategy(attested(b),attested(c)),null,2));
 } else throw Error('Usage: record <event.json> | distill | assess <candidate.json> | compare <baseline.json> <candidate.json> | evaluate-strategy <baseline.json> <candidate.json>');
}
if(process.argv[1] && import.meta.url===new URL('file://'+resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
