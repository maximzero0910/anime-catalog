import { enqueueEligible } from '../src/lib/subtitles/queue';
import { getTitles, getEpisodes } from '../src/lib/db';
import { existingBulgarian } from '../src/lib/subtitles/storage';

const capArg=process.argv.indexOf('--cap'); const cap=capArg>=0?Number(process.argv[capArg+1]):100;
if(!Number.isSafeInteger(cap)||cap<1||cap>10000) throw new Error('--cap must be between 1 and 10000');
const result=enqueueEligible({cap});
// Keep per-title episode enqueueing idempotent; job uniqueness is owned by subtitle_jobs.
const eligible=getTitles().reduce((n,title)=>n+getEpisodes(title.id).filter(ep=>!existingBulgarian(title.id,ep.number)).length,0);
console.info(JSON.stringify({event:'kaggle_translation_queue_seeded',...result,eligible}));
