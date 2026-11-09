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
 return {id:randomUUID(),time:new Date().toISOString(),kind:e.kind,project:e.project,subject:e.subject,claim:e.claim,evidence:e.evidence,checks:e.checks||[],supersedes:e.supersedes||null};
}
export function distillEvents(history) {
 const withdrawn=new Set(history.filter(x=>x.kind==='retraction').map(x=>x.supersedes).filter(Boolean));
 const byKey=new Map();
 for(const e of history) {
   if(e.kind!=='verified-fix' || withdrawn.has(e.id) || !Array.isArray(e.checks) || !e.checks.length) continue;
   const key=e.project+'\u0000'+e.subject;
   const prev=byKey.get(key);
   if(!prev || e.time>prev.time) byKey.set(key,e);
 }
 return [...byKey.values()].map(e=>({project:e.project,subject:e.subject,claim:e.claim,evidence:e.evidence,checks:e.checks,source_event_id:e.id,verified_at:e.time})).sort((a,b)=>a.project.localeCompare(b.project)||a.subject.localeCompare(b.subject));
}
export function assess(history, candidate) {
 const recent=history.filter(x=>x.project===candidate.project && x.subject===candidate.subject);
 const failures=recent.filter(x=>x.kind==='failure').length;
 const verified=recent.filter(x=>x.kind==='verified-fix').length;
 return {project:candidate.project,subject:candidate.subject,failures,verified_fixes:verified,requires_independent_verification: true, recommendation: failures>=2?'investigate-repeated-failure':failures===1?'verify-proposed-fix':'run-baseline-tests'};
}
export function compare(b,c) {
 for(const x of [b,c]) for(const k of ['passed','failed','duration_ms']) if(!Number.isFinite(x[k]) || x[k]<0) throw Error('Invalid metric '+k);
 const accepted=c.failed===0 && c.passed>=b.passed && c.duration_ms<=Math.max(b.duration_ms*1.25,b.duration_ms+1000);
 return {accepted,reason:accepted?'measured-candidate-passes':'regression-or-unverified-candidate',baseline:b,candidate:c};
}
async function main() {
 const [cmd,...args]=process.argv.slice(2);
 if(cmd==='record') {
   const e=validateEvent(await json(resolve(args[0]),null));
   await mkdir(root,{recursive:true});
   // Append-only evidence log; single-writer use only, external lock required for concurrent writers.
   const {appendFile}=await import('node:fs/promises');
   await appendFile(events,JSON.stringify(e)+'\n',{mode:0o600});
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
 } else throw Error('Usage: record <event.json> | distill | assess <candidate.json> | compare <baseline.json> <candidate.json>');
}
if(process.argv[1] && import.meta.url===new URL('file://'+resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
