// make-bundle-fixtures.mjs — materialises what the bundle pipeline assumes:
//   * XMP sidecars that give the LightCraft imports a rating, a keyword set
//     and a colour label (the headless catalog is per-process and has no
//     other way to carry metadata across launches);
//   * a DesignCraft template with a graphic frame;
//   * a PdfCraft boilerplate with Product / CTA / Price form fields.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];

const xmp = (rating, keywords, label) => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmp:Rating="${rating}" xmp:Label="${label}">
   <dc:subject><rdf:Bag>${keywords.map(k => `<rdf:li>${k}</rdf:li>`).join("")}</rdf:Bag></dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;

await writeFile(join(root, "imports/velvet_ochre.jpg.xmp"),
  xmp(4, ["velvet-chair", "ochre", "studio-shot"], "Green"));
await writeFile(join(root, "imports/velvet_walnut.jpg.xmp"),
  xmp(3, ["velvet-chair", "walnut"], "None"));
await writeFile(join(root, "imports/velvet_sage.jpg.xmp"),
  xmp(2, ["velvet-chair", "sage"], "None"));
console.log("xmp sidecars written");

const connect = async (bin, args, cwd) => {
  const t = new StdioClientTransport({ command: bin, args, cwd });
  const c = new Client({ name: "fixtures", version: "1" }, { capabilities: {} });
  await c.connect(t);
  return c;
};
const txt = (r) => { const b = r.content.find(x => x.type === "text"); try { return JSON.parse(b.text); } catch { return b.text; } };

// ---- DesignCraft template -------------------------------------------------
await mkdir(join(root, "templates"), { recursive: true });
const dc = await connect("designcraft-cli", ["mcp"], root);
console.log("new_document:", txt(await dc.callTool({ name: "new_document", arguments: { width: 1920, height: 1080, margins: 80, facingPages: false } })));
console.log("graphic frame:", txt(await dc.callTool({ name: "execute", arguments: { command: "frame.create", params: { spread: 0, rect: [80, 80, 1840, 720], content: "graphic" } } })));
const inspect = txt(await dc.callTool({ name: "inspect_document", arguments: {} }));
console.log("inspect keys:", Object.keys(inspect));
console.log("inspect sample:", JSON.stringify(inspect).slice(0, 700));
console.log("save:", txt(await dc.callTool({ name: "save_document", arguments: { path: "templates/hero_furniture.designcraft" } })));
await dc.close();

// ---- PdfCraft boilerplate -------------------------------------------------
await mkdir(join(root, "spec"), { recursive: true });
const pdf = await connect("pdfcraft-cli", ["mcp"], root);
const created = txt(await pdf.callTool({ name: "doc_create", arguments: { from: "blank", width: 595, height: 842, pages: 1, name: "Spec boilerplate" } }));
console.log("doc_create:", JSON.stringify(created));
const docId = created.document ?? created.doc ?? created.id ?? 1;
console.log("pdf docId:", docId);
for (const [i, name] of ["Product", "CTA", "Price"].entries()) {
  const r = await pdf.callTool({ name: "form_add_field", arguments: { doc: docId, page: 1, type: "text", name, rect: [72, 620 - i * 40, 400, 650 - i * 40] } });
  console.log("field", name, txt(r));
}
console.log("form_fields:", JSON.stringify(txt(await pdf.callTool({ name: "form_fields", arguments: { doc: docId } }))));
console.log("save:", txt(await pdf.callTool({ name: "doc_save", arguments: { doc: docId, path: "spec/FW26_spec_boilerplate.pdf" } })));
await pdf.close();
