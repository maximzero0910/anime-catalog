import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root=await mkdtemp(join(tmpdir(),'anineko-kaggle-worker-'));
process.env.CATALOG_DB_PATH=join(root,'catalog.db');
process.env.SUBTITLE_DATA_DIR=join(root,'subtitles');
process.env.ANINEKO_WORKER_TOKEN='test-token-that-is-at-least-thirty-two-characters-long';
process.env.SUBTITLE_TRANSLATION_MODE='kaggle';
const seed=new Database(process.env.CATALOG_DB_PATH);
seed.exec(`CREATE TABLE titles(id INTEGER PRIMARY KEY,slug TEXT,romaji TEXT,english TEXT,native TEXT,title_bg TEXT,year INTEGER,format TEXT,episodes INTEGER,cover TEXT,banner TEXT,status TEXT,score REAL,season TEXT,genres TEXT,tags TEXT,synopsis_bg TEXT); CREATE TABLE episodes(title_id INTEGER,number INTEGER,duration INTEGER,filler INTEGER,PRIMARY KEY(title_id,number)); CREATE TABLE subs(title_id INTEGER,number INTEGER,path TEXT,source TEXT,status TEXT,translator TEXT,PRIMARY KEY(title_id,number)); INSERT INTO titles(id,slug,romaji,english,native,genres,tags) VALUES(1,'test','Test Anime','Test Anime','テスト','[]','[]'),(2,'other','Other Anime','Other Anime','その他','[]','[]'),(9,'format-test','Format Test','Format Test','形式テスト','[]','[]'),(178083,'tokyo-revengers-santen-sensou-hen','Tokyo Revengers: Santen Sensou-hen','Tokyo Revengers: War of the Three Titans Arc','東京リベンジャーズ 三天戦争編','[]','[]'); INSERT INTO episodes VALUES(1,1,1200,0),(2,1,1200,0),(9,1,1200,0),(9,2,1200,0),(178083,1,1200,0),(178083,2,1200,0);`);
seed.close();
const storage=await import('../storage');
const queue=await import('../queue');
const worker=await import('../kaggle-worker');
const acquisition=await import('../acquire');
const claimRoute=await import('../../../pages/api/worker/claim');
const heartbeatRoute=await import('../../../pages/api/worker/heartbeat');
const completeRoute=await import('../../../pages/api/worker/complete');
const workerRoute=await import('../kaggle-route');

test('Kaggle worker auth fails closed and compares configured tokens safely',()=>{
  assert.equal(worker.authorizeKaggleWorker(new Request('https://local/api/worker/claim')),false);
  assert.equal(worker.authorizeKaggleWorker(new Request('https://local/api/worker/claim',{headers:{authorization:`Bearer ${process.env.ANINEKO_WORKER_TOKEN}`}})),true);
  assert.equal(worker.authorizeKaggleWorker(new Request('https://local/api/worker/claim',{headers:{authorization:'Bearer wrong'}})),false);
});

test('Kaggle lease claim, heartbeat, validation and completion preserve times and store an artifact idempotently',async()=>{
  const source='1\n00:00:01,000 --> 00:00:03,000\n<i>Hello there!</i>\n\n2\n00:00:04,000 --> 00:00:06,000\nHow are you?\n';
  const saved=await storage.saveBody(source,'srt');
  const job=storage.enqueueOnDemandJob(1,1);
  storage.updateJob(job.id,'QUEUED',{sourceLanguage:'en',sourceHash:saved.hash,providerId:'test-source',checkpoint:{sourcePath:saved.path,sourceFormat:'srt',sourceLanguage:'en',sourceHash:saved.hash}});
  const claimed=await worker.claimKaggleJob('gpu-a');
  assert.ok(claimed); assert.equal(claimed.workerId,undefined);
  assert.equal(worker.heartbeatKaggleJob({jobId:job.id,workerId:'gpu-b'}),false);
  assert.equal(worker.heartbeatKaggleJob({jobId:job.id,workerId:'gpu-a'}),true);
  const translated='1\n00:00:01,000 --> 00:00:03,000\nЗдравей!\n\n2\n00:00:04,000 --> 00:00:06,000\nКак си?\n';
  const result=await worker.completeKaggleJob({jobId:job.id,workerId:'gpu-a',translatedText:translated,model:'facebook/nllb-200-distilled-600M'});
  assert.deepEqual(await worker.completeKaggleJob({jobId:job.id,workerId:'gpu-a',translatedText:translated,model:'facebook/nllb-200-distilled-600M'}),result);
  const current=storage.getJob(job.id)!;
  assert.equal(current.status,'COMPLETED');
  assert.equal(current.checkpoint.artifactId,result.artifactId);
  assert.equal(storage.listArtifacts(1,'1').filter(x=>x.model==='facebook/nllb-200-distilled-600M').length,1);
  const artifact=storage.listArtifacts(1,'1').find(x=>x.model==='facebook/nllb-200-distilled-600M')!;
  assert.match(await storage.readBody(String(artifact.translated_path)),/<i>Здравей!<\/i>/);
  await assert.rejects(worker.completeKaggleJob({jobId:job.id,workerId:'gpu-b',translatedText:translated}));
});

