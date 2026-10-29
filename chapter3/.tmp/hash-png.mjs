import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
for (const p of process.argv.slice(2)) console.log(createHash('sha256').update(readFileSync(p)).digest('hex'), p);
