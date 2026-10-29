/**
 * Acceptance harness for Chapter 5 Exercise 5.
 *
 * The deliverable is a capability design, so the harness checks the design's
 * invariants and emits the capability matrix, visibility table, handler policy
 * and a machine-readable report under ../output/.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { ErrorCodes, SCOPES } from './05_a-resource-and-prompt-aware-mcp-server-for-a-design-system-library-with-principle-of-least-privilege-access.js';

const HERE = import.meta.dirname;
const OUT = path.join(HERE, '..', 'output');
mkdirSync(OUT, { recursive: true });
for (const file of [
  'scopes.json',
  'capability-matrix.json',
  'visibility.json',
  'access-matrix.csv',
  'handler-policy.json',
  'report.json',
]) {
  rmSync(path.join(OUT, file), { force: true });
}

const agents = Object.keys(SCOPES);
const [copywriting, layout, color] = agents.map((a) => SCOPES[a]!);

let passed = 0;
let failed = 0;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

console.log('capability table\n');

check('three agents share one read root and never share a write root', () => {
  assert.deepEqual(agents, ['copywriting', 'layout', 'color']);
  const reads = new Set(agents.map((a) => SCOPES[a]!.roots.read));
  const writes = new Set(agents.map((a) => SCOPES[a]!.roots.write));
  assert.deepEqual([...reads], ['/work/design-system']);
  assert.equal(writes.size, 3);
});

check('copywriting sees one tool, no prompts, no templates', () => {
  assert.deepEqual(copywriting.tools, ['design.system.describe']);
  assert.deepEqual(copywriting.prompts, []);
  assert.deepEqual(copywriting.resources.templates, []);
});

check('layout is the only agent that can enumerate templates', () => {
  assert.deepEqual(layout.resources.templates, ['designsystem://templates/{templateName}']);
  assert.deepEqual(copywriting.resources.templates, []);
  assert.deepEqual(color.resources.templates, []);
});

check('resource prefixes do not overlap between agents', () => {
  const seen = new Map<string, string>();
  for (const agent of agents) {
    for (const prefix of SCOPES[agent]!.resources.uriPrefixes) {
      const owner = seen.get(prefix);
      assert.equal(owner, undefined, `${prefix} visible to both ${owner} and ${agent}`);
      seen.set(prefix, agent);
    }
  }
});

check('the color agent sees the composite contrast resource', () => {
  assert.ok(color.resources.uriPrefixes.includes('designsystem://tokens/contrast-pairs'));
  assert.ok(!copywriting.resources.uriPrefixes.some((p) => p.includes('contrast')));
});

check('prompt grants match the three-agent table', () => {
  assert.deepEqual(layout.prompts, ['layout:generate_grid', 'designsystem:apply_brand_kit']);
  assert.deepEqual(color.prompts, ['designsystem:apply_brand_kit']);
  assert.deepEqual(copywriting.prompts, []);
});

check('every granted tool is a design-system tool, never a raw engine id', () => {
  for (const agent of agents) {
    for (const tool of SCOPES[agent]!.tools) {
      assert.match(tool, /^design\.system\./, `${agent}: ${tool}`);
    }
  }
});

check('scopes carry a placeholder token, never key material', () => {
  for (const agent of agents) {
    assert.equal(SCOPES[agent]!.token, '<opaque>', agent);
  }
});

check('error codes are distinct and negative', () => {
  const codes = Object.values(ErrorCodes);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.ok(code < 0, String(code));
});

check('the anti-enumeration codes are the ones the spec reserves', () => {
  assert.equal(ErrorCodes.METHOD_NOT_FOUND, -32601);
  assert.equal(ErrorCodes.INVALID_PARAMS, -32602);
  assert.equal(ErrorCodes.CAPABILITY_DENIED, -32010);
  assert.equal(ErrorCodes.SESSION_DRAINING, -32013);
});

const KNOWN_RESOURCES = [
  'designsystem://tokens/type-scale',
  'designsystem://style-guide',
  'designsystem://tokens/spacing',
  'designsystem://tokens/colors',
  'designsystem://tokens/contrast-pairs',
  'designsystem://templates/{templateName}',
];

const KNOWN_TOOLS = [...new Set(agents.flatMap((a) => SCOPES[a]!.tools))].sort();
const KNOWN_PROMPTS = [...new Set(agents.flatMap((a) => SCOPES[a]!.prompts))].sort();

const resourceVisibleTo = (agent: string, uri: string): boolean => {
  const scope = SCOPES[agent]!;
  return scope.resources.uriPrefixes.some((prefix) => uri.startsWith(prefix))
    || scope.resources.templates.includes(uri);
};

const visibility = {
  resources: Object.fromEntries(
    KNOWN_RESOURCES.map((uri) => [uri, agents.filter((agent) => resourceVisibleTo(agent, uri))]),
  ),
  tools: Object.fromEntries(
    KNOWN_TOOLS.map((tool) => [tool, agents.filter((agent) => SCOPES[agent]!.tools.includes(tool))]),
  ),
  prompts: Object.fromEntries(
    KNOWN_PROMPTS.map((prompt) => [prompt, agents.filter((agent) => SCOPES[agent]!.prompts.includes(prompt))]),
  ),
};

check('the visibility matrix shows the shared read root without leaking grants', () => {
  assert.deepEqual(visibility.resources['designsystem://tokens/colors'], ['color']);
  assert.deepEqual(visibility.resources['designsystem://tokens/spacing'], ['layout']);
  assert.deepEqual(visibility.resources['designsystem://tokens/type-scale'], ['copywriting']);
  assert.deepEqual(visibility.resources['designsystem://tokens/contrast-pairs'], ['color']);
  assert.deepEqual(visibility.resources['designsystem://templates/{templateName}'], ['layout']);
  assert.deepEqual(visibility.tools['design.system.describe'], ['copywriting']);
  assert.deepEqual(visibility.prompts['layout:generate_grid'], ['layout']);
});

const handlerPolicy = {
  checkOrder: {
    listResources: ['load_scope', 'enumerate_permitted_prefixes', 'filter_server_side'],
    listResourceTemplates: ['load_scope', 'return_scope_templates_only'],
    readResource: [
      'parse_uri',
      'permission_check',
      'resolve_under_read_root',
      'recheck_symlinks',
      'read_or_derive',
    ],
    listTools: ['load_scope', 'filter_to_granted_tools'],
    callTool: [
      'tool_visibility',
      'schema_validation',
      'acquire_lease',
      'dispatch',
      'release_lease',
      'audit_log',
    ],
    listPrompts: ['load_scope', 'filter_to_granted_prompts'],
    getPrompt: ['prompt_visibility', 'argument_validation', 'render_messages_without_execution'],
  },
  antiEnumeration: {
    unknownOrUngranted: ErrorCodes.METHOD_NOT_FOUND,
    rule: 'unknown and ungranted names share one generic -32601 response',
    templatesAreScopeLocal: true,
  },
  compositeResources: {
    'designsystem://tokens/contrast-pairs': 'derived@wcag21',
  },
  writerDescriptions: 'every writing tool must state its side effect in the description',
  errorCodes: ErrorCodes,
};

check('handler policy keeps not-allowed indistinguishable from not-found', () => {
  assert.equal(handlerPolicy.antiEnumeration.unknownOrUngranted, -32601);
  assert.deepEqual(handlerPolicy.checkOrder.readResource.slice(0, 2), ['parse_uri', 'permission_check']);
  assert.equal(handlerPolicy.compositeResources['designsystem://tokens/contrast-pairs'], 'derived@wcag21');
});

const capabilityMatrix = {
  agents: Object.fromEntries(
    agents.map((agent) => {
      const scope = SCOPES[agent]!;
      return [agent, {
        agentId: scope.agentId,
        readRoot: scope.roots.read,
        writeRoot: scope.roots.write,
        resources: scope.resources.uriPrefixes,
        templates: scope.resources.templates,
        tools: scope.tools,
        prompts: scope.prompts,
      }];
    }),
  ),
  counts: Object.fromEntries(
    agents.map((agent) => [agent, {
      resources: SCOPES[agent]!.resources.uriPrefixes.length,
      templates: SCOPES[agent]!.resources.templates.length,
      tools: SCOPES[agent]!.tools.length,
      prompts: SCOPES[agent]!.prompts.length,
    }]),
  ),
  knownResources: KNOWN_RESOURCES,
  knownTools: KNOWN_TOOLS,
  knownPrompts: KNOWN_PROMPTS,
};

const csvEscape = (value: unknown): string => `"${String(value).replaceAll('"', '""')}"`;
const csv = [
  'agent,read_root,write_root,resource_prefixes,templates,tools,prompts',
  ...agents.map((agent) => {
    const scope = SCOPES[agent]!;
    return [
      agent,
      scope.roots.read,
      scope.roots.write,
      scope.resources.uriPrefixes.join('|'),
      scope.resources.templates.join('|'),
      scope.tools.join('|'),
      scope.prompts.join('|'),
    ].map(csvEscape).join(',');
  }),
  '',
].join('\n');

writeFileSync(path.join(OUT, 'scopes.json'), JSON.stringify(SCOPES, null, 2) + '\n');
writeFileSync(path.join(OUT, 'capability-matrix.json'), JSON.stringify(capabilityMatrix, null, 2) + '\n');
writeFileSync(path.join(OUT, 'visibility.json'), JSON.stringify(visibility, null, 2) + '\n');
writeFileSync(path.join(OUT, 'handler-policy.json'), JSON.stringify(handlerPolicy, null, 2) + '\n');
writeFileSync(path.join(OUT, 'access-matrix.csv'), csv);

check('capability matrix and access artefacts were written', () => {
  assert.equal(Object.keys(capabilityMatrix.agents).length, 3);
  assert.equal(capabilityMatrix.knownResources.length, 6);
  assert.match(csv, /^agent,read_root,write_root/m);
  assert.equal(csv.trim().split('\n').length, 4);
});

const report = {
  exercise: 5,
  checks: passed + failed,
  passed,
  failed,
  results,
  agents: agents.map((agent) => ({
    agent,
    readRoot: SCOPES[agent]!.roots.read,
    writeRoot: SCOPES[agent]!.roots.write,
    resources: SCOPES[agent]!.resources.uriPrefixes.length,
    templates: SCOPES[agent]!.resources.templates.length,
    tools: SCOPES[agent]!.tools.length,
    prompts: SCOPES[agent]!.prompts.length,
  })),
  errorCodes: ErrorCodes,
  artifacts: [
    'scopes.json',
    'capability-matrix.json',
    'visibility.json',
    'handler-policy.json',
    'access-matrix.csv',
    'report.json',
  ],
};
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
