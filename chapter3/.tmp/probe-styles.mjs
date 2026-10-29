import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t=new StdioClientTransport({command:"wordcraft-cli",args:["mcp"],cwd:"/tmp",stderr:"pipe"}); t.stderr?.on("data",()=>{});
const c=new Client({name:"p",version:"1"},{capabilities:{}}); await c.connect(t);
const u=r=>{const b=r.content.find(x=>x.type==="text");try{return JSON.parse(b.text)}catch{return b.text}};
const ex=async(cmd,params={})=>u(await c.callTool({name:"execute",arguments:{command:cmd,params}}));
await c.callTool({name:"new_document",arguments:{width:612,height:792}});
console.log(JSON.stringify(await ex("styles.list",{}),null,1).slice(0,4000));
await c.close();
