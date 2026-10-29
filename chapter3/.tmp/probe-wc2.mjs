import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync } from "node:fs";
const root = process.argv[2]; mkdirSync(root,{recursive:true});
const t = new StdioClientTransport({command:"wordcraft-cli",args:["mcp"],cwd:root,stderr:"pipe"}); t.stderr?.on("data",()=>{});
const c = new Client({name:"probe",version:"1"},{capabilities:{}}); await c.connect(t);
const unwrap=(r)=>{const b=r.content?.find(x=>x.type==="text"); try{return JSON.parse(b.text)}catch{return b.text}};
const call=async(n,a={})=>{const r=await c.callTool({name:n,arguments:a}); console.log('CALL',n,JSON.stringify(a),'->',JSON.stringify(r).slice(0,800)); return unwrap(r)};
const ex=async(cmd,params={})=>{const r=await call('execute',{command:cmd,params}); return r};
await call('new_document',{width:612,height:792});
await ex('text.insert',{text:'Original. '});
await ex('review.trackChanges',{});
await ex('text.insert',{text:'Editor insertion.'});
console.log('changes1',JSON.stringify(await ex('review.changes',{})));
for (const p of [{id:0},{change:0},{index:0},{start:0,end:17,path:[1]},{acceptAll:true}]) {
  console.log('TRY accept',JSON.stringify(p)); await ex('review.accept',p);
  console.log('changes after',JSON.stringify(await ex('review.changes',{})));
}
await call('save_document',{path:'probe2.docx'});
await c.close();