test('Kaggle completion rejects cue parity and timestamp changes without writing an artifact',async()=>{
  const source='1\n00:00:01,000 --> 00:00:03,000\nHello there!\n';
  const saved=await storage.saveBody(source,'srt');
  const job=storage.enqueueOnDemandJob(1,2);
  storage.updateJob(job.id,'QUEUED',{sourceLanguage:'en',sourceHash:saved.hash,providerId:'test-source',checkpoint:{sourcePath:saved.path,sourceFormat:'srt',sourceLanguage:'en',sourceHash:saved.hash}});
  await worker.claimKaggleJob('gpu-a');
  await assert.rejects(worker.completeKaggleJob({jobId:job.id,workerId:'gpu-a',translatedText:'1\n00:00:02,000 --> 00:00:04,000\nЗдравей\n'}),/timestamp mismatch/);
  assert.equal(storage.listArtifacts(1,'2').length,0);
});

test('ASS source is sent as SRT and reconstructed with original styling after validated completion',async()=>{
  const source='[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,20\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}<i>Hello there!</i>\nDialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\an8}\n';
  const saved=await storage.saveBody(source,'ass');
  const job=storage.enqueueOnDemandJob(9,1);
  storage.updateJob(job.id,'QUEUED',{sourceLanguage:'en',sourceHash:saved.hash,providerId:'test-source',checkpoint:{sourcePath:saved.path,sourceFormat:'ass',sourceLanguage:'en',sourceHash:saved.hash}});
  const claimed=await worker.claimKaggleJob('ass-worker');
  assert.ok(claimed);
  assert.equal(claimed.sourceFormat,'srt');
  assert.equal(claimed.originalSourceFormat,'ass');
  assert.match(String(claimed.sourceText),/ANINEKO_NON_SPEECH_2/);
  const translated='1\n00:00:01,000 --> 00:00:03,000\nЗдравей!\n\n2\n00:00:04,000 --> 00:00:06,000\nANINEKO_NON_SPEECH_2\n';
  await worker.checkpointKaggleJob({jobId:job.id,workerId:'ass-worker',translatedText:translated});
  const result=await worker.completeKaggleJob({jobId:job.id,workerId:'ass-worker',translatedText:translated});
  const artifact=storage.listArtifacts(9,'1').find(row=>row.id===result.artifactId)!;
  assert.equal(artifact.translated_format,'ass');
  const output=await storage.readBody(String(artifact.translated_path));
  assert.match(output,/\[V4\+ Styles\]/);
  assert.match(output,/Dialogue: 0,0:00:01\.00,0:00:03\.00,Default,,0,0,0,,\{\\an8\}.*Здравей!/);
  assert.match(output,/Dialogue: 0,0:00:04\.00,0:00:06\.00,Default,,0,0,0,,\{\\an8\}/);
});

