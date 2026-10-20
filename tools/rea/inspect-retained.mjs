import { readFile } from 'node:fs/promises';
const path = process.argv[2];
if (!path) throw new Error('Pass a specific retained artifact path.');
const text = await readFile(path, 'utf8');
try {
  const value = JSON.parse(text);
  const n = value.normalized_result;
  console.log(JSON.stringify(n ? {
    keys: Object.keys(value), evidence_id: value.evidence_id, subject: value.subject,
    normalizedKeys: Object.keys(n),
    metadata: Object.fromEntries(Object.entries(n).filter(([key]) => !/graph|manifest/.test(key))),
    graphKeys: n.graph && Object.keys(n.graph),
    graphNodes: n.graph?.nodes?.length, graphEdges: n.graph?.edges?.length,
    semanticGraphKeys: n.semantic_graph && Object.keys(n.semantic_graph),
  } : { keys: Object.keys(value), preview: JSON.stringify(value).slice(0, 5000) }, null, 2));
} catch {
  console.log(JSON.stringify({ bytes: Buffer.byteLength(text), head: text.slice(0, 1800), tail: text.slice(-2200) }, null, 2));
}
