import { createHash, timingSafeEqual } from 'node:crypto';
import { saveBody, readBody, getJob, logJob, storeValidatedArtifact, updateJob, recoverStaleJobs, jobStats, claimKaggleJobs, heartbeatKaggleLease, kaggleQueueDiagnostics } from './storage';
import { formatTime, parseSubtitle, serializeSubtitle, type NormalizedSubtitle, type SubtitleFormat } from './normalize';
import { validateTranslation } from './qa';
import { downloadTrack } from './acquire';
import { subtitleConfig } from './config';
import { enqueueEligible } from './queue';

const leaseMs = 120_000;
const modelName = process.env.SUBTITLE_GPU_MODEL || 'facebook/nllb-200-distilled-600M';
let lastAutomaticQueueScan = 0;
function spokenText(value:string):string {
  return value.replace(/\{[^}]*\}|<[^>]+>/g,'').replace(/\\N/g,'\n').replace(/\\[nh]/g,' ').trim();
}
function toKaggleSrt(subtitle:NormalizedSubtitle):string {
  const cues=subtitle.cues.map((cue,index)=>{
    const text=spokenText(cue.originalText)||`ANINEKO_NON_SPEECH_${index+1}`;
    return `${index+1}\n${formatTime(cue.start,true)} --> ${formatTime(cue.end,true)}\n${text}`;
  });
  return `${cues.join('\n\n')}\n`;
}
function parseWorkerSubtitle(input:string,sourceFormat:SubtitleFormat):NormalizedSubtitle {
  try { return parseSubtitle(input,sourceFormat); }
  catch (preferredError) {
    if(sourceFormat==='srt') throw preferredError;
    return parseSubtitle(input);
  }
}
function alignWorkerCues(source:NormalizedSubtitle,translated:NormalizedSubtitle):NormalizedSubtitle {
  const cues:NormalizedSubtitle['cues']=[];
  let translatedIndex=0;
  for(const cue of source.cues){
    const candidate=translated.cues[translatedIndex];
    if(candidate&&candidate.start===cue.start&&candidate.end===cue.end){
      const text=spokenText(cue.originalText).length===0
        ? cue.originalText
        : restoreFormatting(cue.originalText,candidate.originalText);
      cues.push({...cue,translatedText:text});
      translatedIndex++;
      continue;
    }
    if(spokenText(cue.originalText).length===0){
      cues.push({...cue,translatedText:cue.originalText});
      continue;
    }
    throw new Error(`timestamp mismatch or missing translated cue at ${cue.id}`);
  }
  if(translatedIndex!==translated.cues.length) throw new Error(`cue parity failed ${translated.cues.length}/${source.cues.length}`);
  return {...source,cues};
}
function restoreFormatting(sourceText:string,translatedText:string):string {
  const tags=[...sourceText.matchAll(/\{[^}]*\}|<[^>]+>/g)].map(match=>({tag:match[0],at:match.index??0}));
  if(!tags.length) return translatedText;
  const plain=sourceText.replace(/\{[^}]*\}|<[^>]+>/g,'');
  const edits=tags.map((item,index)=>{
    const plainOffset=sourceText.slice(0,item.at).replace(/\{[^}]*\}|<[^>]+>/g,'').length;
    return {tag:item.tag,index:Math.max(0,Math.min(translatedText.length,Math.round((plainOffset/Math.max(1,plain.length))*translatedText.length))),order:index};
  }).sort((a,b)=>a.index-b.index||a.order-b.order);
  let result='',cursor=0;
  for(const edit of edits){result+=translatedText.slice(cursor,edit.index)+edit.tag;cursor=edit.index;}
  return result+translatedText.slice(cursor);
}
function tokenMatches(request: Request): boolean {
  const configured = process.env.ANINEKO_WORKER_TOKEN;
  if (!configured || configured.length < 32) return false;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(configured); const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function authorizeKaggleWorker(request: Request): boolean { return tokenMatches(request); }
export function ensureKaggleQueue(force=false): { queued:number; eligible:number } {
  if(!force&&Date.now()-lastAutomaticQueueScan<10*60_000) return {queued:0,eligible:0};
  lastAutomaticQueueScan=Date.now();
  return enqueueEligible({cap:subtitleConfig.queueCap});
}
export function startKaggleLeaseHeartbeat(jobId:number,workerId:string,intervalMs=30_000):{isLost():boolean;stop():void} {
  let leaseLost=false;
  const timer=setInterval(()=>{
    try { if(!heartbeatKaggleLease(jobId,workerId,leaseMs)) leaseLost=true; }
    catch { leaseLost=true; }
  },Math.max(1,intervalMs));
  timer.unref?.();
  return {isLost:()=>leaseLost,stop:()=>clearInterval(timer)};
}
function normalizeKaggleLanguage(value:string|null):'en'|'ja'|null {
  const language=(value??'').trim().toLowerCase().split(/[-_]/,1)[0]??'';
  if(['en','eng','english'].includes(language)) return 'en';
  if(['ja','jpn','japanese'].includes(language)) return 'ja';
  return null;
}
export async function storeNativeBulgarianTrack(jobId:number, downloaded:Awaited<ReturnType<typeof downloadTrack>>):Promise<number> {
  const job=getJob(jobId);
  if(!job) throw new Error(`subtitle job ${jobId} disappeared`);
  if(downloaded.track.language!=='bg') throw new Error('native Bulgarian track expected');
  const parsed=parseSubtitle(downloaded.text,downloaded.track.format);
  if(!parsed.cues.length) throw new Error('native Bulgarian subtitle has no cues');
  const saved=await saveBody(downloaded.text,parsed.format);
  const artifactId=storeValidatedArtifact({animeId:job.anime_id,seasonId:job.season_id,episodeId:job.episode_id,sourceLanguage:'bg',targetLanguage:'bg',sourceHash:parsed.sourceHash,model:`provider:${downloaded.track.provider}`,configHash:`native-bg:${downloaded.track.provider}`,translationVersion:'provider-v1',sourceFormat:parsed.format,translatedFormat:parsed.format,sourcePath:saved.path,translatedPath:saved.path,score:1});
  const checkpoint={...job.checkpoint,sourcePath:saved.path,sourceFormat:parsed.format,sourceLanguage:'bg',sourceHash:parsed.sourceHash,sourceProvider:downloaded.track.provider,artifactId,validated:true,nativeBulgarian:true,totalCues:parsed.cues.length};
  updateJob(job.id,'COMPLETED',{sourceLanguage:'bg',providerId:downloaded.track.provider,sourceHash:parsed.sourceHash,checkpoint,error:null,lockedAt:null});
  logJob(job.id,'info','native_bulgarian_track_stored',{provider:downloaded.track.provider,cues:parsed.cues.length,artifactId});
  return artifactId;
}
export async function claimKaggleJob(workerId: string): Promise<Record<string, unknown> | null> {
  const started=performance.now();
  if(subtitleConfig.translationMode!=='kaggle'){
    const diagnostics=kaggleQueueDiagnostics();
    console.info({event:'kaggle_claim_result',workerId,queueMode:subtitleConfig.translationMode,totalPending:diagnostics.pendingJobs,eligibleJobs:diagnostics.eligibleJobs,jobsByStatus:diagnostics.byStatus,jobsBySourceLanguage:diagnostics.bySourceLanguage,excludedByStatus:diagnostics.excludedByStatus,excludedBySourceLanguage:diagnostics.excludedBySourceLanguage,excludedByMissingMetadata:diagnostics.excludedByMissingMetadata,excludedByLease:diagnostics.excludedByLease,excludedByRetryLimit:diagnostics.excludedByRetryLimit,excludedByRetryDelay:diagnostics.excludedByRetryDelay,activeProcessing:diagnostics.activeProcessing,recoveredStaleJobs:0,selectedJobId:null,recoveryDurationMs:0,claimQueryDurationMs:0,totalDurationMs:Math.round(performance.now()-started),reason:'translation mode is not kaggle'});
    return null;
  }
  const recoveryStarted=performance.now();
  const recovered=recoverStaleJobs(leaseMs);
  const recoveryDurationMs=Math.round(performance.now()-recoveryStarted);
  const diagnostics=kaggleQueueDiagnostics();
  const queryStarted=performance.now();
  const [job] = claimKaggleJobs(workerId, 1, leaseMs);
  const claimQueryDurationMs=Math.round(performance.now()-queryStarted);
  const logClaim=(selectedJobId:number|null)=>console.info({
    event:'kaggle_claim_result',workerId,queueMode:subtitleConfig.translationMode,
    totalPending:diagnostics.pendingJobs,eligibleJobs:diagnostics.eligibleJobs,
    jobsByStatus:diagnostics.byStatus,jobsBySourceLanguage:diagnostics.bySourceLanguage,
    excludedByStatus:diagnostics.excludedByStatus,excludedBySourceLanguage:diagnostics.excludedBySourceLanguage,
    excludedByMissingMetadata:diagnostics.excludedByMissingMetadata,excludedByLease:diagnostics.excludedByLease,
    excludedByRetryLimit:diagnostics.excludedByRetryLimit,excludedByRetryDelay:diagnostics.excludedByRetryDelay,
    activeProcessing:diagnostics.activeProcessing,recoveredStaleJobs:recovered,selectedJobId,
    recoveryDurationMs,claimQueryDurationMs,totalDurationMs:Math.round(performance.now()-started),
  });
  if (!job) { logClaim(null); return null; }
  logClaim(job.id);
  const leaseHeartbeat=startKaggleLeaseHeartbeat(job.id,workerId);
  try {
  let checkpoint = job.checkpoint;
  checkpoint = { ...checkpoint, kaggleWorker: workerId };
  updateJob(job.id, 'DOWNLOADING', { checkpoint, lockedAt: Date.now() });
  const sourcePath = String(checkpoint.sourcePath);
  const sourceLanguage = normalizeKaggleLanguage(job.source_language);
  const sourceHash = String(job.source_hash);
  const sourceFormat = String(checkpoint.sourceFormat ?? 'srt') as SubtitleFormat;
  if(!sourceLanguage||!sourceHash||!sourcePath) throw new Error('claimed Kaggle job no longer has valid source metadata');
  if(leaseHeartbeat.isLost()) throw new Error('Kaggle job lease expired during source discovery');
  const source = await readBody(sourcePath);
  const parsed = parseSubtitle(source, sourceFormat);
  const sourceForWorker=toKaggleSrt(parsed);
  const transport=parseSubtitle(sourceForWorker,'srt');
  checkpoint = { ...checkpoint, kaggleWorker: workerId, totalCues: parsed.cues.length };
  updateJob(job.id, 'TRANSLATING', { sourceLanguage, sourceHash, checkpoint, lockedAt: Date.now() });
  if(leaseHeartbeat.isLost()) throw new Error('Kaggle job lease expired before returning the source');
  logJob(job.id, 'info', 'kaggle_job_claimed', { workerId, sourceLanguage, cues: parsed.cues.length });
  let partialText = typeof checkpoint.translatedPartialPath === 'string' ? await readBody(checkpoint.translatedPartialPath) : '';
  if(partialText) partialText=toKaggleSrt(parseWorkerSubtitle(partialText,sourceFormat));
  return { id: job.id, animeId: job.anime_id, seasonId: job.season_id, episodeId: job.episode_id, sourceLanguage, targetLanguage: 'bg', sourceHash: parsed.sourceHash, sourceFormat: 'srt', originalSourceFormat: parsed.format, sourceText: sourceForWorker, partialText, cues: transport.cues.map(cue => ({ id: cue.id, start: cue.start, end: cue.end, text: cue.originalText })), model: modelName, leaseMs };
  } finally { leaseHeartbeat.stop(); }
}
export function heartbeatKaggleJob(input: { jobId: number; workerId: string }): boolean {
  const job = getJob(input.jobId);
  if (!job || !['DOWNLOADING','NORMALIZING','TRANSLATING','VALIDATING'].includes(job.status) || job.checkpoint.kaggleWorker !== input.workerId) return false;
  return heartbeatKaggleLease(job.id,input.workerId,leaseMs);
}
export async function checkpointKaggleJob(input:{jobId:number;workerId:string;translatedText:string}):Promise<{completedCues:number;hash:string}> {
  const job=getJob(input.jobId);
  if(!job||job.status!=='TRANSLATING'||job.checkpoint.kaggleWorker!==input.workerId) throw new Error('job lease is not owned by this worker');
  if(typeof input.translatedText!=='string'||Buffer.byteLength(input.translatedText)>8*1024*1024) throw new Error('subtitle checkpoint exceeds size limit');
  const sourceText=await readBody(String(job.checkpoint.sourcePath??''));
  const format=String(job.checkpoint.sourceFormat??'srt') as SubtitleFormat;
  const source=parseSubtitle(sourceText,format); const partial=parseWorkerSubtitle(input.translatedText,format);
  if(!partial.cues.length||partial.cues.length>source.cues.length) throw new Error('invalid subtitle checkpoint cue count');
  for(let i=0;i<partial.cues.length;i++) if(source.cues[i]!.start!==partial.cues[i]!.start||source.cues[i]!.end!==partial.cues[i]!.end) throw new Error(`checkpoint timestamp mismatch at cue ${i+1}`);
  const saved=await saveBody(toKaggleSrt(partial),'srt');
  updateJob(job.id,'TRANSLATING',{checkpoint:{...job.checkpoint,translatedPartialPath:saved.path,translatedPartialHash:saved.hash,completedCues:partial.cues.length,totalCues:source.cues.length},lockedAt:Date.now()});
  if(!heartbeatKaggleLease(job.id,input.workerId,leaseMs)) throw new Error('job lease expired while saving checkpoint');
  logJob(job.id,'info','kaggle_batch_checkpointed',{workerId:input.workerId,completedCues:partial.cues.length,totalCues:source.cues.length});
  return {completedCues:partial.cues.length,hash:saved.hash};
}
export async function completeKaggleJob(input: { jobId: number; workerId: string; translatedText: string; model?: string; translationVersion?: string }): Promise<{ artifactId: number; hash: string }> {
  const job = getJob(input.jobId);
  if (!job || job.checkpoint.kaggleWorker !== input.workerId) throw new Error('job lease is not owned by this worker');
  if(job.status==='COMPLETED' && job.checkpoint.validated===true && Number.isSafeInteger(job.checkpoint.artifactId) && typeof job.checkpoint.translatedHash==='string') return {artifactId:Number(job.checkpoint.artifactId),hash:String(job.checkpoint.translatedHash)};
  if(job.status!=='TRANSLATING') throw new Error('job is not ready for completion');
  if (typeof input.translatedText !== 'string' || Buffer.byteLength(input.translatedText) > 8 * 1024 * 1024) throw new Error('translated subtitle exceeds size limit');
  const sourcePath = String(job.checkpoint.sourcePath ?? '');
  const sourceText = await readBody(sourcePath);
  const format = String(job.checkpoint.sourceFormat ?? 'srt') as SubtitleFormat;
  const source = parseSubtitle(sourceText, format);
  const translated = parseWorkerSubtitle(input.translatedText, format);
  const result = alignWorkerCues(source,translated);
  const qa = validateTranslation(source, { ...result, cues: result.cues.map(cue => ({ ...cue, originalText: cue.translatedText })) }, []);
  if (!qa.valid || qa.score < 0.65) throw new Error(`translation validation failed: ${qa.issues.join(', ')}`);
  updateJob(job.id, 'VALIDATING', { lockedAt: Date.now() });
  const output = serializeSubtitle(result, true);
  const stored = await saveBody(output, format);
  const idempotency = createHash('sha256').update(`${source.sourceHash}:bg:${input.model || modelName}:${input.translationVersion || 'kaggle-v1'}`).digest('hex');
  const artifactId = storeValidatedArtifact({ animeId: job.anime_id, seasonId: job.season_id, episodeId: job.episode_id, sourceLanguage: job.source_language ?? 'en', targetLanguage: 'bg', sourceHash: source.sourceHash, model: input.model || modelName, configHash: idempotency, translationVersion: input.translationVersion || 'kaggle-v1', sourceFormat: format, translatedFormat: format, sourcePath, translatedPath: stored.path, score: qa.score });
  updateJob(job.id, 'COMPLETED', { error: null, lockedAt: null, workerId: null, leaseExpiresAt: null, checkpoint: { ...job.checkpoint, artifactId, translatedHash: stored.hash, model: input.model || modelName, validated: true } });
  logJob(job.id, 'info', 'kaggle_translation_completed', { workerId: input.workerId, model: input.model || modelName, cues: source.cues.length, score: qa.score });
  return { artifactId, hash: stored.hash };
}
export function failKaggleJob(input: { jobId: number; workerId: string; reason: string }): void {
  const job = getJob(input.jobId);
  if (!job || job.checkpoint.kaggleWorker !== input.workerId || !['TRANSLATING','VALIDATING'].includes(job.status)) throw new Error('job lease is not owned by this worker');
  const reason = input.reason.slice(0, 1000);
  const terminal = job.attempts >= 5;
  updateJob(job.id, 'FAILED', { error: reason, lockedAt: null, workerId: null, leaseExpiresAt: null, availableAt: terminal ? Number.MAX_SAFE_INTEGER : Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.max(0, job.attempts - 1)) });
  logJob(job.id, 'error', terminal ? 'kaggle_job_dead_lettered' : 'kaggle_job_failed', { workerId: input.workerId, reason });
}
export function kaggleQueueStatus(): Record<string, unknown> { return { ...jobStats(), worker: { enabled: Boolean(process.env.ANINEKO_WORKER_TOKEN), model: modelName, translationMode: subtitleConfig.translationMode } }; }