test('VTT source is delivered as SRT and stored with its WEBVTT header',async()=>{
  const source='WEBVTT\n\ncue-one\n00:00:01.000 --> 00:00:03.000\n<i>Hello there!</i>\n\ncue-two\n00:00:04.000 --> 00:00:06.000\nHow are you?\n';
  const saved=await storage.saveBody(source,'vtt');
  const job=storage.enqueueOnDemandJob(9,2);
  storage.updateJob(job.id,'QUEUED',{sourceLanguage:'en',sourceHash:saved.hash,providerId:'test-source',checkpoint:{sourcePath:saved.path,sourceFormat:'vtt',sourceLanguage:'en',sourceHash:saved.hash}});
  const claimed=await worker.claimKaggleJob('vtt-worker');
  assert.ok(claimed);
  assert.equal(claimed.sourceFormat,'srt');
  assert.equal(claimed.originalSourceFormat,'vtt');
  assert.doesNotMatch(String(claimed.sourceText),/^WEBVTT/);
  const translated='1\n00:00:01,000 --> 00:00:03,000\nЗдравей!\n\n2\n00:00:04,000 --> 00:00:06,000\nКак си?\n';
  const result=await worker.completeKaggleJob({jobId:job.id,workerId:'vtt-worker',translatedText:translated});
  const artifact=storage.listArtifacts(9,'2').find(row=>row.id===result.artifactId)!;
  assert.equal(artifact.translated_format,'vtt');
  assert.match(await storage.readBody(String(artifact.translated_path)),/^WEBVTT\n/);
});

test('Kaggle batch checkpoints survive lease expiry and are returned to a replacement worker',async()=>{
  const source='1\n00:00:01,000 --> 00:00:03,000\nHello!\n\n2\n00:00:04,000 --> 00:00:06,000\nHow are you?\n';
  const saved=await storage.saveBody(source,'srt');
  const job=storage.enqueueOnDemandJob(1,13);
  storage.updateJob(job.id,'QUEUED',{sourceLanguage:'en',sourceHash:saved.hash,providerId:'test-source',checkpoint:{sourcePath:saved.path,sourceFormat:'srt',sourceLanguage:'en',sourceHash:saved.hash}});
  await worker.claimKaggleJob('gpu-a');
  const partial='1\n00:00:01,000 --> 00:00:03,000\nЗдравей!\n';
  assert.equal((await worker.checkpointKaggleJob({jobId:job.id,workerId:'gpu-a',translatedText:partial})).completedCues,1);
  const db=new Database(process.env.CATALOG_DB_PATH!); db.prepare('UPDATE subtitle_jobs SET lease_expires_at=1 WHERE id=?').run(job.id); db.close();
  assert.equal(storage.recoverStaleJobs(120_000),1);
  const resumed=await worker.claimKaggleJob('gpu-b');
  assert.ok(resumed); assert.equal(resumed.partialText,partial);
  await worker.completeKaggleJob({jobId:job.id,workerId:'gpu-b',translatedText:'1\n00:00:01,000 --> 00:00:03,000\nЗдравей!\n\n2\n00:00:04,000 --> 00:00:06,000\nКак си?\n'});
});

test('Kaggle mode leaves prepared translation jobs for GPU workers while the Pi can still claim discovery work',async()=>{
  const ready=storage.enqueueOnDemandJob(1,3);
  storage.updateJob(ready.id,'QUEUED',{sourceLanguage:'en',sourceHash:'a'.repeat(64),checkpoint:{sourcePath:'source.srt',sourceFormat:'srt'}});
  const discovery=storage.enqueueOnDemandJob(1,4);
  assert.equal(storage.claimJobs(1,'kaggle').length,0);
  assert.ok(storage.claimUndiscoveredJobs(10).some(job=>job.id===discovery.id));
  assert.ok(storage.claimJobs(10,'online').some(job=>job.id===ready.id));
});

