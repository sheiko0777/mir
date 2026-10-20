import { readFile, writeFile } from 'node:fs/promises';
const folder = new URL('../../outputs/REA-Uniswap-V2/', import.meta.url);
const evidence = JSON.parse(await readFile(new URL('rea-evidence.json', folder), 'utf8'));
const n = evidence.normalized_result;
if (!evidence.evidence_id || !n?.graph || !n.semantic_graph) throw new Error('Unexpected Evidence schema');
const summary = {
  evidence_id: evidence.evidence_id, subject: evidence.subject,
  operation: evidence.operation, provider: evidence.provider,
  confidence: evidence.confidence, authority: evidence.authority,
  statistics: n.statistics, integrity_contradictions: n.integrity_contradictions,
  application_graph: { id: n.graph.graph_id, nodes: n.graph.nodes.length, edges: n.graph.edges.length, coverage: n.graph.coverage, limitations: n.graph.limitations },
  semantic_graph: { id: n.semantic_graph.graph_id, nodes: n.semantic_graph.nodes.length, relations: n.semantic_graph.relations.length, unknowns: n.semantic_graph.unknowns.length, coverage: n.semantic_graph.coverage, limitations: n.semantic_graph.limitations },
  limitations: evidence.limitations, normalized_limitations: n.limitations,
  relationship_coverage: evidence.relationship_coverage,
  completeEvidence: 'rea-evidence.json',
  note: 'Derived summary only; original complete Evidence retained separately. Findings are observations, not a vulnerability count.',
};
await writeFile(new URL('rea-summary.json', folder), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ evidence_id: summary.evidence_id, output: 'outputs/REA-Uniswap-V2/rea-summary.json', applicationCoverage: summary.application_graph.coverage.status, semanticCoverage: summary.semantic_graph.coverage.status, unknowns: summary.semantic_graph.unknowns }));