test('queue refill orders explicitly overridden Tokyo Revengers S4 ahead of ordinary catalog titles',()=>{
  storage.setSubtitlePriorityOverride(178083,99999,'Tokyo Revengers S4 operator priority');
  const db=new Database(process.env.CATALOG_DB_PATH!,{readonly:true});
  const before=Number((db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM subtitle_jobs').get() as {id:number}).id);
  db.close();
  const seeded=queue.enqueueEligible({cap:1});
  assert.equal(seeded.queued,1);
  const check=new Database(process.env.CATALOG_DB_PATH!,{readonly:true});
  try { assert.equal((check.prepare('SELECT anime_id FROM subtitle_jobs WHERE id>? ORDER BY id LIMIT 1').get(before) as {anime_id:number}).anime_id,178083); }
  finally { check.close(); }
  assert.ok(storage.subtitleQueueDepth()>=1);
  assert.equal(queue.shouldRefillSubtitleQueue(479,25),false);
  assert.equal(queue.shouldRefillSubtitleQueue(24,25),true);
});

test('Pi discovery claims manually prioritized Tokyo Revengers work before ordinary bulk jobs',()=>{
  storage.setSubtitlePriorityOverride(178083,99999,'Tokyo Revengers S4 operator priority');
  const ordinary=storage.enqueueJob(1,99);
  const claimed=storage.claimUndiscoveredJobs(1);
  assert.notEqual(claimed[0]?.id,ordinary.id);
  assert.equal(claimed[0]?.anime_id,178083);
  storage.updateJob(claimed[0]!.id,'SKIPPED',{error:'test complete'});
  storage.updateJob(ordinary.id,'SKIPPED',{error:'test complete'});
});

test('Pi discovery retries due provider failures but leaves retry-exhausted jobs terminal',()=>{
  const retryable=storage.enqueueJob(1,901);
  storage.updateJob(retryable.id,'FAILED',{attempts:1,availableAt:Date.now()-1,error:'provider timeout'});
  const exhausted=storage.enqueueJob(1,902);
  storage.updateJob(exhausted.id,'FAILED',{attempts:5,availableAt:0,error:'provider timeout'});
  const claimed=storage.claimUndiscoveredJobs(10);
  assert.ok(claimed.some(job=>job.id===retryable.id));
  assert.equal(storage.getJob(retryable.id)?.attempts,2);
  assert.equal(claimed.some(job=>job.id===exhausted.id),false);
  assert.equal(storage.getJob(exhausted.id)?.status,'FAILED');
  for(const job of claimed) storage.updateJob(job.id,'SKIPPED',{error:'test complete'});
  storage.updateJob(exhausted.id,'SKIPPED',{error:'test complete'});
});

async function prepareKaggleJob(animeId:number,episode:number,language:string):Promise<number>{
  const content='1\n00:00:01,000 --> 00:00:03,000\nHello!\n';
  const saved=await storage.saveBody(content,'srt');
  const job=storage.enqueueOnDemandJob(animeId,episode);
  storage.updateJob(job.id,'QUEUED',{sourceLanguage:language,sourceHash:saved.hash,checkpoint:{sourcePath:saved.path,sourceFormat:'srt',sourceLanguage:language,sourceHash:saved.hash}});
  return job.id;
}

test('Kaggle claim accepts prepared English and Japanese language variants only',async()=>{
  const enId=await prepareKaggleJob(1,31,'eng_Latn');
  const jaId=await prepareKaggleJob(1,32,'jpn_Jpan');
  const unsupportedId=await prepareKaggleJob(1,33,'ru');
  const claimed=storage.claimKaggleJobs('gpu-lang-test',2);
  assert.deepEqual(new Set(claimed.map(job=>job.id)),new Set([enId,jaId]));
  assert.equal(storage.getJob(unsupportedId)?.status,'QUEUED');
  const diagnostic=storage.kaggleQueueDiagnostics();
  assert.ok(diagnostic.bySourceLanguage.unsupported>=1);
  assert.ok(diagnostic.excludedBySourceLanguage>=1);
});

test('a source prepared by provider fallback becomes claimable by Kaggle exactly once',async()=>{
  const pending=storage.enqueueOnDemandJob(1,40);
  assert.equal(storage.claimKaggleJobs('fallback-kaggle',1).length,0);
  const source='1\n00:00:01,000 --> 00:00:03,000\nHello from fallback\n';
  const saved=await storage.saveBody(source,'srt');
  storage.updateJob(pending.id,'QUEUED',{sourceLanguage:'ja',sourceHash:saved.hash,providerId:'subssabbz',checkpoint:{sourcePath:saved.path,sourceFormat:'srt',sourceLanguage:'ja',sourceHash:saved.hash}});
  const claimed=storage.claimKaggleJobs('fallback-kaggle',1);
  assert.deepEqual(claimed.map(job=>job.id),[pending.id]);
  assert.equal(storage.claimKaggleJobs('another-gpu',1).length,0);
});

test('an unusable preferred subtitle file falls through to a usable copy from another provider',async()=>{
  const tracks=[
    {language:'en',url:'https://primary.test/broken.srt',format:'srt' as const,provider:'primary',headers:{},fetch:async()=>({body:'this is not a subtitle file',format:'srt' as const,language:'en'})},
    {language:'en',url:'https://secondary.test/good.srt',format:'srt' as const,provider:'secondary',headers:{},fetch:async()=>({body:'1\n00:00:01,000 --> 00:00:03,000\nHello from secondary\n',format:'srt' as const,language:'en'})},
  ];
  const result=await acquisition.firstUsableTrack(tracks,['en','ja']);
  assert.equal(result.track?.provider,'secondary');
  assert.equal(result.parsed?.cues.length,1);
  assert.deepEqual(result.failures.map(item=>item.provider),['primary']);
});

test('Japanese source is attempted after all English provider copies are unusable',async()=>{
  const tracks=[
    {language:'en',url:'https://english.test/broken.srt',format:'srt' as const,provider:'english',headers:{},fetch:async()=>({body:'invalid',format:'srt' as const,language:'en'})},
    {language:'ja',url:'https://japanese.test/good.srt',format:'srt' as const,provider:'japanese',headers:{},fetch:async()=>({body:'1\n00:00:01,000 --> 00:00:03,000\nこんにちは\n',format:'srt' as const,language:'ja'})},
  ];
  const result=await acquisition.firstUsableTrack(tracks,['en','ja']);
  assert.equal(result.track?.provider,'japanese');
  assert.equal(result.track?.language,'ja');
  assert.equal(result.failures.length,1);
});

test('Kaggle claim excludes missing source metadata, live leases and exhausted jobs but permits a retryable failure',async()=>{
  const missing=storage.enqueueOnDemandJob(1,34);
  storage.updateJob(missing.id,'QUEUED',{sourceLanguage:'en'});
  const leasedId=await prepareKaggleJob(1,35,'en');
  storage.updateJob(leasedId,'QUEUED',{leaseExpiresAt:Date.now()+60_000,workerId:'still-leased'});
  const retryId=await prepareKaggleJob(1,36,'English');
  storage.updateJob(retryId,'FAILED',{attempts:1,availableAt:0,workerId:null,leaseExpiresAt:null});
  const exhaustedId=await prepareKaggleJob(1,37,'en');
  storage.updateJob(exhaustedId,'FAILED',{attempts:5,availableAt:Number.MAX_SAFE_INTEGER});
  const claimed=storage.claimKaggleJobs('gpu-retry-test',2);
  assert.deepEqual(claimed.map(job=>job.id),[retryId]);
  assert.equal(storage.getJob(missing.id)?.status,'QUEUED');
  assert.equal(storage.getJob(leasedId)?.status,'QUEUED');
  assert.equal(storage.getJob(exhaustedId)?.status,'FAILED');
  const diagnostic=storage.kaggleQueueDiagnostics();
  assert.ok(diagnostic.excludedByMissingMetadata>=1);
  assert.ok(diagnostic.excludedByLease>=1);
  assert.ok(diagnostic.excludedByRetryLimit>=1);
});

test('concurrent Kaggle claimers cannot claim one prepared job twice',async()=>{
  const id=await prepareKaggleJob(1,38,'en');
  const results=await Promise.all([storage.claimKaggleJobs('gpu-race-a',1),storage.claimKaggleJobs('gpu-race-b',1)]);
  const claimed=results.flat().filter(job=>job.id===id);
  assert.equal(claimed.length,1);
  assert.ok(['gpu-race-a','gpu-race-b'].includes(storage.getJob(id)?.worker_id??''));
});

test('Kaggle claim leaves unprepared jobs for Pi discovery and reports an empty translation claim',async()=>{
  const pending=storage.enqueueOnDemandJob(2,39);
  const before=storage.getJob(pending.id)!;
  assert.equal(await worker.claimKaggleJob('kaggle-worker'),null);
  const after=storage.getJob(pending.id)!;
  assert.equal(after.status,before.status);
  assert.equal(after.attempts,before.attempts);
  assert.equal(after.worker_id,null);
  assert.ok(storage.kaggleQueueDiagnostics().excludedByMissingMetadata>=1);
});

test('an idle Kaggle claim cycle can seed eligible catalog episodes without prebuilt subtitle_jobs rows',()=>{
  const seedCatalog=new Database(process.env.CATALOG_DB_PATH!);
  seedCatalog.exec("INSERT OR IGNORE INTO titles(id,slug,romaji,english,native,genres,tags) VALUES(3,'queued','Queued Test','Queued Test','待機','[]','[]'); INSERT OR IGNORE INTO episodes VALUES(3,1,1200,0);");
  seedCatalog.close();
  const before=new Database(process.env.CATALOG_DB_PATH!,{readonly:true});
  assert.equal((before.prepare('SELECT COUNT(*) AS n FROM subtitle_jobs WHERE anime_id=3').get() as {n:number}).n,0);
  before.close();
  const result=worker.ensureKaggleQueue(true);
  assert.ok(result.eligible>=1);
  const after=new Database(process.env.CATALOG_DB_PATH!,{readonly:true});
  assert.equal((after.prepare('SELECT COUNT(*) AS n FROM subtitle_jobs WHERE anime_id=3').get() as {n:number}).n,1);
  after.close();
});

test('a discovered native Bulgarian subtitle is stored as a provider artifact without GPU translation',async()=>{
  const job=storage.enqueueOnDemandJob(1,21);
  const artifactId=await worker.storeNativeBulgarianTrack(job.id,{track:{language:'bg',url:'https://subtitles.example/episode.srt',format:'srt',provider:'subsunacs',headers:{},attribution:'Subsunacs'},text:'1\n00:00:01,000 --> 00:00:03,000\nЗдравей, свят!\n'});
  const completed=storage.getJob(job.id)!;
  assert.equal(completed.status,'COMPLETED');
  assert.equal(completed.source_language,'bg');
  assert.equal(completed.provider_id,'subsunacs');
  assert.equal(completed.checkpoint.nativeBulgarian,true);
  const artifact=storage.listArtifacts(1,'21').find(row=>row.id===artifactId)!;
  assert.equal(artifact.source_language,'bg');
  assert.equal(artifact.target_language,'bg');
  assert.equal(artifact.model,'provider:subsunacs');
  assert.match(await storage.readBody(String(artifact.translated_path)),/Здравей, свят!/);
});

test('Kaggle discovery lease heartbeats extend active work and stop after ownership is lost',async()=>{
  const jobId=await prepareKaggleJob(1,22,'en');
  const job=storage.getJob(jobId)!;
  assert.equal(storage.claimKaggleJobs('heartbeat-test',1,20).length,1);
  const heartbeat=worker.startKaggleLeaseHeartbeat(job.id,'heartbeat-test',5);
  try {
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.ok((storage.getJob(job.id)?.lease_expires_at??0)>Date.now());
    assert.equal(heartbeat.isLost(),false);
    storage.updateJob(job.id,'COMPLETED',{lockedAt:null});
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal(heartbeat.isLost(),true);
  } finally { heartbeat.stop(); }
});

test('AniList sync matches the local catalog, assigns rank tiers, and applies a manual override',()=>{
  const ordinary=storage.enqueueOnDemandJob(1,10);
  const override=storage.enqueueOnDemandJob(2,11);
  const rows=[
    {id:900001,title:'Test Anime',romaji:'Test Anime',english:'Test Anime',native:'テスト',synonyms:[],popularity:12345,rank:5,format:'TV',seasonYear:2024},
    {id:900002,title:'Other Anime',romaji:'Other Anime',english:'Other Anime',native:'その他',synonyms:[],popularity:9000,rank:80,format:'TV',seasonYear:2024},
  ];
  storage.setSubtitlePriorityOverride(900002,77,'operator priority');
  assert.equal(storage.syncAniListPopularity(rows),2);
  const db=new Database(process.env.CATALOG_DB_PATH!);
  const popularity=db.prepare('SELECT anilist_id,anime_id,rank,match_score FROM anime_popularity ORDER BY anilist_id').all() as Array<{anilist_id:number;anime_id:number;rank:number;match_score:number}>;
  assert.deepEqual(popularity.map(row=>[row.anime_id,row.rank,row.match_score]),[[1,5,100],[2,80,100]]);
  const priorities=db.prepare('SELECT episode_id,priority FROM subtitle_jobs WHERE id IN (?,?) ORDER BY episode_id').all(ordinary.id,override.id) as Array<{episode_id:string;priority:number}>;
  assert.ok(priorities[0]!.priority >= 5000 && priorities[0]!.priority < 100000);
  assert.equal(priorities[1]!.priority,100077);
  const newJob=storage.enqueueJobOnce(2,12).job;
  assert.equal(newJob.priority,100077);
  db.close();
});

test('worker HTTP routes reject unauthenticated calls and authenticated claims without a worker id',async()=>{
  const unauthorized=await claimRoute.POST({request:new Request('https://local/api/worker/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workerId:'test-worker'})})});
  assert.equal(unauthorized.status,401);
  const headers={'content-type':'application/json',authorization:`Bearer ${process.env.ANINEKO_WORKER_TOKEN}`};
  const missingWorker=await claimRoute.POST({request:new Request('https://local/api/worker/claim',{method:'POST',headers,body:'{}'})});
  assert.equal(missingWorker.status,400);
  const heartbeat=await heartbeatRoute.POST({request:new Request('https://local/api/worker/heartbeat',{method:'POST',headers,body:JSON.stringify({jobId:9999,workerId:'test-worker'})})});
  assert.equal(heartbeat.status,200);
  assert.deepEqual(await heartbeat.json(),{ok:false});
  const malformed=await completeRoute.POST({request:new Request('https://local/api/worker/complete',{method:'POST',headers,body:'{'})});
  assert.equal(malformed.status,400);
  const body=JSON.stringify({workerId:'framed-worker'});
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(body));}});
  const framed=new Request('https://local/api/worker/claim',{method:'POST',headers:{...headers,'content-length':String(Buffer.byteLength(body))},body:stream,duplex:'half'} as RequestInit & {duplex:'half'});
  assert.deepEqual(await workerRoute.workerJson(framed,4096),{workerId:'framed-worker'});
});

test('authenticated worker claim endpoint returns a prepared job',async()=>{
  const source='1\n00:00:01,000 --> 00:00:03,000\nA prepared source cue.\n';
  const saved=await storage.saveBody(source,'srt');
  const job=storage.enqueueOnDemandJob(2,1);
  storage.updateJob(job.id,'QUEUED',{sourceLanguage:'en',sourceHash:saved.hash,providerId:'test-source',checkpoint:{sourcePath:saved.path,sourceFormat:'srt',sourceLanguage:'en',sourceHash:saved.hash}});
  const headers={'content-type':'application/json',authorization:`Bearer ${process.env.ANINEKO_WORKER_TOKEN}`};
  const response=await claimRoute.POST({request:new Request('https://local/api/worker/claim',{method:'POST',headers,body:JSON.stringify({workerId:'route-worker'})})});
  assert.equal(response.status,200);
  const body=await response.json() as {job?:{id:number;sourceLanguage:string;sourceText:string}};
  assert.equal(body.job?.id,job.id);
  assert.equal(body.job?.sourceLanguage,'en');
  assert.match(body.job?.sourceText??'',/A prepared source cue/);
  assert.equal(storage.getJob(job.id)?.status,'TRANSLATING');
  assert.equal(storage.getJob(job.id)?.checkpoint.kaggleWorker,'route-worker');
});

test.after(async()=>{storage.closeSubtitleStorage();await rm(root,{recursive:true,force:true});});
